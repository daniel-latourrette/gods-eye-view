import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimetable,
  localClock,
  parseCsv,
  parseGtfsTime,
  scheduledVehicles,
  serviceRuns,
} from './gtfsSchedule.js';
import { readZipEntries } from './zipEntries.js';
import { buildScheduleSnapshot, parseScheduleFeed } from './transitProxy.js';
import { createTransitService } from '../sources/transitService.js';
import { findGtfsZipLink } from './gtfsDiscovery.js';

// Two stations 1.11 km apart due north; trip T1 leaves S1 at 08:00:00, dwells
// at S2 08:10–08:11, arrives S3 08:20. Trip N1 runs past midnight (24:30).
const GTFS = {
  'agency.txt':
    '﻿agency_id,agency_name,agency_url,agency_timezone\n,Test,https://x,Europe/Lisbon\n',
  'routes.txt': 'route_id,route_short_name,route_type\nA,A,1\n',
  'stops.txt':
    'stop_id,stop_name,stop_lat,stop_lon\nS1,"One, first",41.10,-8.60\nS2,Two,41.11,-8.60\nS3,Three,41.12,-8.60\n',
  'calendar.txt':
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWD,1,1,1,1,1,0,0,20260901,20261031\n',
  'calendar_dates.txt':
    'service_id,date,exception_type\nWD,20260922,2\nWD,20260926,1\n',
  'trips.txt':
    'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\r\nA,WD,T1,North,0,SH\r\nA,WD,N1,Night,0,SH\r\n',
  'stop_times.txt': [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'T1,8:00:00,8:00:00,S1,1',
    'T1,8:10:00,8:11:00,S2,2',
    'T1,8:20:00,8:20:00,S3,3',
    'N1,24:20:00,24:20:00,S1,1',
    'N1,24:40:00,24:40:00,S3,2',
  ].join('\n'),
  'shapes.txt':
    'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nSH,41.10,-8.60,1\nSH,41.12,-8.60,2\n',
};

// Lisbon is UTC+1 in September.
const lisbon = (iso) => Date.parse(`${iso}+01:00`);

test('CSV parsing handles BOM, quotes, commas and CRLF', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n'), [
    { a: 'x, y', b: 'say "hi"' },
  ]);
  assert.deepEqual(parseCsv(''), []);
});

test('GTFS times allow hours past 24', () => {
  assert.equal(parseGtfsTime('8:05:30'), 8 * 3600 + 330);
  assert.equal(parseGtfsTime('25:00:00'), 25 * 3600);
  assert.equal(parseGtfsTime('bad'), null);
});

test('local clock uses the agency timezone', () => {
  const clock = localClock(lisbon('2026-09-21T08:05:00'), 'Europe/Lisbon');
  assert.equal(clock.date, '20260921');
  assert.equal(clock.weekday, 0);
  assert.equal(clock.seconds, 8 * 3600 + 300);
});

test('calendar exceptions override the weekly pattern', () => {
  const tt = buildTimetable(GTFS);
  assert.equal(serviceRuns(tt, 'WD', '20260921', 0), true);
  assert.equal(serviceRuns(tt, 'WD', '20260922', 1), false, 'removed');
  assert.equal(serviceRuns(tt, 'WD', '20260926', 5), true, 'added Saturday');
  assert.equal(serviceRuns(tt, 'WD', '20260927', 6), false);
  assert.equal(serviceRuns(tt, 'WD', '20261102', 0), false, 'past end_date');
});

test('a running trip is interpolated along its shape between stops', () => {
  const tt = buildTimetable(GTFS);
  const [mid] = scheduledVehicles(tt, lisbon('2026-09-21T08:05:00'));
  assert.equal(mid.id, 'T1');
  assert.equal(mid.routeId, 'A');
  assert.equal(mid.label, 'North');
  assert.equal(mid.stopId, 'S2');
  assert.ok(Math.abs(mid.lat - 41.105) < 1e-4, `lat ${mid.lat}`);
  assert.ok(Math.abs(mid.lon + 8.6) < 1e-6);
  assert.ok(mid.bearing < 1 || mid.bearing > 359, 'heading north');
  assert.equal(mid.timestamp, null);
});

test('a dwelling trip sits at its station; outside its times it is absent', () => {
  const tt = buildTimetable(GTFS);
  const [dwell] = scheduledVehicles(tt, lisbon('2026-09-21T08:10:30'));
  assert.ok(Math.abs(dwell.lat - 41.11) < 1e-4);
  assert.deepEqual(scheduledVehicles(tt, lisbon('2026-09-21T07:59:00')), []);
  assert.deepEqual(scheduledVehicles(tt, lisbon('2026-09-21T08:21:00')), []);
  assert.deepEqual(
    scheduledVehicles(tt, lisbon('2026-09-22T08:05:00')),
    [],
    'service removed that day',
  );
});

test('trips past midnight belong to the previous service day', () => {
  const tt = buildTimetable(GTFS);
  // Monday's N1 runs at 00:30 on Tuesday.
  const tuesday = scheduledVehicles(tt, lisbon('2026-09-22T00:30:00'));
  assert.deepEqual(
    tuesday.map((v) => v.id),
    ['N1'],
  );
  // Sunday's service does not run, so nothing at 00:30 on Monday.
  assert.deepEqual(scheduledVehicles(tt, lisbon('2026-09-21T00:30:00')), []);
});

async function deflateRaw(bytes) {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Minimal ZIP writer for tests: deflate every entry except `stored`. */
async function makeZip(files, stored = new Set()) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = enc.encode(text);
    const method = stored.has(name) ? 0 : 8;
    const data = method === 0 ? raw : await deflateRaw(raw);
    const nameBytes = enc.encode(`gtfs/${name}`);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, method, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(10, method, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, raw.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    const localPart = [new Uint8Array(local.buffer), nameBytes, data];
    locals.push(...localPart);
    centrals.push(new Uint8Array(central.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, Object.keys(files).length, true);
  eocd.setUint16(10, Object.keys(files).length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);
  return new Uint8Array(
    await new Blob([
      ...locals,
      ...centrals,
      new Uint8Array(eocd.buffer),
    ]).arrayBuffer(),
  );
}

test('zip reader extracts stored and deflated entries by base name', async () => {
  const zip = await makeZip(
    { 'a.txt': 'hello', 'b.txt': 'x'.repeat(5000), 'c.txt': 'skip' },
    new Set(['a.txt']),
  );
  const entries = await readZipEntries(zip, ['a.txt', 'b.txt', 'missing.txt']);
  const dec = new TextDecoder();
  assert.equal(dec.decode(entries.get('a.txt')), 'hello');
  assert.equal(dec.decode(entries.get('b.txt')).length, 5000);
  assert.equal(entries.has('c.txt'), false);
  await assert.rejects(
    readZipEntries(new Uint8Array(40), ['a.txt']),
    /not a zip/,
  );
  await assert.rejects(
    readZipEntries(zip, ['b.txt'], { maxEntryBytes: 100 }),
    /too large/,
  );
});

test('a GTFS zip becomes an estimated snapshot with feed-time stamps', async () => {
  const tt = await parseScheduleFeed(await makeZip(GTFS));
  const now = lisbon('2026-09-21T08:05:00');
  const snapshot = buildScheduleSnapshot(
    { id: 'metro-porto', name: 'Metro' },
    tt,
    now,
  );
  assert.equal(snapshot.estimated, true);
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.vehicles[0].timestampSource, 'header');
  assert.equal(snapshot.vehicles[0].timestamp, Math.floor(now / 1000));
  await assert.rejects(
    parseScheduleFeed(await makeZip({ 'stops.txt': GTFS['stops.txt'] })),
    /lacks/,
  );
});

const PAGE = 'https://www.metrodoporto.pt/pages/337';
const pageHtml = (href) =>
  `<ul><li><a href="/metrodoporto/uploads/document/file/807/horarios.pdf">Horários</a></li>` +
  `<li><a href="${href}"><span>GTFS Horários</span> (para aplicações)</a></li></ul>`;

function scheduleService(t, routes) {
  const calls = [];
  const service = createTransitService({
    fetchImpl: async (url) => {
      calls.push(url);
      const route = routes[url];
      if (!route) return new Response('missing', { status: 404 });
      if (route instanceof Error) throw route;
      return route();
    },
  });
  t.after(service.close);
  const get = async () => {
    const response = await service.handle({
      url: 'https://example.test/api/transit/vehicles/metro-porto',
      method: 'GET',
    });
    return { status: response.status, body: await response.json() };
  };
  return { calls, get };
}

test('the timetable zip is found on the operator page', async (t) => {
  t.mock.method(console, 'log', () => {});
  const zip = await makeZip(GTFS);
  const newer =
    'https://www.metrodoporto.pt/metrodoporto/uploads/document/file/900/google_transit_01_11_2026.zip';
  const { calls, get } = scheduleService(t, {
    [PAGE]: () =>
      new Response(
        pageHtml(
          '/metrodoporto/uploads/document/file/900/google_transit_01_11_2026.zip',
        ),
      ),
    [newer]: () => new Response(zip),
  });
  const { status, body } = await get();
  assert.equal(status, 200);
  assert.equal(body.estimated, true);
  assert.equal(body.version, 'google_transit_01_11_2026.zip');
  assert.deepEqual(calls, [PAGE, newer]);
});

test('an unreadable page or a page without the link falls back to the registered zip', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const zip = await makeZip(GTFS);
  const { getTransitFeed } = await import('./transitFeeds.js');
  const registered = getTransitFeed('metro-porto').url;
  for (const page of [
    () => new Response('down', { status: 503 }),
    () => new Response('<a href="/x.pdf">Horários</a>'),
    () => new Response(pageHtml('https://evil.example/google_transit.zip')),
  ]) {
    const { calls, get } = scheduleService(t, {
      [PAGE]: page,
      [registered]: () => new Response(zip),
    });
    const { status, body } = await get();
    assert.equal(status, 200);
    assert.equal(body.version, registered.split('/').pop());
    assert.deepEqual(calls, [PAGE, registered]);
  }
});

test('no timetable at all is an upstream error, not an empty map', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { get } = scheduleService(t, {});
  const { status } = await get();
  assert.ok(status >= 500, `status ${status}`);
});

test('GTFS link discovery stays on the page origin and matches the link text', () => {
  const page = 'https://www.metrodoporto.pt/pages/337';
  assert.equal(
    findGtfsZipLink(
      '<a href="/metrodoporto/uploads/document/file/794/google_transit_04_09_2026.zip">GTFS Horários&nbsp; (para aplicações)</a>',
      page,
      /GTFS/i,
    ),
    'https://www.metrodoporto.pt/metrodoporto/uploads/document/file/794/google_transit_04_09_2026.zip',
  );
  assert.equal(
    findGtfsZipLink(
      '<a href="https://evil.example/gtfs.zip">GTFS</a><a href="/a/b.pdf">GTFS</a>',
      page,
      /GTFS/i,
    ),
    null,
  );
  assert.equal(
    findGtfsZipLink('<a href="/x/relatorio.zip">Relatório</a>', page, /GTFS/i),
    null,
  );
  assert.equal(
    findGtfsZipLink(
      "<a class='d' href='/f/gtfs_2027.zip'>Download</a>",
      page,
      /GTFS/i,
    ),
    'https://www.metrodoporto.pt/f/gtfs_2027.zip',
    'file name can carry the match',
  );
  assert.equal(
    findGtfsZipLink(
      '<a href="/f/gtfs.zip">GTFS</a>',
      'http://www.metrodoporto.pt/p',
      /GTFS/i,
    ),
    null,
    'plain-http pages are refused',
  );
});
