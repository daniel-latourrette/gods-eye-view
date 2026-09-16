import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLusoponteSourcesFromCatalog } from '../../server/providers/cctv/sources.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

test('Lusoponte catalog registers the four Tagus bridge cameras on the official host only', (t) => {
  t.mock.method(console, 'log', () => {});
  const cameras = loadLusoponteSourcesFromCatalog();
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    [
      'lusoponte-p25-acessos-norte',
      'lusoponte-p25-no-almada',
      'lusoponte-pvg-acessos-norte',
      'lusoponte-pvg-viaduto-sul',
    ],
  );
  for (const camera of cameras) {
    assert.match(
      camera.url,
      /^https:\/\/www\.lusoponte\.pt\/assets\/cam[12]_(P25|PVG)_00001\.jpg$/,
    );
    assert.equal(camera.snapshotUrl, camera.url);
    assert.equal(camera.provider, 'Lusoponte');
    assert.equal(camera.sourceKind, 'lusoponte-bridges');
    assert.equal(camera.feedType, 'image');
    assert.equal(camera.poseSource, 'curated');
    assert.equal(camera.headingConfidence, 'low');
  }
});

test('Lusoponte loader tolerates a missing catalog file', (t) => {
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(
    loadLusoponteSourcesFromCatalog({ sourceRoot: '/nonexistent' }),
    [],
  );
});

test('Lusoponte loader skips off-host, out-of-area, duplicate and malformed rows', (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-lusoponte-'));
  fs.mkdirSync(path.join(dir, 'config'));
  const url = 'https://www.lusoponte.pt/assets/cam1_P25_00001.jpg';
  fs.writeFileSync(
    path.join(dir, 'config', 'cctv_sources.lusoponte.json'),
    JSON.stringify([
      { id: 'ok', url, lat: 38.7, lon: -9.17 },
      { id: 'ok', url, lat: 38.7, lon: -9.17 },
      { id: { toString: null }, url, lat: 38.7, lon: -9.17 },
      { id: 'text-coords', url, lat: '38.7', lon: '-9.17' },
      { id: 'porto', url, lat: 41.15, lon: -8.61 },
      {
        id: 'off-host',
        url: 'https://evil.example/a.jpg',
        lat: 38.7,
        lon: -9.17,
      },
      {
        id: 'other-path',
        url: 'https://www.lusoponte.pt/other/a.jpg',
        lat: 38.7,
        lon: -9.17,
      },
    ]),
  );
  const cameras = loadLusoponteSourcesFromCatalog({ sourceRoot: dir });
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    ['ok'],
  );
});

test('CCTV_LUSOPONTE_ENABLED=0 drops the pack from the merged catalog', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const envKeys = Object.keys(process.env).filter((key) =>
    /^CCTV_[A-Z0-9]+_ENABLED$/.test(key),
  );
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (/^CCTV_[A-Z0-9]+_ENABLED$/.test(key) && !(key in saved))
        delete process.env[key];
    Object.assign(process.env, saved);
  });
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network disabled in test');
  });
  const idsWith = async (enabled) => {
    process.env.CCTV_LUSOPONTE_ENABLED = enabled;
    const sources = await createCctvCatalog({ sourceRoot: process.cwd() })();
    return sources.map((source) => source.id);
  };
  assert.ok((await idsWith('1')).includes('lusoponte-p25-acessos-norte'));
  assert.ok(!(await idsWith('0')).includes('lusoponte-p25-acessos-norte'));
});

test('only the registered Lusoponte HTTPS host gets the bundled TLS intermediate', async () => {
  const { cctvFetchForUrl } =
    await import('../../server/providers/cctv/tls.js');
  assert.equal(cctvFetchForUrl('https://example.com/frame.jpg'), fetch);
  assert.equal(cctvFetchForUrl('http://www.lusoponte.pt/assets/a.jpg'), fetch);
  assert.equal(
    cctvFetchForUrl('https://lusoponte.pt.evil.example/a.jpg'),
    fetch,
  );
  assert.equal(cctvFetchForUrl('not a url'), fetch);
  assert.notEqual(
    cctvFetchForUrl('https://www.lusoponte.pt/assets/cam1_P25_00001.jpg'),
    fetch,
  );
});
