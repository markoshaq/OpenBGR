/**
 * Modal plumbing: the busy-overlay cancel button, the confirm modal's
 * confirm/cancel/alt buttons and backdrop click, and the outside-click
 * dismiss for the shared context menu.
 * Importing this module has no side effects; app.js calls `initModals()`.
 */

import {
  state,
  dom,
  closeConfirmModal,
  handleErrorToastCopy,
} from "./state.js";
import { cancelProcessing } from "./segmentation.js";
import { emit } from "./bus.js";

/** Confirm button: dismisses the modal, then runs the stashed confirm callback. */
export function runPendingConfirm() {
  const fn = state.pendingConfirmFn;
  closeConfirmModal();
  if (typeof fn === "function") fn();
}

/** Alt button: dismisses the modal, then runs the stashed alt callback. */
export function runPendingAlt() {
  const fn = state.pendingAltFn;
  closeConfirmModal();
  if (typeof fn === "function") fn();
}

/** Window click: hides the shared context menu when the click lands outside it. */
export function dismissContextMenuOnOutsideClick(e) {
  if (
    dom.tabContextMenu &&
    (!(e.target instanceof Node) || !dom.tabContextMenu.contains(e.target))
  ) {
    emit("context-menu:hide");
  }
}

/** Confirm modal backdrop click: only clicks on the backdrop itself dismiss. */
export function dismissConfirmOnBackdropClick(e) {
  if (e.target === dom.confirmModal) closeConfirmModal();
}

/** Wires the busy cancel button, confirm modal controls, toast copy, and context menu dismiss. */
export function initModals() {
  dom.btnCancel.addEventListener("click", cancelProcessing);
  dom.btnModalCancel.addEventListener("click", closeConfirmModal);
  dom.btnModalConfirm.addEventListener("click", runPendingConfirm);
  dom.btnModalAlt?.addEventListener("click", runPendingAlt);
  dom.confirmModal.addEventListener("click", dismissConfirmOnBackdropClick);
  dom.errorToast?.addEventListener("click", handleErrorToastCopy);
  dom.errorToast?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleErrorToastCopy();
    }
  });
  window.addEventListener("click", dismissContextMenuOnOutsideClick);
}
