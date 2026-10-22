/**
 * Node unit tests for static/backdrop.js: installing and removing the
 * backdrop photo, the native/hidden-input picker routing, mode chips, and
 * the thumbnail context menu.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims } from "./dom-shim.mjs";

installDomShims();

const { state, dom } = await import("../static/state.js");
const {
  setBackdropFile,
  chooseBackdropImage,
  removeBackdropPhoto,
  handleBackdropModeChip,
  showBackdropPhotoMenu,
} = await import("../static/backdrop.js");

const enc = new TextEncoder();
const pngFile = (name = "bg.png") =>
  new File([enc.encode("img")], name, { type: "image/png" });

function reset() {
  state.backdropImg = null;
  state.backdropImgUrl = null;
  state.backdropSeq = 0;
  state.activeBackdrop = "checker";
  state.backdropColor = "#ffffff";
  dom.errorToast.classList.remove("visible");
  dom.errorToast.textContent = "";
  dom.tabContextMenu.replaceChildren();
  delete window.pywebview;
}

test("setBackdropFile installs the photo and switches to image mode", async () => {
  reset();
  await setBackdropFile(pngFile());
  assert.ok(state.backdropImg);
  assert.match(state.backdropImgUrl, /^blob:/);
  assert.equal(state.backdropSeq, 1);
  assert.equal(state.activeBackdrop, "image");
});

test("setBackdropFile reports undecodable images and keeps the old backdrop", async () => {
  reset();
  const RealImage = globalThis.Image;
  globalThis.Image = class extends RealImage {
    set src(_v) {
      queueMicrotask(() => this.onerror?.());
    }
  };
  try {
    await setBackdropFile(pngFile("broken.png"));
  } finally {
    globalThis.Image = RealImage;
  }
  assert.equal(state.backdropImg, null);
  assert.equal(state.activeBackdrop, "checker");
  assert.match(dom.errorToast.textContent, /could not decode/i);
});

test("setBackdropFile with no file re-applies an already loaded photo", async () => {
  reset();
  await setBackdropFile(pngFile());
  state.activeBackdrop = "checker";
  await setBackdropFile(undefined);
  assert.equal(state.activeBackdrop, "image");
  assert.equal(state.backdropSeq, 1, "no new photo was installed");
});

test("removeBackdropPhoto falls back to the grid only if the photo was active", async () => {
  reset();
  await setBackdropFile(pngFile());
  removeBackdropPhoto();
  assert.equal(state.backdropImg, null);
  assert.equal(state.backdropImgUrl, null);
  assert.equal(state.activeBackdrop, "checker");

  await setBackdropFile(pngFile());
  state.activeBackdrop = "#ff0000";
  removeBackdropPhoto();
  assert.equal(state.activeBackdrop, "#ff0000");
});

test("chooseBackdropImage uses the hidden input without the native bridge", async () => {
  reset();
  let clicked = 0;
  dom.backdropInput.click = () => {
    clicked += 1;
  };
  dom.backdropInput.value = "stale";
  await chooseBackdropImage();
  assert.equal(clicked, 1);
  assert.equal(dom.backdropInput.value, "");
});

test("chooseBackdropImage loads the native dialog pick and surfaces bridge errors", async () => {
  reset();
  let clicked = 0;
  dom.backdropInput.click = () => {
    clicked += 1;
  };
  const b64 = Buffer.from("img").toString("base64");
  window.pywebview = {
    api: {
      open_image_dialog: async () => ({ data_b64: b64, name: "photo.png" }),
    },
  };
  await chooseBackdropImage();
  assert.ok(state.backdropImg);
  assert.equal(state.activeBackdrop, "image");

  window.pywebview.api.open_image_dialog = async () => ({ error: "Denied" });
  await chooseBackdropImage();
  assert.match(dom.errorToast.textContent, /Denied/);
  assert.equal(clicked, 0, "hidden input is only a fallback");
});

test("handleBackdropModeChip opens the picker for PHOTO with no photo loaded", async () => {
  reset();
  let clicked = 0;
  dom.backdropInput.click = () => {
    clicked += 1;
  };
  handleBackdropModeChip("image");
  assert.equal(clicked, 1);
  assert.equal(state.activeBackdrop, "checker");

  handleBackdropModeChip("color");
  assert.equal(state.activeBackdrop, "#ffffff");
  handleBackdropModeChip("blur");
  assert.equal(state.activeBackdrop, "blur");
});

test("showBackdropPhotoMenu offers REMOVE PHOTO only when a photo is loaded", async () => {
  reset();
  showBackdropPhotoMenu(10, 10);
  assert.equal(dom.tabContextMenu.children.length, 0);

  await setBackdropFile(pngFile());
  showBackdropPhotoMenu(10, 20);
  const menu = dom.tabContextMenu;
  assert.equal(menu.style.display, "block");
  assert.equal(menu.style.left, "10px");
  assert.equal(menu.style.top, "20px");
  const [item] = menu.children;
  assert.equal(item.textContent, "REMOVE PHOTO");
  item.click();
  assert.equal(state.backdropImg, null);
  assert.equal(state.activeBackdrop, "checker");
});
