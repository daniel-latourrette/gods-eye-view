import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeNgsiVehicles,
  normalizeNgsiVehicle,
  parseNgsiAnnotations,
} from './ngsiVehicles.js';
import {
  buildTransitSnapshot,
  transitUpstreamHeaders,
} from './transitProxy.js';
import { getTransitFeed } from './transitFeeds.js';

const stcpBus = (overrides = {}) => ({
  id: 'urn:ngsi-ld:Vehicle:porto:stcp:bus:3555',
  type: 'Vehicle',
  annotations: [
    'stcp:route:12M',
    'stcp:nr_turno:na',
    'stcp:nr_viagem:12M_0_2|305|D1|T1|N2',
    'stcp:sentido:1',
  ],
  bearing: 121,
  fleetVehicleId: '3555',
  location: { type: 'Point', coordinates: [-8.61595, 41.12415] },
  name: 'STCP 12M 3555',
  observationDateTime: '2026-09-16T23:33:59.00Z',
  speed: 36,
  vehicleType: 'bus',
  ...overrides,
});

const bytesOf = (value) => new TextEncoder().encode(JSON.stringify(value));

test('annotations parse into a key map, skipping na and other prefixes', () => {
  assert.deepEqual(
    parseNgsiAnnotations(
      ['stcp:route:12M', 'stcp:nr_turno:na', 'other:route:X', 'stcp:bad', 42],
      'stcp',
    ),
    { route: '12M' },
  );
  assert.deepEqual(parseNgsiAnnotations(null, 'stcp'), {});
});

test('an STCP Vehicle entity becomes a Transit layer record', () => {
  assert.deepEqual(
    normalizeNgsiVehicle(stcpBus(), { annotationPrefix: 'stcp' }),
    {
      id: '3555',
      lat: 41.12415,
      lon: -8.61595,
      bearing: 121,
      speedMps: 10,
      timestamp: Date.parse('2026-09-16T23:33:59Z') / 1000,
      routeId: '12M',
      tripId: '12M_0_2|305|D1|T1|N2',
      directionId: 1,
      label: '3555',
      stopId: null,
      status: null,
      occupancy: null,
    },
  );
});

test('entities without a usable position or identity are dropped', () => {
  const opts = { annotationPrefix: 'stcp' };
  assert.equal(normalizeNgsiVehicle(stcpBus({ location: null }), opts), null);
  assert.equal(
    normalizeNgsiVehicle(
      stcpBus({ location: { type: 'Point', coordinates: [0, 0] } }),
      opts,
    ),
    null,
  );
  assert.equal(
    normalizeNgsiVehicle(
      stcpBus({ location: { type: 'Point', coordinates: ['-8.6', '41.1'] } }),
      opts,
    ),
    null,
  );
  assert.equal(
    normalizeNgsiVehicle(stcpBus({ id: '', fleetVehicleId: '' }), opts),
    null,
  );
  assert.equal(normalizeNgsiVehicle(null, opts), null);
});

test('decoder keeps the newest duplicate and reports the newest time', () => {
  const older = stcpBus({ observationDateTime: '2026-09-16T23:30:00Z' });
  const newer = stcpBus({
    observationDateTime: '2026-09-16T23:31:00Z',
    location: { type: 'Point', coordinates: [-8.6, 41.13] },
  });
  const decoded = decodeNgsiVehicles(bytesOf([older, newer, { junk: true }]), {
    annotationPrefix: 'stcp',
  });
  assert.equal(decoded.entityCount, 3);
  assert.equal(decoded.vehicles.length, 1);
  assert.equal(decoded.vehicles[0].lat, 41.13);
  assert.equal(decoded.timestamp, Date.parse('2026-09-16T23:31:00Z') / 1000);
  assert.equal(decoded.truncated, false);
});

test('decoder refuses a non-array or non-JSON body', () => {
  assert.throws(() => decodeNgsiVehicles(bytesOf({ error: 'x' })), /array/);
  assert.throws(
    () => decodeNgsiVehicles(new TextEncoder().encode('<html>')),
    /JSON/,
  );
});

test('the STCP feed is served through the NGSI decoder with a JSON Accept header', () => {
  const feed = getTransitFeed('stcp-porto');
  assert.ok(feed, 'stcp-porto is enabled');
  assert.equal(feed.format, 'ngsi-v2-vehicles');
  assert.match(transitUpstreamHeaders(feed).Accept, /^application\/json$/);
  assert.match(
    transitUpstreamHeaders(getTransitFeed('mbta')).Accept,
    /x-protobuf/,
  );
  const snapshot = buildTransitSnapshot(feed, bytesOf([stcpBus()]), 1_000_000);
  assert.equal(snapshot.feedId, 'stcp-porto');
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.vehicles[0].routeId, '12M');
  assert.equal(snapshot.vehicles[0].timestampSource, 'vehicle');
});
