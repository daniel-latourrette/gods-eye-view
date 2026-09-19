/**
 * @module zipEntries
 * @description Minimal ZIP reader for static GTFS bundles.
 *
 * Reads the central directory and inflates the requested entries with the
 * standard `DecompressionStream('deflate-raw')` (Node 18+ and browsers), so no
 * archive dependency is needed. Supports the two methods GTFS publishers use:
 * 0 (stored) and 8 (deflate). No ZIP64, no encryption, no multi-disk.
 *
 * Pure: no Node built-ins, no Cesium.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** EOCD is 22 bytes plus a comment of at most 65,535 bytes. */
const EOCD_SEARCH_BYTES = 22 + 0xffff;

async function inflateRaw(bytes) {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Extract named entries from a ZIP archive.
 *
 * @param {Uint8Array|ArrayBuffer} input Archive bytes.
 * @param {Iterable<string>} wanted Entry names to extract (matched on the
 *   base name, so `feed/stops.txt` satisfies `stops.txt`).
 * @param {{maxEntryBytes?: number}} [options] Per-entry uncompressed cap.
 * @returns {Promise<Map<string, Uint8Array>>} Base name → bytes, for the
 *   wanted entries that exist.
 */
export async function readZipEntries(
  input,
  wanted,
  { maxEntryBytes = 64 * 1024 * 1024 } = {},
) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names = new Set(wanted);
  let eocd = -1;
  const stop = Math.max(0, bytes.length - EOCD_SEARCH_BYTES);
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (
      offset + 46 > bytes.length ||
      view.getUint32(offset, true) !== CENTRAL_SIGNATURE
    )
      throw new Error('corrupt zip central directory');
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const fullName = decoder.decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    offset += 46 + nameLength + extraLength + commentLength;
    const base = fullName.split('/').pop();
    if (!names.has(base) || out.has(base)) continue;
    if (size > maxEntryBytes) throw new Error(`zip entry ${base} too large`);
    if (
      localOffset + 30 > bytes.length ||
      view.getUint32(localOffset, true) !== LOCAL_SIGNATURE
    )
      throw new Error('corrupt zip local header');
    const dataStart =
      localOffset +
      30 +
      view.getUint16(localOffset + 26, true) +
      view.getUint16(localOffset + 28, true);
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    if (data.length !== compressedSize) throw new Error('truncated zip entry');
    let content;
    if (method === 0) content = data.slice();
    else if (method === 8) content = await inflateRaw(data);
    else throw new Error(`unsupported zip method ${method} for ${base}`);
    if (content.length > maxEntryBytes)
      throw new Error(`zip entry ${base} too large`);
    out.set(base, content);
  }
  return out;
}
