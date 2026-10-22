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

const { state, dom, masterCutoutImg, DEFAULT_CROP_PADDING } = await import(
  "../static/state.js"
);
const {
  buildZip,
  createZipWriter,
  buildBatchExportBlob,
  scanAlphaBBoxFromPixels,
  expandCropBox,
  getActiveCropRect,
  getExportBaseDims,
  updateCropGuide,
  updateLiveStagePreview,
  updateExportTelemetry,
  applyExportSizePreset,
  resetExportSize,
  setCanvasFit,
  applyBackdrop,
  applyBackdropMode,
} = await import("../static/export.js");

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

test("expandCropBox adds symmetric padding based on the longest side", () => {
  const tight = { x: 50, y: 40, w: 100, h: 200 };
  assert.deepEqual(expandCropBox(tight, 0), tight);
  // 10% of max(100, 200) = 20px added on each side.
  assert.deepEqual(expandCropBox(tight, 10), {
    x: 30,
    y: 20,
    w: 140,
    h: 240,
  });
});

test("expandCropBox clamps negative and NaN padding to zero", () => {
  const box = { x: 10, y: 10, w: 50, h: 40 };
  assert.deepEqual(expandCropBox(box, -5), box);
  assert.deepEqual(expandCropBox(box, NaN), box);
  assert.deepEqual(expandCropBox(box, "junk"), box);
  assert.deepEqual(expandCropBox({ x: 0, y: 0, w: 0, h: 0 }, 0), {
    x: 0,
    y: 0,
    w: 1,
    h: 1,
  });
});

test("getExportBaseDims, updateCropGuide, and buildBatchExportBlob handle autoCrop", async () => {
  state.naturalWidth = 100;
  state.naturalHeight = 80;
  state.resultBlob = new Blob([enc.encode("png")], { type: "image/png" });
  masterCutoutImg.src = "blob:test-cutout";
  state.shadowCutoff = 0;
  state.viewMode = "split";

  state.autoCrop = false;
  state.cropPadding = 0;
  assert.deepEqual(getExportBaseDims(), { w: 100, h: 80 });
  updateCropGuide();
  assert.ok(!dom.cropGuide.classList.contains("visible"));

  state.autoCrop = true;
  state.cropPadding = 10;
  assert.deepEqual(getExportBaseDims(), { w: 120, h: 100 });
  updateCropGuide();
  assert.ok(dom.cropGuide.classList.contains("visible"));
  assert.equal(dom.cropGuide.dataset.inset, "0% 0% 0% 0%");

  state.viewMode = "original";
  updateCropGuide();
  assert.ok(!dom.cropGuide.classList.contains("visible"));
  state.viewMode = "split";

  const src = new Blob([enc.encode("png-bytes")], { type: "image/png" });
  const out = await buildBatchExportBlob(src, {
    format: "png",
    scale: 1,
    exportWidth: 0,
    exportHeight: 0,
    autoCrop: true,
    cropPadding: 5,
    backdrop: "checker",
    shadowCutoff: 0,
  });
  assert.notEqual(out, src, "autoCrop bypasses raw passthrough");
  assert.equal(out.type, "image/png");
  // Fake bitmap is 320x240 with empty alpha (full-frame box); 5% of 320 = 16px per side.
  assert.equal(await out.text(), "352x272");
});

test("getActiveCropRect falls back to the full frame when the cutout is not decoded", () => {
  state.naturalWidth = 100;
  state.naturalHeight = 80;
  state.resultBlob = new Blob([enc.encode("png")], { type: "image/png" });
  state.autoCrop = true;
  state.cropPadding = DEFAULT_CROP_PADDING;
  const saved = masterCutoutImg.complete;
  masterCutoutImg.complete = false;
  try {
    assert.deepEqual(getActiveCropRect(), { x: 0, y: 0, w: 100, h: 80 });
  } finally {
    masterCutoutImg.complete = saved;
    state.autoCrop = false;
  }
});

test("buildBatchExportBlob scales the padded crop box and honors custom dims", async () => {
  const src = new Blob([enc.encode("png-bytes")], { type: "image/png" });
  const base = {
    format: "png",
    backdrop: "checker",
    shadowCutoff: 0,
    autoCrop: true,
    cropPadding: 5,
    exportWidth: 0,
    exportHeight: 0,
    aspectLocked: true,
  };
  const scaled = await buildBatchExportBlob(src, { ...base, scale: 0.5 });
  assert.equal(await scaled.text(), "176x136");

  const fitWidth = await buildBatchExportBlob(src, {
    ...base,
    scale: 1,
    exportWidth: 100,
  });
  assert.equal(await fitWidth.text(), "100x77");

  const fixed = await buildBatchExportBlob(src, {
    ...base,
    scale: 1,
    exportWidth: 200,
    exportHeight: 100,
    aspectLocked: false,
  });
  assert.equal(await fixed.text(), "200x100");
});

test("updateLiveStagePreview fills the byte-exact export cache under autoCrop", async () => {
  state.naturalWidth = 100;
  state.naturalHeight = 80;
  state.resultBlob = new Blob([enc.encode("png")], { type: "image/png" });
  state.resultObjectUrl = "blob:test-result";
  state.exportFormat = "png";
  state.exportWidth = 0;
  state.exportHeight = 0;
  state.exportScale = 1;
  state.shadowCutoff = 0;
  state.activeBackdrop = "checker";
  state.viewMode = "split";
  masterCutoutImg.src = "blob:test-cutout-cache";
  state.autoCrop = true;
  state.cropPadding = 5;

  updateLiveStagePreview();
  await new Promise((r) => setTimeout(r, 250));

  assert.ok(state.exportCacheBlob instanceof Blob);
  assert.equal(state.exportCacheSource, state.resultBlob);
  // Empty shim alpha yields a full-frame tight box; 5% of 100 = 5px per side.
  assert.equal(await state.exportCacheBlob.text(), "110x90");
  assert.notEqual(dom.exportSizeLabel.textContent, "...");
  state.autoCrop = false;
});

test("buildBatchExportBlob composites blur and image backdrops", async () => {
  const src = new Blob([enc.encode("png-bytes")], { type: "image/png" });
  const base = {
    format: "png",
    scale: 1,
    exportWidth: 0,
    exportHeight: 0,
    autoCrop: false,
    shadowCutoff: 0,
  };
  // Blur decodes the entry's original file as the backdrop source.
  const blurred = await buildBatchExportBlob(
    src,
    { ...base, backdrop: "blur", backdropBlur: 80 },
    new Blob([enc.encode("orig")], { type: "image/png" })
  );
  assert.equal(await blurred.text(), "320x240");

  // Missing sources degrade to transparency instead of throwing or
  // filling with black.
  const noBlurSrc = await buildBatchExportBlob(src, {
    ...base,
    backdrop: "blur",
  });
  assert.equal(await noBlurSrc.text(), "320x240");

  const imaged = await buildBatchExportBlob(src, {
    ...base,
    backdrop: "image",
    backdropImg: { width: 640, height: 480 },
  });
  assert.equal(await imaged.text(), "320x240");

  const noImgSrc = await buildBatchExportBlob(src, {
    ...base,
    backdrop: "image",
  });
  assert.equal(await noImgSrc.text(), "320x240");
});

test("applyExportSizePreset sets exact dims and releases aspect lock", () => {
  state.aspectLocked = true;
  dom.aspectLockBtn.classList.add("active");
  state.exportWidth = 0;
  state.exportHeight = 0;

  applyExportSizePreset(1080, 1920);

  assert.equal(state.exportWidth, 1080);
  assert.equal(state.exportHeight, 1920);
  assert.equal(state.aspectLocked, false);
  assert.ok(!dom.aspectLockBtn.classList.contains("active"));
  assert.equal(dom.aspectLockBtn.getAttribute("aria-pressed"), "false");
  assert.equal(dom.exportWidthInput.value, "1080");
  assert.equal(dom.exportHeightInput.value, "1920");
});

test("preset chips track the current dims and reset restores scaled ones", () => {
  const chip = document.createElement("button");
  chip.className = "preset-chip";
  chip.setAttribute("data-w", "1024");
  chip.setAttribute("data-h", "1024");
  document.body.appendChild(chip);
  try {
    state.aspectLocked = true;
    state.naturalWidth = 0;
    state.naturalHeight = 0;

    applyExportSizePreset(1024, 1024);
    assert.ok(
      chip.classList.contains("active"),
      "matching chip is highlighted"
    );

    state.exportScale = 2;
    resetExportSize();
    assert.ok(
      !chip.classList.contains("active"),
      "reset clears the chip highlight"
    );
    assert.equal(state.aspectLocked, true, "reset restores aspect lock");
    assert.equal(dom.aspectLockBtn.getAttribute("aria-pressed"), "true");
    assert.equal(
      state.exportWidth,
      0,
      "no image loaded: dims stay empty until one arrives"
    );
  } finally {
    chip.remove();
    state.exportScale = 1;
  }
});

test("checker preview re-renders only when the export aspect differs", async () => {
  state.naturalWidth = 100;
  state.naturalHeight = 80;
  state.resultBlob = new Blob([enc.encode("png")], { type: "image/png" });
  state.resultObjectUrl = "blob:test-aspect";
  state.exportFormat = "png";
  state.exportScale = 1;
  state.shadowCutoff = 0;
  state.activeBackdrop = "checker";
  state.viewMode = "split";
  state.autoCrop = false;
  masterCutoutImg.src = "blob:test-cutout-aspect";

  // Native aspect: passthrough reuses the raw cutout blob.
  state.exportWidth = 100;
  state.exportHeight = 80;
  updateLiveStagePreview();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(state.previewBlob, state.resultBlob);

  // Square preset on a 100x80 source: preview renders the letterboxed box.
  state.exportWidth = 100;
  state.exportHeight = 100;
  updateLiveStagePreview();
  await new Promise((r) => setTimeout(r, 250));
  assert.notEqual(state.previewBlob, state.resultBlob);
  assert.equal(await state.previewBlob.text(), "100x100");
});

test("canvasFit stretch fills the canvas while fit keeps centered margins", async () => {
  const src = new Blob([enc.encode("png-bytes")], { type: "image/png" });
  const base = {
    format: "png",
    scale: 1,
    exportWidth: 640,
    exportHeight: 240,
    backdrop: "checker",
    shadowCutoff: 0,
  };
  // 320x240 source into 640x240: fit centers with 160px side margins.
  await buildBatchExportBlob(src, { ...base, canvasFit: "fit" });
  const fitDraw = document._canvases.at(-1)._drawCalls.at(-1);
  assert.deepEqual(fitDraw.slice(5), [160, 0, 320, 240]);

  await buildBatchExportBlob(src, { ...base, canvasFit: "stretch" });
  const stretchDraw = document._canvases.at(-1)._drawCalls.at(-1);
  assert.deepEqual(stretchDraw.slice(5), [0, 0, 640, 240]);
});

test("setCanvasFit toggles state and marks the matching chip", () => {
  const fit = document.createElement("button");
  fit.classList.add("fit-chip");
  fit.setAttribute("data-fit", "fit");
  const stretch = document.createElement("button");
  stretch.classList.add("fit-chip");
  stretch.setAttribute("data-fit", "stretch");
  document.body.append(fit, stretch);
  try {
    setCanvasFit("stretch");
    assert.equal(state.canvasFit, "stretch");
    assert.ok(stretch.classList.contains("active"));
    assert.ok(!fit.classList.contains("active"));
    setCanvasFit("fit");
    assert.equal(state.canvasFit, "fit");
    assert.ok(fit.classList.contains("active"));
  } finally {
    fit.remove();
    stretch.remove();
    setCanvasFit("fit");
  }
});

test("canvas fit row greys out only while the export aspect matches", () => {
  state.naturalWidth = 100;
  state.naturalHeight = 80;
  state.autoCrop = false;
  try {
    state.exportWidth = 100;
    state.exportHeight = 80;
    updateExportTelemetry();
    assert.ok(dom.canvasFitChips.classList.contains("disabled"));
    state.exportHeight = 100;
    updateExportTelemetry();
    assert.ok(!dom.canvasFitChips.classList.contains("disabled"));
  } finally {
    state.exportWidth = 0;
    state.exportHeight = 0;
  }
});

test("applyBackdropMode resolves modes and toggles the conditional wraps", () => {
  try {
    applyBackdropMode("blur");
    assert.equal(state.activeBackdrop, "blur");
    assert.equal(dom.backdropBlurWrap.style.display, "");
    assert.equal(dom.matteSwatches.style.display, "none");

    applyBackdropMode("image");
    assert.equal(state.activeBackdrop, "image");
    assert.equal(dom.backdropPhotoWrap.style.display, "");

    applyBackdropMode("color");
    assert.equal(state.activeBackdrop, "#ffffff");
    assert.equal(state.backdropColor, "#ffffff");
    assert.equal(dom.matteSwatches.style.display, "");
    assert.equal(dom.backdropPhotoWrap.style.display, "none");
    assert.equal(dom.backdropBlurWrap.style.display, "none");

    applyBackdrop("#00ff00");
    applyBackdropMode("color");
    assert.equal(state.activeBackdrop, "#00ff00", "COLOR restores last color");

    applyBackdropMode("checker");
    assert.equal(state.activeBackdrop, "checker");
  } finally {
    applyBackdropMode("checker");
    state.backdropColor = "#ffffff";
  }
});

test("autoCrop combined with a preset aspect renders the preset box in live preview", async () => {
  state.naturalWidth = 100;
  state.naturalHeight = 80;
  state.resultBlob = new Blob([enc.encode("png")], { type: "image/png" });
  state.resultObjectUrl = "blob:test-autocrop-preset";
  state.exportFormat = "png";
  state.exportScale = 1;
  state.shadowCutoff = 0;
  state.activeBackdrop = "checker";
  state.viewMode = "split";
  state.autoCrop = true;
  state.cropPadding = 5;
  masterCutoutImg.src = "blob:test-cutout-autocrop-preset";

  try {
    applyExportSizePreset(100, 100);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(await state.previewBlob.text(), "100x100");
    assert.equal(
      state.previewSignature,
      state.exportCacheSignature ?? state.previewSignature
    );
  } finally {
    state.autoCrop = false;
    resetExportSize();
  }
});
