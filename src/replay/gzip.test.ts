import { expect, test } from "bun:test";

import { isGzip } from "@mirafive/protocol";

import { canCompress, compress, storedGzip } from "./gzip";

const text = (length: number) =>
  new TextEncoder().encode(
    Array.from({ length }, (_, index) => String.fromCharCode(32 + (index % 90))).join(""),
  );

test("stored gzip is valid gzip of any length, made at once", () => {
  for (const length of [0, 1, 1000, 65_535, 65_536, 200_000]) {
    const bytes = text(length);
    const gzip = storedGzip(bytes);
    expect(isGzip(gzip) || length === 0).toBe(true);
    expect(Bun.gunzipSync(gzip)).toEqual(bytes);
  }
});

test("the browser's CompressionStream makes the body", async () => {
  const bytes = text(50_000);
  const gzip = await compress(bytes);
  expect(isGzip(gzip)).toBe(true);
  expect(gzip.length).toBeLessThan(bytes.length);
  expect(Bun.gunzipSync(gzip)).toEqual(bytes);
});

test("without CompressionStream there is nothing to record with", () => {
  expect(canCompress({})).toBe(false);
  expect(canCompress({ CompressionStream: function CompressionStream() {} })).toBe(true);
});
