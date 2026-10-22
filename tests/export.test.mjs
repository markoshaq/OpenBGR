/**
 * Node unit tests for static/export.js: the STORED-ZIP builder/writer and
 * the batch export blob pipeline (passthrough vs canvas re-render).
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims } from "./dom-shim.mjs";

installDomShims();

// buildBatchExportBlob decodes inputs through createImageBitmap, which Node
// lacks; the fake bitmap reports fixed pixel dims.
globalThis.createImageBitmap = async () => ({
  width: 320,
  height: 240,
  close() {},
});

const { buildZip, createZipWriter, buildBatchExportBlob } = await import(
  "../static/export.js"
);

const enc = new TextEncoder();

function concatWrites(writes) {
  const parts = writes.map((w) =>
    w instanceof ArrayBuffer ? new Uint8Array(w) : w
  );
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

test("buildZip emits a valid local header, payload, and EOCD for one entry", async () => {
  const data = enc.encode("hello");
  const blob = buildZip([{ name: "a.txt", data }]);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);

  assert.equal(dv.getUint32(0, true), 0x04034b50, "local file signature");
  assert.equal(dv.getUint16(6, true), 0, "ASCII name: no UTF-8 flag");
  assert.equal(dv.getUint32(14, true), 0x3610a686, "crc32 of 'hello'");
  assert.equal(dv.getUint32(18, true), 5, "compressed size");
  assert.equal(dv.getUint16(26, true), 5, "name length");
  assert.deepEqual([...buf.slice(35, 40)], [...data], "payload bytes");

  const eocdAt = buf.length - 22;
  assert.equal(dv.getUint32(eocdAt, true), 0x06054b50, "EOCD signature");
  assert.equal(dv.getUint16(eocdAt + 8, true), 1, "entry count");
});

test("buildZip sets the UTF-8 flag for non-ASCII filenames", async () => {
  const blob = buildZip([{ name: "é.png", data: enc.encode("x") }]);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  assert.equal(dv.getUint16(6, true) & 0x0800, 0x0800);
});

test("buildZip keeps entry offsets and names consistent across two entries", async () => {
  const blob = buildZip([
    { name: "one.png", data: enc.encode("AA") },
    { name: "two.png", data: enc.encode("BBB") },
  ]);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);

  // Second local header starts right after entry 1's 30-byte header + name + data.
  const second = 30 + "one.png".length + 2;
  assert.equal(dv.getUint32(second, true), 0x04034b50);
  assert.equal(dv.getUint16(second + 26, true), "two.png".length);
  const eocdAt = buf.length - 22;
  assert.equal(dv.getUint16(eocdAt + 8, true), 2, "central dir entry count");
});

test("createZipWriter streams local entries and writes central dir on close", async () => {
  const writes = [];
  let closed = false;
  const writable = {
    write: async (b) => writes.push(b),
    close: async () => {
      closed = true;
    },
    abort: async () => {},
  };
  const zw = createZipWriter(writable);
  assert.equal(zw.names.size, 0);
  await zw.add("one.png", enc.encode("A"));
  await zw.add("two.png", enc.encode("B"));

  // Three chunks per entry land before close: header, name, payload.
  assert.equal(writes.length, 6);

  await zw.close();
  assert.ok(closed);
  const buf = concatWrites(writes);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocdAt = buf.length - 22;
  assert.equal(dv.getUint32(eocdAt, true), 0x06054b50);
  assert.equal(dv.getUint16(eocdAt + 8, true), 2);
  const text = new TextDecoder().decode(buf);
  assert.ok(text.includes("one.png") && text.includes("two.png"));
});

test("createZipWriter.abort forwards to the underlying writable", async () => {
  let aborted = false;
  const zw = createZipWriter({
    write: async () => {},
    close: async () => {},
    abort: async () => {
      aborted = true;
    },
  });
  await zw.abort();
  assert.ok(aborted);
});

test("buildBatchExportBlob returns the source blob unchanged for a no-op export", async () => {
  const src = new Blob([enc.encode("png-bytes")], { type: "image/png" });
  const snap = {
    format: "png",
    scale: 1,
    exportWidth: 0,
    exportHeight: 0,
    backdrop: "checker",
    shadowCutoff: 0,
  };
  const out = await buildBatchExportBlob(src, snap);
  assert.equal(out, src);
});

test("buildBatchExportBlob honors custom dims as an aspect-preserving box", async () => {
  const src = new Blob([enc.encode("png-bytes")], { type: "image/png" });
  const snap = {
    format: "png",
    scale: 1,
    exportWidth: 160, // half of 320: target becomes 160x120
    exportHeight: 0,
    backdrop: "checker",
    shadowCutoff: 0,
  };
  const out = await buildBatchExportBlob(src, snap);
  assert.notEqual(out, src);
  assert.equal(out.type, "image/png");
  assert.ok(out.size > 0);
});

test("buildBatchExportBlob renders an 8-bit alpha mask for mask format", async () => {
  const src = new Blob([enc.encode("png-bytes")], { type: "image/png" });
  const snap = {
    format: "mask",
    scale: 1,
    exportWidth: 0,
    exportHeight: 0,
    backdrop: "checker",
    shadowCutoff: 0,
  };
  const out = await buildBatchExportBlob(src, snap);
  assert.equal(out.type, "image/png");
  assert.ok(out.size > 0);
});
