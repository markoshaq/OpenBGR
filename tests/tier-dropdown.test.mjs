/**
 * Node unit tests for static/tier-dropdown.js: the trigger mirror, open/close
 * state, outside-click collapse, and tier card selection.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims, FakeElement } from "./dom-shim.mjs";

installDomShims();

const { state, dom } = await import("../static/state.js");
const {
  syncTierDropdownTrigger,
  isTierDropdownOpen,
  setTierDropdownOpen,
  handleTierDropdownOutsideClick,
  handleTierCardClick,
} = await import("../static/tier-dropdown.js");

const selector = document.getElementById("tierSelector");
dom.tierDropdown.appendChild(selector);

function tierCard(key, label, tech) {
  const btn = new FakeElement("button");
  btn.classList.add("tier-btn");
  btn.setAttribute("data-tier", key);
  const l = new FakeElement("span");
  l.classList.add("tier-label");
  l.textContent = label;
  const t = new FakeElement("span");
  t.classList.add("tier-tech");
  t.textContent = tech;
  btn.append(l, t);
  selector.appendChild(btn);
  return btn;
}

const lite = tierCard("lite", "LITE", "U2NETP");
const general = tierCard("general", "GENERAL", "BIREFNET");

test("syncTierDropdownTrigger mirrors the active card, else the first", () => {
  syncTierDropdownTrigger();
  assert.equal(dom.tierDropdownLabel.textContent, "LITE");
  assert.equal(dom.tierDropdownTech.textContent, "U2NETP");

  general.classList.add("active");
  syncTierDropdownTrigger();
  assert.equal(dom.tierDropdownLabel.textContent, "GENERAL");
  assert.equal(dom.tierDropdownTech.textContent, "BIREFNET");
  general.classList.remove("active");
});

test("setTierDropdownOpen toggles the class and aria-expanded", () => {
  setTierDropdownOpen(true);
  assert.equal(isTierDropdownOpen(), true);
  assert.equal(dom.tierDropdownBtn.getAttribute("aria-expanded"), "true");
  setTierDropdownOpen(false);
  assert.equal(isTierDropdownOpen(), false);
  assert.equal(dom.tierDropdownBtn.getAttribute("aria-expanded"), "false");
});

test("outside clicks collapse the list; clicks inside or on popups do not", () => {
  setTierDropdownOpen(true);
  handleTierDropdownOutsideClick({ target: lite });
  assert.equal(isTierDropdownOpen(), true, "inside the dropdown");

  const popupChild = new FakeElement("button");
  dom.confirmModal.appendChild(popupChild);
  handleTierDropdownOutsideClick({ target: popupChild });
  assert.equal(isTierDropdownOpen(), true, "inside the confirm modal");

  const elsewhere = new FakeElement("div");
  document.body.appendChild(elsewhere);
  handleTierDropdownOutsideClick({ target: elsewhere });
  assert.equal(isTierDropdownOpen(), false);
});

test("handleTierCardClick selects a new tier and ignores the active one", () => {
  state.tier = "general";
  handleTierCardClick("lite");
  assert.equal(state.tier, "lite");
  assert.ok(lite.classList.contains("active"));
  assert.ok(!general.classList.contains("active"));

  lite.classList.remove("active");
  handleTierCardClick("lite");
  assert.ok(!lite.classList.contains("active"), "no reselect of the active tier");
  handleTierCardClick(null);
  assert.equal(state.tier, "lite");
});
