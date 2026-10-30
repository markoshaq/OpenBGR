/**
 * Node unit tests for static/alpha-bbox.js: the tight alpha bounding-box
 * scan, the cached per-source lookup with cutoff rescans, and the blob-keyed
 * warm helper.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims } from "./dom-shim.mjs";

installDomShims();

globalThis.createImageBitmap = async () => ({
  width: 100,
  height: 80,
  close() {},
});

const {
  scanAlphaBBoxFromPixels,
  computeAlphaBBox,
  warmBlobAlphaBBox,
  blobBBoxCache,
} = await import("../static/alpha-bbox.js");

test("scanAlphaBBoxFromPixels finds the tight foreground box and ignores faint dust", () => {
  const w = 10;
  const h = 8;
  const data = new Uint8ClampedArray(w * h * 4);
  // Faint 2/255 alpha speck at (0, 0) is below the threshold (4) and ignored.
  data[3] = 2;
  // Subject pixels at (2, 1) and (6, 5).
  data[(1 * w + 2) * 4 + 3] = 200;
  data[(5 * w + 6) * 4 + 3] = 255;

  assert.deepEqual(scanAlphaBBoxFromPixels(data, w, h, 4), {
    x: 2,
    y: 1,
    w: 5,
    h: 5,
  });
  assert.deepEqual(
    scanAlphaBBoxFromPixels(new Uint8ClampedArray(w * h * 4), w, h, 4),
    { x: 0, y: 0, w: 10, h: 8 }
  );
});

test("computeAlphaBBox caches per blob and rescans when the cutoff changes", () => {
  const realCreate = document.createElement.bind(document);
  let reads = 0;
  document.createElement = (tag) => {
    const el = realCreate(tag);
    if (tag === "canvas") {
      el._ctx.getImageData = (x, y, w, h) => {
        reads++;
        const data = new Uint8ClampedArray(w * h * 4);
        // Faint region (alpha 100) at (5,5)-(14,14); strong region (alpha 255)
        // at (8,8)-(11,11). A higher cutoff keeps only the strong one.
        for (let yy = 5; yy < 15; yy++) {
          for (let xx = 5; xx < 15; xx++) data[(yy * w + xx) * 4 + 3] = 100;
        }
        for (let yy = 8; yy < 12; yy++) {
          for (let xx = 8; xx < 12; xx++) data[(yy * w + xx) * 4 + 3] = 255;
        }
        return { data };
      };
    }
    return el;
  };

  const blob = new Blob(["bbox"], { type: "image/png" });
  try {
    assert.deepEqual(computeAlphaBBox(null, 100, 80, 0, blob), {
      x: 5,
      y: 5,
      w: 10,
      h: 10,
    });
    assert.equal(reads, 1);
    // Same cutoff: served from the blob cache, no new readback.
    assert.deepEqual(computeAlphaBBox(null, 100, 80, 0, blob), {
      x: 5,
      y: 5,
      w: 10,
      h: 10,
    });
    assert.equal(reads, 1);
    // A higher cutoff drops the faint region: rescan the cached buffer.
    assert.deepEqual(computeAlphaBBox(null, 100, 80, 50, blob), {
      x: 8,
      y: 8,
      w: 4,
      h: 4,
    });
    assert.equal(reads, 1);
    assert.deepEqual(computeAlphaBBox(null, 100, 80, 50, blob), {
      x: 8,
      y: 8,
      w: 4,
      h: 4,
    });
    assert.equal(reads, 1);
  } finally {
    document.createElement = realCreate;
    blobBBoxCache.delete(blob);
  }
});

test("warmBlobAlphaBBox decodes once, then serves later cutoffs from the cache", async () => {
  const realCreate = document.createElement.bind(document);
  let decodes = 0;
  const realBitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => {
    decodes++;
    return { width: 100, height: 80, close() {} };
  };
  document.createElement = (tag) => {
    const el = realCreate(tag);
    if (tag === "canvas") {
      el._ctx.getImageData = (x, y, w, h) => {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let yy = 3; yy < 9; yy++) {
          for (let xx = 2; xx < 9; xx++) data[(yy * w + xx) * 4 + 3] = 255;
        }
        return { data };
      };
    }
    return el;
  };

  const blob = new Blob(["warm"], { type: "image/png" });
  try {
    assert.deepEqual(await warmBlobAlphaBBox(blob, 100, 80, 0), {
      x: 2,
      y: 3,
      w: 7,
      h: 6,
    });
    assert.equal(decodes, 1);
    // Cached: no second decode, and the box stays stable across cutoffs that
    // do not cross the stored pixels' alpha.
    assert.deepEqual(await warmBlobAlphaBBox(blob, 100, 80, 40), {
      x: 2,
      y: 3,
      w: 7,
      h: 6,
    });
    assert.equal(decodes, 1);
    // Non-blob and empty inputs stay null-safe.
    assert.equal(await warmBlobAlphaBBox(null, 100, 80, 0), null);
  } finally {
    globalThis.createImageBitmap = realBitmap;
    document.createElement = realCreate;
    blobBBoxCache.delete(blob);
  }
});
