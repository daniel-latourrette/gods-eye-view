/**
 * @file Road geometry from TomTom flow tiles, for live mode.
 *
 * Live traffic used to need two upstreams: Overpass for the OSM road polylines
 * the dots ride on, and TomTom for congestion. The flow tiles already carry
 * road polylines and a road class, so with a TomTom key the layer can draw its
 * roads from them and not depend on public Overpass mirrors (which rate-limit
 * or block callers). This module turns decoded flow segments into the
 * `{roads: [...]}` snapshot `parseRoads` consumes, with TomTom's road classes
 * mapped onto the OSM `highway` values the layer's speed/density/size tables
 * are keyed by.
 *
 * Pure and Cesium-free.
 *
 * @module data/flowRoads
 */

/** TomTom `road_type` → OSM `highway` class used by the traffic layer tables. */
export const TOMTOM_ROAD_CLASS = Object.freeze({
  Motorway: 'motorway',
  'International road': 'trunk',
  'Major road': 'primary',
  'Secondary road': 'secondary',
  'Connecting road': 'tertiary',
  'Major local road': 'unclassified',
  'Local road': 'residential',
  'Minor local road': 'residential',
});

/** Classes kept in the fast "major roads" pass (matches the Overpass query). */
const MAJOR_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary']);

/**
 * @param {string} roadType TomTom `road_type`.
 * @returns {string} OSM highway class ('unclassified' when unknown).
 */
export function osmClassForTomTomRoad(roadType) {
  return TOMTOM_ROAD_CLASS[roadType] || 'unclassified';
}

function touchesBounds(coords, bounds) {
  if (!bounds) return true;
  const { south, west, north, east } = bounds;
  return coords.some(
    ([lon, lat]) => lat >= south && lat <= north && lon >= west && lon <= east,
  );
}

/**
 * Build a road snapshot from decoded flow segments.
 *
 * Roads are two-way (`oneway: 0`): a flow tile draws each carriageway as its
 * own line but does not say which way traffic runs along it.
 *
 * @param {Array<{coords:number[][], roadType:string}>} segments From `decodeFlowTile`.
 * @param {Object} [opts]
 * @param {boolean} [opts.majorOnly=false] Keep motorway…secondary only.
 * @param {{south:number,west:number,north:number,east:number}} [opts.bounds]
 *   Drop segments with no vertex inside these bounds (tiles overhang the view).
 * @returns {{roads: Array<{coordinates:number[][], type:string, oneway:number}>, source:'tomtom-flow'}}
 */
export function roadsFromFlowSegments(
  segments,
  { majorOnly = false, bounds = null } = {},
) {
  const roads = [];
  for (const segment of segments || []) {
    const coords = segment?.coords;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    if (
      !coords.every(
        (p) =>
          Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]),
      )
    )
      continue;
    const type = osmClassForTomTomRoad(segment.roadType);
    if (majorOnly && !MAJOR_CLASSES.has(type)) continue;
    if (!touchesBounds(coords, bounds)) continue;
    roads.push({ coordinates: coords, type, oneway: 0 });
  }
  return { roads, source: 'tomtom-flow' };
}
