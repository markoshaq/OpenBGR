/**
 * Node unit tests for static/stage-input.js: wheel pan/zoom, WebKit gestures,
 * middle/space-drag panning, split dragging, touch handling, and latch release.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims } from "./dom-shim.mjs";

installDomShims();

const { state, dom } = await import("../static/state.js");
const {
  handleViewportWheel,
  handleGestureStart,
  handleGestureChange,
  handleStageMouseDown,
  handleWindowMouseMove,
  handleStageMouseLeave,
  handleWindowMouseUp,
  handleStageTouchStart,
  handleWindowTouchMove,
  handleWindowTouchEnd,
} = await import("../static/stage-input.js");

const png = () => new File(["x"], "a.png", { type: "image/png" });

function reset() {
  state.sourceFile = png();
  state.zoom = 2;
  state.panX = 0;
  state.panY = 0;
  state.panStartX = 0;
  state.panStartY = 0;
  state.isPanning = false;
  state.isDraggingSplit = false;
  state.spacePressed = false;
  state.viewMode = "split";
  state.loupeEnabled = false;
  state.splitPercent = 50;
  dom.stage.classList.remove("panning");
  dom.loupeCanvas.classList.add("visible");
}

const wheel = (o = {}) => ({ preventDefault() {}, deltaX: 0, deltaY: 0, clientX: 0, clientY: 0, ...o });

test("wheel pans on scroll and zooms on ctrl/pinch", () => {
  reset();
  handleViewportWheel(wheel({ deltaX: 10, deltaY: -20 }));
  assert.equal(state.panX, -10);
  assert.equal(state.panY, 20);
  assert.equal(state.zoom, 2);

  handleViewportWheel(wheel({ ctrlKey: true, deltaY: -100 }));
  assert.ok(state.zoom > 2, "pinch-out zooms in");

  handleViewportWheel(wheel({ metaKey: true, deltaY: 100 }));
  assert.ok(state.zoom <= 2, "Cmd+wheel-down zooms out");
});

test("wheel does nothing without an image", () => {
  reset();
  state.sourceFile = null;
  handleViewportWheel(wheel({ deltaX: 10 }));
  assert.equal(state.panX, 0);
});

test("WebKit gestures zoom relative to the gesture-start zoom", () => {
  reset();
  handleGestureStart({ preventDefault() {} });
  state.zoom = 3; // user changed zoom before the change event arrives
  handleGestureChange({ preventDefault() {}, scale: 1.5 });
  assert.equal(state.zoom, 3, "gesture uses the start zoom, not current");
});

test("middle-drag starts panning; left-drag in split starts a split drag", () => {
  reset();
  handleStageMouseDown({ button: 1, clientX: 30, clientY: 40, preventDefault() {} });
  assert.equal(state.isPanning, true);
  assert.equal(state.panStartX, 30);
  assert.equal(state.panStartY, 40);
  assert.ok(dom.stage.classList.contains("panning"));

  reset();
  handleStageMouseDown({ button: 0, clientX: 50, preventDefault() {} });
  assert.equal(state.isDraggingSplit, true);
  assert.equal(state.isPanning, false);

  reset();
  state.viewMode = "original";
  handleStageMouseDown({ button: 0, clientX: 50, preventDefault() {} });
  assert.equal(state.isDraggingSplit, false, "left-drag pans outside split only via space");
});

test("space or right-drag pans even at split view", () => {
  reset();
  state.spacePressed = true;
  handleStageMouseDown({ button: 0, clientX: 5, clientY: 5, preventDefault() {} });
  assert.equal(state.isPanning, true);

  reset();
  handleStageMouseDown({ button: 2, clientX: 5, clientY: 5, preventDefault() {} });
  assert.equal(state.isPanning, true);
});

test("mousemove applies pan and releases latches when buttons drop", () => {
  reset();
  state.isPanning = true;
  state.panStartX = 100;
  state.panStartY = 50;
  handleWindowMouseMove({ clientX: 110, clientY: 60, buttons: 1 });
  assert.equal(state.panX, 10);
  assert.equal(state.panY, 10);

  handleWindowMouseMove({ clientX: 0, clientY: 0, buttons: 0 });
  assert.equal(state.isPanning, false, "released outside the window unlatches");
  assert.ok(!dom.stage.classList.contains("panning"));
});

test("split drag follows the pointer", () => {
  reset();
  dom.stage.getBoundingClientRect = () => ({ left: 0, right: 200, top: 0, bottom: 100, width: 200, height: 100 });
  state.isDraggingSplit = true;
  handleWindowMouseMove({ clientX: 150, buttons: 1 });
  assert.equal(state.splitPercent, 75);
});

test("mouseup ends pan/split and leaves the loupe hides on mouseleave", () => {
  reset();
  state.isPanning = true;
  state.isDraggingSplit = true;
  handleWindowMouseUp();
  assert.equal(state.isPanning, false);
  assert.equal(state.isDraggingSplit, false);
  assert.ok(!dom.stage.classList.contains("panning"));

  handleStageMouseLeave();
  assert.ok(!dom.loupeCanvas.classList.contains("visible"));
});

test("touch drag moves the split; touchend clears the drag", () => {
  reset();
  dom.stage.getBoundingClientRect = () => ({ left: 0, right: 200, top: 0, bottom: 100, width: 200, height: 100 });
  handleStageTouchStart({ touches: [{ clientX: 100 }] });
  assert.equal(state.isDraggingSplit, true);

  handleWindowTouchMove({ touches: [{ clientX: 50 }] });
  assert.equal(state.splitPercent, 25);

  handleWindowTouchEnd();
  assert.equal(state.isDraggingSplit, false);

  reset();
  state.viewMode = "cutout";
  handleStageTouchStart({ touches: [{ clientX: 100 }] });
  assert.equal(state.isDraggingSplit, false, "touch split only in split view");
});
