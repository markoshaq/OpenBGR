/**
 * Node unit tests for static/modals.js: confirm/alt callbacks, backdrop and
 * outside-click dismissal, and the busy cancel button wiring.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims, FakeElement } from "./dom-shim.mjs";
import { wireRealTabOps } from "./workspace-deps.mjs";

installDomShims();
await wireRealTabOps();
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

const { state, dom, openConfirmModal } = await import("../static/state.js");
await import("../static/batch.js"); // subscribes "context-menu:hide" on the bus
const {
  runPendingConfirm,
  runPendingAlt,
  dismissContextMenuOnOutsideClick,
  dismissConfirmOnBackdropClick,
} = await import("../static/modals.js");

function reset() {
  state.pendingConfirmFn = null;
  state.pendingAltFn = null;
  state.isProcessing = false;
  state.abortController = null;
  dom.confirmModal.classList.remove("active");
  dom.tabContextMenu.style.display = "block";
}

test("confirm runs the stashed callback after closing the modal", () => {
  reset();
  let ran = 0;
  openConfirmModal("Sure?", () => (ran += 1));
  assert.ok(dom.confirmModal.classList.contains("active"));

  runPendingConfirm();
  assert.equal(ran, 1);
  assert.ok(!dom.confirmModal.classList.contains("active"));
  assert.equal(state.pendingConfirmFn, null);
});

test("alt runs the alt callback; cancel never runs either", () => {
  reset();
  let confirmRan = 0;
  let altRan = 0;
  openConfirmModal(
    { message: "Pick", altText: "OTHER", altFn: () => (altRan += 1) },
    () => (confirmRan += 1)
  );
  runPendingAlt();
  assert.deepEqual([confirmRan, altRan], [0, 1]);
  assert.ok(!dom.confirmModal.classList.contains("active"));

  runPendingConfirm();
  assert.equal(confirmRan, 0, "pending callbacks were dropped on close");
});

test("backdrop click dismisses; clicks inside the modal do not", () => {
  reset();
  dom.confirmModal.classList.add("active");
  const inner = new FakeElement("button");
  dom.confirmModal.appendChild(inner);

  dismissConfirmOnBackdropClick({ target: inner });
  assert.ok(dom.confirmModal.classList.contains("active"));

  dismissConfirmOnBackdropClick({ target: dom.confirmModal });
  assert.ok(!dom.confirmModal.classList.contains("active"));
  inner.remove();
});

test("outside clicks hide the context menu; clicks inside it stay", () => {
  reset();
  const inner = new FakeElement("button");
  dom.tabContextMenu.appendChild(inner);

  dismissContextMenuOnOutsideClick({ target: inner });
  assert.equal(dom.tabContextMenu.style.display, "block");

  dismissContextMenuOnOutsideClick({ target: new FakeElement("div") });
  assert.equal(dom.tabContextMenu.style.display, "none");
  inner.remove();
});
