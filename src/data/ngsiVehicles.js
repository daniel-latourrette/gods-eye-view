/**
 * @module ngsiVehicles
 * @description Decoder for FIWARE NGSI v2 `Vehicle` entity lists
 * (`/v2/entities?type=Vehicle&options=keyValues`), the shape Porto Digital's
 * Urban Platform context broker publishes live STCP bus positions in.
 *
 * Output matches `decodeVehiclePositions` in gtfsRealtime.js, so the Transit
 * proxy serves the same snapshot whatever the upstream format. An NGSI entity
 * list is always the complete current state (vehicles that stop reporting
 * drop out), which is the GTFS-RT FULL_DATASET semantics.
 *
 * Pure: imported by the proxy and node:test. No Cesium, no Node built-ins.
 */

import {
  GTFS_INCREMENTALITY_FULL_DATASET,
  GTFS_MAX_ENTITIES,
  GTFS_MAX_STRING_CHARS,
  isPlausibleVehiclePosition,
} from './gtfsRealtime.js';

function shortString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > GTFS_MAX_STRING_CHARS) return null;
  return trimmed;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Read `<prefix>:<key>:<value>` annotations (STCP publishes route, trip and
 * direction this way) into a plain map keyed by `<key>`.
 * @param {unknown} annotations
 * @param {string} prefix e.g. 'stcp'
 * @returns {Record<string, string>}
 */
export function parseNgsiAnnotations(annotations, prefix) {
  const out = {};
  if (!Array.isArray(annotations) || !prefix) return out;
  const head = `${prefix}:`;
  for (const raw of annotations) {
    const text = shortString(raw);
    if (!text || !text.startsWith(head)) continue;
    const rest = text.slice(head.length);
    const colon = rest.indexOf(':');
    if (colon <= 0) continue;
    const value = rest.slice(colon + 1).trim();
    if (value && value !== 'na') out[rest.slice(0, colon)] = value;
  }
  return out;
}

/**
 * Flatten one keyValues Vehicle entity into a Transit layer record, or null
 * when it carries no usable position or identity.
 * @param {object} entity
 * @param {{annotationPrefix?: string}} [options]
 * @returns {object|null}
 */
export function normalizeNgsiVehicle(entity, { annotationPrefix = '' } = {}) {
  if (!entity || typeof entity !== 'object') return null;
  const coordinates = entity.location?.coordinates;
  if (entity.location?.type !== 'Point' || !Array.isArray(coordinates))
    return null;
  const lon = finiteNumber(coordinates[0]);
  const lat = finiteNumber(coordinates[1]);
  if (!isPlausibleVehiclePosition(lat, lon)) return null;
  const id = shortString(entity.fleetVehicleId) || shortString(entity.id);
  if (!id) return null;
  const bearingRaw =
    finiteNumber(entity.bearing) ?? finiteNumber(entity.heading);
  const speedKmh = finiteNumber(entity.speed);
  const observedMs = Date.parse(shortString(entity.observationDateTime) || '');
  const notes = parseNgsiAnnotations(entity.annotations, annotationPrefix);
  const direction = Number.parseInt(notes.sentido ?? '', 10);
  return {
    id,
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    bearing: bearingRaw === null ? null : ((bearingRaw % 360) + 360) % 360,
    // FIWARE Smart Data Models give Vehicle.speed in km/h.
    speedMps: speedKmh === null || speedKmh < 0 ? null : speedKmh / 3.6,
    timestamp:
      Number.isFinite(observedMs) && observedMs > 0
        ? Math.floor(observedMs / 1000)
        : null,
    routeId: shortString(notes.route),
    tripId: shortString(notes.nr_viagem),
    directionId: Number.isInteger(direction) ? direction : null,
    label: shortString(entity.fleetVehicleId),
    stopId: null,
    status: null,
    occupancy: null,
  };
}

/**
 * Decode an NGSI v2 keyValues entity array into the snapshot shape of
 * `decodeVehiclePositions`.
 * @param {Uint8Array|ArrayBuffer} bytes UTF-8 JSON body.
 * @param {{annotationPrefix?: string}} [options]
 * @returns {{ version: null, timestamp: number|null, incrementality: number,
 *   entityCount: number, truncated: boolean, vehicles: object[] }}
 */
export function decodeNgsiVehicles(bytes, options = {}) {
  const text = new TextDecoder('utf-8').decode(bytes);
  let entities;
  try {
    entities = JSON.parse(text);
  } catch {
    throw new Error('NGSI body is not JSON');
  }
  if (!Array.isArray(entities)) throw new Error('NGSI body is not an array');
  const truncated = entities.length > GTFS_MAX_ENTITIES;
  const byId = new Map();
  let newest = null;
  for (const entity of entities.slice(0, GTFS_MAX_ENTITIES)) {
    const record = normalizeNgsiVehicle(entity, options);
    if (!record) continue;
    if (
      record.timestamp !== null &&
      (newest === null || record.timestamp > newest)
    )
      newest = record.timestamp;
    const existing = byId.get(record.id);
    if (!existing || (record.timestamp ?? 0) >= (existing.timestamp ?? 0))
      byId.set(record.id, record);
  }
  return {
    version: null,
    timestamp: newest,
    incrementality: GTFS_INCREMENTALITY_FULL_DATASET,
    entityCount: entities.length,
    truncated,
    vehicles: [...byId.values()],
  };
}
