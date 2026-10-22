/**
 * Node unit tests for static/tooltips.js: viewport placement math and the
 * hover/dismiss behavior of the shared floating tooltip.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims, FakeElement } from "./dom-shim.mjs";

installDomShims();

const { placeTooltip, createTooltip } = await import("../static/tooltips.js");

const rect = (left, top, width, height) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

test("placeTooltip centers below the host", () => {
  const pos = placeTooltip(rect(100, 100, 40, 20), rect(0, 0, 60, 10), 800, 600);
  assert.deepEqual(pos, { left: 90, top: 126 });
});

test("placeTooltip flips above when the bottom would overflow", () => {
  const pos = placeTooltip(rect(100, 570, 40, 20), rect(0, 0, 60, 30), 800, 600);
  assert.equal(pos.top, 570 - 30 - 6);
});

test("placeTooltip clamps inside the viewport margins", () => {
  const left = placeTooltip(rect(0, 100, 10, 10), rect(0, 0, 200, 10), 800, 600);
  assert.equal(left.left, 8);
  const right = placeTooltip(rect(790, 100, 10, 10), rect(0, 0, 200, 10), 800, 600);
  assert.equal(right.left, 800 - 200 - 8);
});

function hostWithTip(text) {
  const host = new FakeElement("button");
  host.setAttribute("data-tooltip", text);
  host.getBoundingClientRect = () => rect(300, 200, 50, 20);
  const child = new FakeElement("span");
  host.appendChild(child);
  document.body.appendChild(host);
  return { host, child };
}

test("hovering a [data-tooltip] descendant shows and positions the tip", () => {
  const tip = createTooltip();
  const { child } = hostWithTip("Open image");
  tip.onMouseOver({ target: child });
  const el = tip.element;
  assert.ok(el, "tip element is created on first show");
  assert.equal(el.parentElement, document.body);
  assert.equal(el.getAttribute("role"), "tooltip");
  assert.equal(el.textContent, "Open image");
  assert.ok(el.classList.contains("visible"));
  // Default shim rect is 100x100: centered under a 50px host at x=300.
  assert.equal(el.style.left, "275px");
  assert.equal(el.style.top, "226px");
});

test("leaving tooltip hosts or pressing Escape hides the tip", () => {
  const tip = createTooltip();
  const { host } = hostWithTip("Zoom");
  tip.onMouseOver({ target: host });
  assert.ok(tip.element.classList.contains("visible"));

  tip.onMouseOver({ target: new FakeElement("div") });
  assert.ok(!tip.element.classList.contains("visible"));

  tip.onMouseOver({ target: host });
  tip.onKeydown({ key: "a" });
  assert.ok(tip.element.classList.contains("visible"));
  tip.onKeydown({ key: "Escape" });
  assert.ok(!tip.element.classList.contains("visible"));
});

test("hide before any hover is a no-op", () => {
  const tip = createTooltip();
  tip.hide();
  assert.equal(tip.element, null);
});
