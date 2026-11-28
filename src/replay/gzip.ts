/**
 * A chunk's body is a gzip member (RFC 1952). Compressed by the browser's own `CompressionStream`,
 * which runs off the main thread; there is no compression library. Without `CompressionStream`
 * (browsers before 2023) nothing is recorded.
 *
 * On page hide there is no time to wait for a stream: the rest of the recording then goes as a
 * gzip member with stored (uncompressed) deflate blocks, made at once. It is valid gzip, as large
 * as the text, and only used for what fits a beacon anyway.
 */

export const canCompress = (scope: { CompressionStream?: unknown } = globalThis) =>
  typeof scope.CompressionStream === "function";

/** Gzip by the browser, off the main thread. */
export async function compress(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

let table: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const BLOCK = 0xffff;

/** A gzip member of stored deflate blocks: no compression, made synchronously. */
export function storedGzip(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const blocks = Math.max(1, Math.ceil(bytes.length / BLOCK));
  const out = new Uint8Array(10 + blocks * 5 + bytes.length + 8);
  out.set([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff]);
  let at = 10;
  for (let block = 0; block < blocks; block += 1) {
    const part = bytes.subarray(block * BLOCK, (block + 1) * BLOCK);
    const last = block === blocks - 1 ? 1 : 0;
    out.set(
      [
        last,
        part.length & 0xff,
        part.length >>> 8,
        ~part.length & 0xff,
        (~part.length >>> 8) & 0xff,
      ],
      at,
    );
    out.set(part, at + 5);
    at += 5 + part.length;
  }
  const view = new DataView(out.buffer);
  view.setUint32(at, crc32(bytes), true);
  view.setUint32(at + 4, bytes.length >>> 0, true);
  return out;
}
