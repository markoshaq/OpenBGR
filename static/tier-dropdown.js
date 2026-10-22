/**
 * Model dropdown in the left sidebar: the collapsed trigger mirrors the active
 * tier card, and each card selects (or right-click manages) its model.
 * Importing this module has no side effects; app.js calls `initTierDropdown()`.
 */

import { state, dom } from "./state.js";
import { showModelContextMenu } from "./preferences.js";
import { selectTier } from "./tabs.js";

/** Copies the active (or first) tier card's label and tech line to the trigger. */
export function syncTierDropdownTrigger() {
  const active =
    document.querySelector("#tierSelector .tier-btn.active") ||
    document.querySelector("#tierSelector .tier-btn");
  if (!active) return;
  if (dom.tierDropdownLabel) {
    dom.tierDropdownLabel.textContent =
      active.querySelector(".tier-label")?.textContent || "";
  }
  if (dom.tierDropdownTech) {
    dom.tierDropdownTech.textContent =
      active.querySelector(".tier-tech")?.textContent || "";
  }
}

/** True while the tier option list is expanded. */
export function isTierDropdownOpen() {
  return Boolean(dom.tierDropdown?.classList.contains("open"));
}

/** Expands or collapses the option list and mirrors it on aria-expanded. */
export function setTierDropdownOpen(open) {
  dom.tierDropdown?.classList.toggle("open", open);
  dom.tierDropdownBtn?.setAttribute("aria-expanded", String(open));
}

/** Document click: collapses the list unless the click landed on the dropdown or its popups. */
export function handleTierDropdownOutsideClick(e) {
  if (
    isTierDropdownOpen() &&
    !e.target.closest("#tierDropdown, #tabContextMenu, #confirmModal")
  ) {
    setTierDropdownOpen(false);
  }
}

/** Tier card click: switches models only when the card is not already active. */
export function handleTierCardClick(tierKey) {
  if (tierKey && tierKey !== state.tier) selectTier(tierKey);
}

/** Wires the trigger, the option cards, outside-click collapse, and the mirror observer. */
export function initTierDropdown() {
  dom.tierDropdownBtn?.addEventListener("click", () => {
    setTierDropdownOpen(!isTierDropdownOpen());
  });

  // A chosen option collapses the list; the card's own handler still runs.
  dom.tierDropdown?.addEventListener("click", (e) => {
    if (e.target.closest("#tierSelector .tier-btn")) setTierDropdownOpen(false);
  });

  document.addEventListener("click", handleTierDropdownOutsideClick);

  // Keeps the mirror synced with .active and dot-class changes made elsewhere
  // (tab restore, server-status updates, downloads).
  new MutationObserver(syncTierDropdownTrigger).observe(
    document.getElementById("tierSelector"),
    {
      attributes: true,
      attributeFilter: ["class"],
      childList: true,
      characterData: true,
      subtree: true,
    }
  );
  syncTierDropdownTrigger();

  document.querySelectorAll("#tierSelector .tier-btn").forEach((btn) => {
    btn.addEventListener("click", () =>
      handleTierCardClick(btn.getAttribute("data-tier"))
    );
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const targetTier = btn.getAttribute("data-tier");
      if (targetTier) showModelContextMenu(targetTier, e.clientX, e.clientY);
    });
  });
}
