/**
 * Keyboard shortcut definitions and matching helpers, split from app.js so
 * the tables and predicates can be unit tested without booting the app.
 * All `run` callbacks defer to `window.openBGR`, so importing this module
 * has no side effects.
 */

/** True for editable elements that own keystrokes and paste while focused. */
export function isTextField(el) {
  return (
    el &&
    (el.tagName === "INPUT" ||
      el.tagName === "SELECT" ||
      el.tagName === "TEXTAREA" ||
      el.isContentEditable)
  );
}

/**
 * Cmd/Ctrl-modified keyboard shortcuts, matched on the lowercased `e.key`.
 * `shift` pins the required Shift state (undefined = ignored); `bothMods`
 * requires Cmd and Ctrl together (macOS fullscreen convention).
 */
export const MOD_SHORTCUTS = [
  // The shift-pinned entries must precede their unshifted twins: find() takes
  // the first match and a bare `shift: undefined` entry matches any Shift state.
  { keys: ["t"], shift: true, run: () => window.openBGR.reopenClosedTab() },
  { keys: ["t"], run: () => window.openBGR.newTab() },
  { keys: ["o"], run: () => window.openBGR.openImage() },
  { keys: ["e", "s"], run: () => window.openBGR.exportImage() },
  { keys: ["w"], run: () => window.openBGR.closeActiveTab() },
  { keys: ["b"], run: () => window.openBGR.startBatch() },
  { keys: [","], run: () => window.openBGR.openSettings("preferences") },
  { keys: ["r"], run: () => window.openBGR.rerunSegmentation() },
  {
    keys: ["tab"],
    run: (e) => window.openBGR.switchTabOffset(e.shiftKey ? -1 : 1),
  },
  {
    keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    run: (e) => window.openBGR.switchToTabAt(Number(e.key)),
  },
  { keys: ["0"], run: () => window.openBGR.zoomReset() },
  { keys: ["=", "+"], run: () => window.openBGR.zoomIn() },
  { keys: ["-"], run: () => window.openBGR.zoomOut() },
  { keys: ["c"], shift: true, run: () => window.openBGR.copyImage() },
  {
    keys: ["f"],
    bothMods: true,
    run: () => window.openBGR.toggleFullscreen(),
  },
  { keys: ["q"], run: () => window.openBGR.quitApp() },
];

/** Returns the MOD_SHORTCUTS entry matching a mod-key keydown event, else null. */
export function matchModShortcut(e) {
  if (!e.metaKey && !e.ctrlKey) return null;
  return (
    MOD_SHORTCUTS.find(
      (s) =>
        s.keys.includes(e.key.toLowerCase()) &&
        (s.shift === undefined || e.shiftKey === s.shift) &&
        (!s.bothMods || (e.metaKey && e.ctrlKey)),
    ) || null
  );
}

/** True on macOS/iOS where menu shortcuts are shown with Cmd/Opt glyphs. */
export function isApplePlatform() {
  return /Mac|iPhone|iPad|iPod/i.test(
    navigator.platform || navigator.userAgent,
  );
}

/** Rewrites a "Mod+" shortcut spec as a non-Apple menu label. */
export function menuShortcutLabel(spec) {
  return spec === "Fullscreen"
    ? "F11"
    : spec.replace("Shift+Mod+", "Ctrl+Shift+").replace("Mod+", "Ctrl+");
}

/** Rewrites a "Mod+" shortcut spec as a non-Apple shortcut-chip label. */
export function chipShortcutLabel(spec) {
  return spec
    .replace("Shift+Mod+", "CTRL+SHIFT+")
    .replace("Mod+", "CTRL+")
    .toUpperCase();
}
