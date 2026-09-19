/**
 * @module gtfsSchedule
 * @description Timetable-estimated vehicle positions from a static GTFS feed.
 *
 * For operators that publish a static GTFS but no live positions (Metro do
 * Porto), this places every trip that is scheduled to be running at a given
 * instant: between its previous and next stop, along the route shape, in
 * proportion to the scheduled time elapsed. These are ESTIMATES — delays,
 * cancellations and short-turns are invisible — and the feed entry that uses
 * this format says so wherever a vehicle is shown.
 *
 * Output matches the Transit snapshot vehicle shape, so the proxy and the
 * layer need no special path beyond the feed `format`.
 *
 * Pure: no Node built-ins, no Cesium.
 */

import { isPlausibleVehiclePosition } from './gtfsRealtime.js';

/** GTFS files this module reads. */
export const GTFS_SCHEDULE_FILES = Object.freeze([
  'agency.txt',
  'routes.txt',
  'trips.txt',
  'stop_times.txt',
  'stops.txt',
  'calendar.txt',
  'calendar_dates.txt',
  'shapes.txt',
]);

const M_PER_DEG_LAT = 111320;
const DAY_S = 86400;

/**
 * Parse RFC 4180 CSV (quotes, doubled quotes, CRLF, BOM) into objects keyed by
 * the header row.
 * @param {string} text
 * @returns {Array<Record<string, string>>}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((values) => {
    const record = {};
    header.forEach((key, i) => {
      record[key] = (values[i] ?? '').trim();
    });
    return record;
  });
}

/**
 * GTFS time (`H:MM:SS`, may exceed 24:00:00) → seconds after service-day start.
 * @param {string} value
 * @returns {number|null}
 */
export function parseGtfsTime(value) {
  const match = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function toLocalXY(lon, lat, lat0) {
  return [
    lon * M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180),
    lat * M_PER_DEG_LAT,
  ];
}

function buildPolyline(points, lat0) {
  const xy = points.map(([lon, lat]) => toLocalXY(lon, lat, lat0));
  const cum = [0];
  for (let i = 1; i < xy.length; i++) {
    cum.push(
      cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]),
    );
  }
  return { points, xy, cum, length: cum[cum.length - 1] };
}

/** Distance along a polyline of the point nearest to (x, y), at or after `fromDist`. */
function projectAlong(line, x, y, fromDist) {
  let best = { d2: Infinity, dist: fromDist };
  for (let i = 0; i < line.xy.length - 1; i++) {
    if (line.cum[i + 1] < fromDist) continue;
    const [ax, ay] = line.xy[i];
    const [bx, by] = line.xy[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dist = Math.max(fromDist, line.cum[i] + t * Math.sqrt(len2));
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    const d2 = (x - qx) ** 2 + (y - qy) ** 2;
    if (d2 < best.d2) best = { d2, dist };
  }
  return best.dist;
}

/** Point and bearing (degrees) at a distance along a polyline. */
function pointAt(line, dist) {
  const d = Math.max(0, Math.min(line.length, dist));
  let i = 0;
  while (i < line.cum.length - 2 && line.cum[i + 1] < d) i++;
  const span = line.cum[i + 1] - line.cum[i];
  const t = span > 0 ? (d - line.cum[i]) / span : 0;
  const [alon, alat] = line.points[i];
  const [blon, blat] = line.points[i + 1];
  const [ax, ay] = line.xy[i];
  const [bx, by] = line.xy[i + 1];
  const bearing =
    span > 0
      ? ((((Math.atan2(bx - ax, by - ay) * 180) / Math.PI) % 360) + 360) % 360
      : null;
  return {
    lon: alon + t * (blon - alon),
    lat: alat + t * (blat - alat),
    bearing,
  };
}

/**
 * Build a compact timetable from GTFS file texts.
 * @param {Record<string, string>} files Base name → file text.
 * @returns {object} Timetable consumed by `scheduledVehicles`.
 */
export function buildTimetable(files) {
  const read = (name) => (files[name] ? parseCsv(files[name]) : []);
  const timezone = read('agency.txt')[0]?.agency_timezone || 'UTC';

  const routes = new Map();
  for (const r of read('routes.txt')) {
    routes.set(r.route_id, r.route_short_name || r.route_id);
  }

  const stops = new Map();
  for (const s of read('stops.txt')) {
    const lat = Number(s.stop_lat);
    const lon = Number(s.stop_lon);
    if (isPlausibleVehiclePosition(lat, lon)) stops.set(s.stop_id, [lon, lat]);
  }

  const calendar = new Map();
  for (const c of read('calendar.txt')) {
    calendar.set(c.service_id, {
      days: [
        c.monday,
        c.tuesday,
        c.wednesday,
        c.thursday,
        c.friday,
        c.saturday,
        c.sunday,
      ].map((v) => v === '1'),
      start: c.start_date,
      end: c.end_date,
    });
  }
  const exceptions = new Map();
  for (const e of read('calendar_dates.txt')) {
    if (!exceptions.has(e.service_id)) exceptions.set(e.service_id, new Map());
    exceptions.get(e.service_id).set(e.date, e.exception_type);
  }

  let lat0 = 0;
  for (const [, lat] of stops.values()) {
    lat0 = lat;
    break;
  }

  const shapePoints = new Map();
  for (const p of read('shapes.txt')) {
    const lat = Number(p.shape_pt_lat);
    const lon = Number(p.shape_pt_lon);
    const seq = Number(p.shape_pt_sequence);
    if (!isPlausibleVehiclePosition(lat, lon) || !Number.isFinite(seq))
      continue;
    if (!shapePoints.has(p.shape_id)) shapePoints.set(p.shape_id, []);
    shapePoints.get(p.shape_id).push({ seq, lon, lat });
  }
  const shapes = new Map();
  for (const [id, pts] of shapePoints) {
    pts.sort((a, b) => a.seq - b.seq);
    if (pts.length >= 2)
      shapes.set(
        id,
        buildPolyline(
          pts.map((p) => [p.lon, p.lat]),
          lat0,
        ),
      );
  }

  const tripStops = new Map();
  for (const st of read('stop_times.txt')) {
    const arr = parseGtfsTime(st.arrival_time);
    const dep = parseGtfsTime(st.departure_time);
    const seq = Number(st.stop_sequence);
    if ((arr === null && dep === null) || !stops.has(st.stop_id)) continue;
    if (!tripStops.has(st.trip_id)) tripStops.set(st.trip_id, []);
    tripStops.get(st.trip_id).push({
      seq,
      arr: arr ?? dep,
      dep: dep ?? arr,
      stop: st.stop_id,
    });
  }

  const lineCache = new Map();
  const trips = [];
  for (const t of read('trips.txt')) {
    const times = tripStops.get(t.trip_id);
    if (!times || times.length < 2) continue;
    if (!calendar.has(t.service_id) && !exceptions.has(t.service_id)) continue;
    times.sort((a, b) => a.seq - b.seq);
    const stopKey = `${t.shape_id}|${times.map((x) => x.stop).join(',')}`;
    let placed = lineCache.get(stopKey);
    if (!placed) {
      const line =
        shapes.get(t.shape_id) ||
        buildPolyline(
          times.map((x) => stops.get(x.stop)),
          lat0,
        );
      let from = 0;
      const dists = times.map((x) => {
        const [lon, lat] = stops.get(x.stop);
        const [sx, sy] = toLocalXY(lon, lat, lat0);
        from = projectAlong(line, sx, sy, from);
        return from;
      });
      placed = { line, dists };
      lineCache.set(stopKey, placed);
    }
    trips.push({
      id: t.trip_id,
      route: routes.get(t.route_id) || t.route_id,
      service: t.service_id,
      headsign: t.trip_headsign || null,
      direction: t.direction_id === '' ? null : Number(t.direction_id),
      times,
      line: placed.line,
      dists: placed.dists,
      start: times[0].dep,
      end: times[times.length - 1].arr,
    });
  }

  return { timezone, calendar, exceptions, trips };
}

/** Local calendar date (YYYYMMDD), weekday (0 = Monday) and seconds of day. */
export function localClock(nowMs, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(nowMs))
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}${parts.month}${parts.day}`;
  const utcNoon = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    12,
  );
  return {
    date,
    weekday: (new Date(utcNoon).getUTCDay() + 6) % 7,
    seconds:
      Number(parts.hour) * 3600 +
      Number(parts.minute) * 60 +
      Number(parts.second),
    utcNoon,
  };
}

function shiftDate(utcNoon, days) {
  const d = new Date(utcNoon + days * DAY_S * 1000);
  const date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return { date, weekday: (d.getUTCDay() + 6) % 7 };
}

/** Whether a service runs on a service date. */
export function serviceRuns(timetable, serviceId, date, weekday) {
  const exception = timetable.exceptions.get(serviceId)?.get(date);
  if (exception === '1') return true;
  if (exception === '2') return false;
  const cal = timetable.calendar.get(serviceId);
  if (!cal) return false;
  return cal.days[weekday] && date >= cal.start && date <= cal.end;
}

/**
 * Every trip scheduled to be on the line at `nowMs`, placed along its shape.
 * Trips from the previous service day are included while they run past
 * midnight (GTFS times above 24:00:00).
 *
 * @param {object} timetable From `buildTimetable`.
 * @param {number} nowMs
 * @returns {object[]} Transit snapshot vehicle records (no timestamp: the
 *   snapshot's own time applies to every estimate).
 */
export function scheduledVehicles(timetable, nowMs) {
  const clock = localClock(nowMs, timetable.timezone);
  const days = [
    { date: clock.date, weekday: clock.weekday, s: clock.seconds },
    { ...shiftDate(clock.utcNoon, -1), s: clock.seconds + DAY_S },
  ];
  const vehicles = [];
  for (const day of days) {
    for (const trip of timetable.trips) {
      if (day.s < trip.start || day.s > trip.end) continue;
      if (!serviceRuns(timetable, trip.service, day.date, day.weekday))
        continue;
      const times = trip.times;
      let dist = null;
      let nextStop = null;
      for (let i = 0; i < times.length; i++) {
        if (day.s <= times[i].arr) {
          if (i === 0) dist = trip.dists[0];
          else {
            const prev = times[i - 1];
            if (day.s <= prev.dep) dist = trip.dists[i - 1];
            else {
              const span = times[i].arr - prev.dep;
              const f = span > 0 ? (day.s - prev.dep) / span : 1;
              dist =
                trip.dists[i - 1] + f * (trip.dists[i] - trip.dists[i - 1]);
            }
          }
          nextStop = times[i].stop;
          break;
        }
        if (day.s <= times[i].dep) {
          dist = trip.dists[i];
          nextStop = times[i + 1]?.stop ?? times[i].stop;
          break;
        }
      }
      if (dist === null) continue;
      const at = pointAt(trip.line, dist);
      if (!isPlausibleVehiclePosition(at.lat, at.lon)) continue;
      vehicles.push({
        id: trip.id,
        lat: Number(at.lat.toFixed(6)),
        lon: Number(at.lon.toFixed(6)),
        bearing: at.bearing,
        speedMps: null,
        timestamp: null,
        routeId: trip.route,
        tripId: trip.id,
        directionId: Number.isInteger(trip.direction) ? trip.direction : null,
        label: trip.headsign,
        stopId: nextStop,
        status: null,
        occupancy: null,
      });
    }
  }
  return vehicles;
}
