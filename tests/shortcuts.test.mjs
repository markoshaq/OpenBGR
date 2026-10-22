/**
 * Node unit tests for static/shortcuts.js: the text-field gate, the
 * Cmd/Ctrl shortcut table and matcher, and the non-Apple label rewrites
 * used by the in-app menu bar.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims } from "./dom-shim.mjs";

installDomShims();

const {
  isTextField,
  MOD_SHORTCUTS,
  matchModShortcut,
  isApplePlatform,
  menuShortcutLabel,
  chipShortcutLabel,
} = await import("../static/shortcuts.js");

test("isTextField accepts editable elements and rejects the rest", () => {
  assert.equal(isTextField({ tagName: "INPUT" }), true);
  assert.equal(isTextField({ tagName: "TEXTAREA" }), true);
  assert.equal(isTextField({ tagName: "SELECT" }), true);
  assert.equal(isTextField({ tagName: "DIV", isContentEditable: true }), true);
  assert.ok(!isTextField({ tagName: "DIV" }));
  assert.ok(!isTextField(null));
  assert.ok(!isTextField(undefined));
});

test("matchModShortcut resolves keys, shift pinning, and bothMods", () => {
  const ev = (key, mods = {}) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...mods,
  });

  assert.equal(matchModShortcut(ev("t")), null, "no modifier, no match");
  assert.equal(
    matchModShortcut(ev("T", { metaKey: true })).keys[0],
    "t",
    "matching is case-insensitive on e.key",
  );
  // Cmd+T and Cmd+Shift+T must resolve to different entries.
  const plain = matchModShortcut(ev("t", { metaKey: true }));
  const shifted = matchModShortcut(ev("t", { metaKey: true, shiftKey: true }));
  assert.notEqual(plain, shifted);
  // Cmd+F alone must not trigger the bothMods fullscreen entry.
  assert.equal(matchModShortcut(ev("f", { metaKey: true })), null);
  assert.ok(
    matchModShortcut(ev("f", { metaKey: true, ctrlKey: true }))?.bothMods,
  );
  assert.equal(matchModShortcut(ev("q", { ctrlKey: true }))?.keys[0], "q");
});

test("MOD_SHORTCUTS shift-pinned entries precede their unshifted twins", () => {
  // matchModShortcut takes the first find() hit, so a `shift: true` entry must
  // sit before any same-key `shift: undefined` entry or it is unreachable.
  for (const [key, group] of Map.groupBy(
    MOD_SHORTCUTS.map((s, i) => ({ s, i })),
    ({ s }) => s.keys.join("|"),
  )) {
    const firstUnshifted = group.find(({ s }) => s.shift === undefined);
    if (!firstUnshifted) continue;
    for (const { s, i } of group) {
      if (s.shift !== undefined) {
        assert.ok(
          i < firstUnshifted.i,
          `${key}: shift-pinned entry must precede the unshifted twin`,
        );
      }
    }
  }
});

test("MOD_SHORTCUTS run callbacks dispatch through window.openBGR", () => {
  const calls = [];
  window.openBGR = {
    newTab: () => calls.push("newTab"),
    quitApp: () => calls.push("quitApp"),
    switchTabOffset: (n) => calls.push(`switchTabOffset:${n}`),
  };
  matchModShortcut({ key: "t", metaKey: true })?.run({});
  matchModShortcut({ key: "q", ctrlKey: true })?.run({});
  matchModShortcut({ key: "tab", metaKey: true, shiftKey: true })?.run({
    shiftKey: true,
  });
  assert.deepEqual(calls, ["newTab", "quitApp", "switchTabOffset:-1"]);
});

test("isApplePlatform reads navigator.platform then userAgent", () => {
  const setNav = (value) =>
    Object.defineProperty(globalThis, "navigator", {
      value,
      configurable: true,
    });
  const nav = globalThis.navigator;
  try {
    setNav({ platform: "MacIntel", userAgent: "node-test" });
    assert.equal(isApplePlatform(), true);
    setNav({ platform: "Win32", userAgent: "node-test" });
    assert.equal(isApplePlatform(), false);
    setNav({ platform: "", userAgent: "iPhone test" });
    assert.equal(isApplePlatform(), true);
  } finally {
    setNav(nav);
  }
});

test("menuShortcutLabel and chipShortcutLabel rewrite Mod+ specs", () => {
  assert.equal(menuShortcutLabel("Mod+O"), "Ctrl+O");
  assert.equal(menuShortcutLabel("Shift+Mod+T"), "Ctrl+Shift+T");
  assert.equal(menuShortcutLabel("Fullscreen"), "F11");
  assert.equal(menuShortcutLabel("Mod+Tab"), "Ctrl+Tab");
  assert.equal(chipShortcutLabel("Mod+O"), "CTRL+O");
  assert.equal(chipShortcutLabel("Shift+Mod+T"), "CTRL+SHIFT+T");
});
