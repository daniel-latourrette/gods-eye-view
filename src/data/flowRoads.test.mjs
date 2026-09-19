import { test } from 'node:test';
import assert from 'node:assert/strict';
import { osmClassForTomTomRoad, roadsFromFlowSegments } from './flowRoads.js';
import { createIngestion } from '../layers/traffic/ingestion.js';

const seg = (
  roadType,
  coords = [
    [-8.61, 41.15],
    [-8.6, 41.151],
  ],
) => ({
  coords,
  roadType,
  trafficLevel: 0.5,
  closure: false,
});

test('TomTom road classes map onto the OSM classes the layer is tuned for', () => {
  assert.equal(osmClassForTomTomRoad('Motorway'), 'motorway');
  assert.equal(osmClassForTomTomRoad('Major road'), 'primary');
  assert.equal(osmClassForTomTomRoad('Secondary road'), 'secondary');
  assert.equal(osmClassForTomTomRoad('Connecting road'), 'tertiary');
  assert.equal(osmClassForTomTomRoad('Local road'), 'residential');
  assert.equal(osmClassForTomTomRoad('Something new'), 'unclassified');
  assert.equal(osmClassForTomTomRoad(undefined), 'unclassified');
});

test('flow segments become a two-way road snapshot', () => {
  const snapshot = roadsFromFlowSegments([
    seg('Motorway'),
    seg('Connecting road'),
  ]);
  assert.equal(snapshot.source, 'tomtom-flow');
  assert.deepEqual(snapshot.roads, [
    {
      coordinates: [
        [-8.61, 41.15],
        [-8.6, 41.151],
      ],
      type: 'motorway',
      oneway: 0,
    },
    {
      coordinates: [
        [-8.61, 41.15],
        [-8.6, 41.151],
      ],
      type: 'tertiary',
      oneway: 0,
    },
  ]);
});

test('majorOnly keeps motorway to secondary, like the Overpass fast pass', () => {
  const types = roadsFromFlowSegments(
    [
      seg('Motorway'),
      seg('International road'),
      seg('Major road'),
      seg('Secondary road'),
      seg('Connecting road'),
      seg('Major local road'),
      seg('Local road'),
    ],
    { majorOnly: true },
  ).roads.map((road) => road.type);
  assert.deepEqual(types, ['motorway', 'trunk', 'primary', 'secondary']);
});

test('segments outside the bounds or with bad geometry are dropped', () => {
  const bounds = { south: 41.14, west: -8.62, north: 41.16, east: -8.59 };
  const roads = roadsFromFlowSegments(
    [
      seg('Major road'),
      seg('Major road', [
        [-9.14, 38.72],
        [-9.13, 38.73],
      ]),
      seg('Major road', [[-8.61, 41.15]]),
      seg('Major road', [
        [-8.61, 41.15],
        ['x', 41.151],
      ]),
      null,
    ],
    { bounds },
  ).roads;
  assert.equal(roads.length, 1);
});

function ingestionHarness({ liveMode, flowImpl, overpassImpl }) {
  const calls = { flow: 0, overpass: 0 };
  const state = { _liveMode: liveMode };
  const source = {
    async fetchFlowForBounds(...args) {
      calls.flow += 1;
      return flowImpl(...args);
    },
    async requestRoads() {
      calls.overpass += 1;
      return overpassImpl();
    },
  };
  const parts = { flow: { ensureFlowStatus: async () => {} } };
  const ingestion = createIngestion({ state, services: {}, parts, source });
  return { ingestion, calls };
}

const overpassOk = () => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({
    roads: [
      {
        coordinates: [
          [0, 0],
          [1, 1],
        ],
        type: 'primary',
        oneway: 0,
      },
    ],
  }),
});

test('live mode takes road geometry from TomTom and never calls Overpass', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { ingestion, calls } = ingestionHarness({
    liveMode: true,
    flowImpl: async () => [seg('Motorway'), seg('Local road')],
    overpassImpl: overpassOk,
  });
  const data = await ingestion.fetchRoads(41.14, -8.62, 41.16, -8.59, {
    majorOnly: true,
  });
  assert.equal(data.source, 'tomtom-flow');
  assert.deepEqual(
    data.roads.map((road) => road.type),
    ['motorway'],
  );
  assert.equal(calls.overpass, 0);
});

test('live mode falls back to Overpass when every flow tile fails', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { ingestion, calls } = ingestionHarness({
    liveMode: true,
    flowImpl: async () => {
      throw new Error('flow tile 12/1/1: HTTP 502');
    },
    overpassImpl: overpassOk,
  });
  const data = await ingestion.fetchRoads(41.14, -8.62, 41.16, -8.59);
  assert.equal(data.roads[0].type, 'primary');
  assert.equal(calls.overpass, 1);
});

test('keyless mode still uses Overpass only', async () => {
  const { ingestion, calls } = ingestionHarness({
    liveMode: false,
    flowImpl: async () => [seg('Motorway')],
    overpassImpl: overpassOk,
  });
  await ingestion.fetchRoads(41.14, -8.62, 41.16, -8.59);
  assert.deepEqual(calls, { flow: 0, overpass: 1 });
});

test('an aborted flow fetch is not turned into an Overpass request', async () => {
  const abort = new DOMException('stop', 'AbortError');
  const { ingestion, calls } = ingestionHarness({
    liveMode: true,
    flowImpl: async () => {
      throw abort;
    },
    overpassImpl: overpassOk,
  });
  await assert.rejects(
    ingestion.fetchRoads(41.14, -8.62, 41.16, -8.59),
    (e) => e.name === 'AbortError',
  );
  assert.equal(calls.overpass, 0);
});
