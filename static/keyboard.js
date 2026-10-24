/**
 * Window keyboard handling: the Escape dismiss cascade, F11, Cmd/Ctrl
 * shortcuts from shortcuts.js, and the bare-key stage controls (Space pan,
 * Z loupe, 1/2/3 view modes).
 * Importing this module has no side effects; app.js calls `initKeyboard()`.
 */

import { state, dom, closeConfirmModal } from "./state.js";
import { closePrefsDialog } from "./preferences.js";
import { toggleLoupe } from "./tabs.js";
import { emit } from "./bus.js";
import { cancelProcessing } from "./segmentation.js";
import { isTextField, matchModShortcut } from "./shortcuts.js";
import { closeAllMenus, isAnyMenuOpen } from "./menubar.js";
import { isTierDropdownOpen, setTierDropdownOpen } from "./tier-dropdown.js";
import { isRecentModalOpen, closeRecentModal } from "./recent.js";
import { toggleAnimationPlayback, stepAnimationFrame } from "./animation.js";

/** Bare number keys mapped to the stage view modes they select. */
export const VIEW_KEYS = { "1": "split", "2": "cutout", "3": "original" };

/**
 * Dismisses the topmost open layer, one per press. Returns which layer was
 * dismissed ("menu", "tierDropdown", "prefs", "recent", "confirm",
 * "processing", "loupe"), or null when nothing was open.
 */
export function handleEscape() {
  emit("context-menu:hide");
  if (isAnyMenuOpen()) {
    closeAllMenus();
    return "menu";
  }
  if (isTierDropdownOpen()) {
    setTierDropdownOpen(false);
    dom.tierDropdownBtn?.focus();
    return "tierDropdown";
  }
  if (dom.infoModal.classList.contains("active")) {
    closePrefsDialog();
    return "prefs";
  }
  if (isRecentModalOpen()) {
    closeRecentModal();
    return "recent";
  }
  if (dom.confirmModal.classList.contains("active")) {
    closeConfirmModal();
    return "confirm";
  }
  if (state.isProcessing) {
    cancelProcessing();
    return "processing";
  }
  if (state.loupeEnabled) {
    toggleLoupe(false);
    return "loupe";
  }
  return null;
}

/** Window `keydown` handler. */
export function handleKeydown(e) {
  if (e.key === "Escape") {
    handleEscape();
    return;
  }

  if (e.key === "F11") {
    e.preventDefault();
    window.openBGR.toggleFullscreen();
    return;
  }

  // A focused form field owns the keyboard; app shortcuts stay out of the way.
  if (isTextField(e.target)) {
    return;
  }

  if (e.metaKey || e.ctrlKey) {
    const sc = matchModShortcut(e);
    if (sc) {
      e.preventDefault();
      sc.run(e);
    }
    return;
  }

  if (e.code === "Space") {
    state.spacePressed = true;
    if (
      state.isAnimated &&
      state.frames.length > 1 &&
      !e.repeat &&
      !state.isPanning
    ) {
      e.preventDefault();
      toggleAnimationPlayback();
    }
  } else if (e.key === "ArrowLeft" && state.isAnimated && state.frames.length > 1) {
    e.preventDefault();
    stepAnimationFrame(-1);
  } else if (e.key === "ArrowRight" && state.isAnimated && state.frames.length > 1) {
    e.preventDefault();
    stepAnimationFrame(1);
  } else if ((e.key === "z" || e.key === "Z") && state.sourceFile) {
    toggleLoupe();
  } else if (!e.altKey && ["1", "2", "3"].includes(e.key) && state.resultBlob) {
    window.openBGR.setView(VIEW_KEYS[e.key]);
  }
}

/** Window `keyup` handler: releasing Space ends the pan modifier. */
export function handleKeyup(e) {
  if (e.code === "Space") {
    state.spacePressed = false;
  }
}

/** Wires the window keyboard handlers. */
export function initKeyboard() {
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("keyup", handleKeyup);
  // Losing focus while Space is held never delivers keyup; without this the
  // pan modifier stays armed until the next keyup.
  window.addEventListener("blur", () => {
    state.spacePressed = false;
  });
}
