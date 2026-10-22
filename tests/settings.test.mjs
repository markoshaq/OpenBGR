/**
 * Node unit tests for static/settings.js: theme/accent picks, default
 * tier/format/backdrop gating, Quick Action prefs, and Reset to Defaults.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims, FakeElement } from "./dom-shim.mjs";

installDomShims();
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

const { state, dom, prefs } = await import("../static/state.js");
const {
  setThemePref,
  setAccentPref,
  pickDefaultTier,
  pickDefaultFormat,
  pickDefaultBackdrop,
  setQaPref,
  toggleQaFlag,
  toggleConfirmClose,
  resetAllPrefs,
} = await import("../static/settings.js");

function reset() {
  state.tabs = [];
  state.activeTabId = null;
  state.sourceFile = null;
  state.resultBlob = null;
  state.serverStatus = { tiers: {}, recommended_tier: "general" };
  state.tier = "general";
  state.confirmCloseTab = true;
  state.activeBackdrop = "checker";
}

test("setThemePref and setAccentPref store prefs and apply them", () => {
  reset();
  setThemePref("light");
  assert.equal(prefs.theme, "light");
  assert.ok(document.documentElement.classList.contains("theme-light"));
  setThemePref("dark");
  assert.equal(prefs.theme, "dark");

  setAccentPref("blue");
  assert.equal(prefs.accent, "blue");
  setAccentPref(null);
  assert.equal(prefs.accent, "default", "missing data-accent falls back");
});

test("pickDefaultTier changes the live tier only when no image is loaded", () => {
  reset();
  pickDefaultTier("lite");
  assert.equal(prefs.defaultTier, "lite");
  assert.equal(state.tier, "lite");

  pickDefaultTier("auto");
  assert.equal(state.tier, "general", "auto resolves to the recommended tier");

  state.sourceFile = {};
  pickDefaultTier("hr");
  assert.equal(state.tier, "general", "a loaded image keeps its tier");
  assert.equal(prefs.defaultTier, "hr");
});

test("pickDefaultFormat and pickDefaultBackdrop apply only while unprocessed", () => {
  reset();
  pickDefaultFormat("webp");
  assert.equal(prefs.defaultFormat, "webp");
  assert.equal(state.exportFormat, "webp");

  state.resultBlob = new Blob(["x"]);
  pickDefaultFormat("jpg");
  assert.equal(state.exportFormat, "webp", "a processed image keeps its format");

  pickDefaultBackdrop("#ff0000");
  assert.equal(prefs.defaultBackdrop, "#ff0000");
  assert.equal(state.activeBackdrop, "checker", "processed image keeps backdrop");
});

test("setQaPref stores and pushes; toggleQaFlag mirrors the button", () => {
  reset();
  setQaPref("qaTier", "hr");
  assert.equal(prefs.qaTier, "hr");

  const btn = new FakeElement("button");
  const before = prefs.qaNotify;
  toggleQaFlag(btn, "qaNotify");
  assert.equal(prefs.qaNotify, !before);
  assert.equal(btn.classList.contains("active"), !before);
  toggleQaFlag(btn, "qaNotify");
  assert.equal(prefs.qaNotify, before);
});

test("toggleConfirmClose flips state, pref, and button", () => {
  reset();
  const before = state.confirmCloseTab;
  toggleConfirmClose();
  assert.equal(state.confirmCloseTab, !before);
  assert.equal(prefs.confirmClose, !before);
  assert.equal(dom.btnToggleConfirmClose.classList.contains("active"), !before);
});

test("resetAllPrefs restores defaults and applies them to an idle workspace", () => {
  reset();
  pickDefaultFormat("webp");
  pickDefaultBackdrop("blur");
  prefs.theme = "light";
  resetAllPrefs();
  assert.equal(prefs.theme, "dark");
  assert.equal(state.exportFormat, prefs.defaultFormat);
  assert.equal(state.activeBackdrop, prefs.defaultBackdrop);
  assert.equal(state.tier, "general");
});
