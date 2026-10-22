/**
 * Stage pointer input: wheel/trackpad zoom and pan, WebKit pinch gestures,
 * middle/space-drag panning, split-view dragging, loupe tracking, and the
 * touch equivalents.
 * Importing this module has no side effects; app.js calls `initStageInput()`.
 */

import { state, dom, saveStateToActiveTab } from "./state.js";
import {
  setZoom,
  applyZoomTransform,
  renderLoupeAtPointer,
  handleSplitDrag,
} from "./stage.js";

/**
 * Viewport wheel: two-finger scroll pans the zoomed stage, while pinch
 * (ctrlKey wheel) or Cmd/Ctrl+wheel zooms (Figma/Maps convention).
 */
export function handleViewportWheel(e) {
  if (!state.sourceFile) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    // Trackpad pinch arrives as wheel events with ctrlKey set.
    setZoom(state.zoom * Math.exp(-e.deltaY * 0.01));
  } else {
    state.panX -= e.deltaX;
    state.panY -= e.deltaY;
    applyZoomTransform();
  }
  renderLoupeAtPointer(e.clientX, e.clientY);
}

// WebKit pinch gestures (WKWebView delivers GestureEvent instead of ctrlKey
// wheel events) zoom relative to the zoom level at gesture start.
let gestureStartZoom = 1;

export function handleGestureStart(e) {
  if (!state.sourceFile) return;
  e.preventDefault();
  gestureStartZoom = state.zoom;
}

export function handleGestureChange(e) {
  if (!state.sourceFile) return;
  e.preventDefault();
  setZoom(gestureStartZoom * e.scale);
}

/** Middle/right/space-drag starts panning; left-drag in split moves the divider. */
export function handleStageMouseDown(e) {
  if (
    state.zoom > 1 &&
    (e.button === 1 ||
      e.button === 2 ||
      state.spacePressed ||
      state.viewMode !== "split")
  ) {
    e.preventDefault();
    state.isPanning = true;
    state.panStartX = e.clientX - state.panX;
    state.panStartY = e.clientY - state.panY;
    dom.stage.classList.add("panning");
    return;
  }
  if (e.button === 0 && state.viewMode === "split" && !state.loupeEnabled) {
    state.isDraggingSplit = true;
    handleSplitDrag(e.clientX);
  }
}

/** Window mousemove: applies pan, split drags, and loupe tracking. */
export function handleWindowMouseMove(e) {
  // Releasing the button outside the window never delivers mouseup, so a
  // latched drag flag would keep panning/splitting with no button held.
  if (e.buttons === 0 && (state.isPanning || state.isDraggingSplit)) {
    state.isPanning = false;
    state.isDraggingSplit = false;
    dom.stage.classList.remove("panning");
  }
  if (state.isPanning) {
    state.panX = e.clientX - state.panStartX;
    state.panY = e.clientY - state.panStartY;
    applyZoomTransform();
    return;
  }
  handleSplitDrag(e.clientX);
  if (state.loupeEnabled) {
    renderLoupeAtPointer(e.clientX, e.clientY);
  }
}

export function handleStageMouseLeave() {
  dom.loupeCanvas?.classList.remove("visible");
}

export function handleWindowMouseUp() {
  if (state.isPanning) {
    state.isPanning = false;
    dom.stage.classList.remove("panning");
  }
  state.isDraggingSplit = false;
  saveStateToActiveTab();
}

export function handleStageTouchStart(e) {
  if (state.viewMode !== "split" || state.loupeEnabled) return;
  state.isDraggingSplit = true;
  if (e.touches[0]) handleSplitDrag(e.touches[0].clientX);
}

export function handleWindowTouchMove(e) {
  if (state.isDraggingSplit && e.touches[0]) {
    handleSplitDrag(e.touches[0].clientX);
  }
}

export function handleWindowTouchEnd() {
  state.isDraggingSplit = false;
  saveStateToActiveTab();
}

/** Wires all stage pointer, gesture, and touch handlers. */
export function initStageInput() {
  dom.viewport.addEventListener("wheel", handleViewportWheel, {
    passive: false,
  });
  dom.viewport.addEventListener("gesturestart", handleGestureStart);
  dom.viewport.addEventListener("gesturechange", handleGestureChange);

  dom.stage.addEventListener("dblclick", () => setZoom(1));
  dom.stage.addEventListener("contextmenu", (e) => {
    if (state.zoom > 1) e.preventDefault();
  });
  dom.stage.addEventListener("mousedown", handleStageMouseDown);
  dom.stage.addEventListener("mouseleave", handleStageMouseLeave);
  dom.stage.addEventListener("touchstart", handleStageTouchStart, {
    passive: true,
  });

  window.addEventListener("mousemove", handleWindowMouseMove);
  window.addEventListener("mouseup", handleWindowMouseUp);
  window.addEventListener("touchmove", handleWindowTouchMove, {
    passive: true,
  });
  window.addEventListener("touchend", handleWindowTouchEnd);
}
