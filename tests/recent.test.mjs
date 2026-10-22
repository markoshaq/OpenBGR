/**
 * Node unit tests for static/recent.js: list rendering, opening the modal
 * through the bridge, opening and clearing entries.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims } from "./dom-shim.mjs";

installDomShims();
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

const { state, dom } = await import("../static/state.js");
const {
  isRecentModalOpen,
  closeRecentModal,
  renderRecentList,
  openRecentDialog,
  openRecentEntry,
  clearRecentFiles,
} = await import("../static/recent.js");

const b64 = Buffer.from("img").toString("base64");

function reset() {
  state.tabs = [];
  state.activeTabId = null;
  state.sourceFile = null;
  state.isProcessing = false;
  dom.recentModal.classList.remove("active");
  dom.recentList.replaceChildren();
  dom.errorToast.textContent = "";
  delete window.pywebview;
}

test("renderRecentList shows a placeholder for an empty list", () => {
  reset();
  renderRecentList([]);
  const [only] = dom.recentList.children;
  assert.equal(dom.recentList.children.length, 1);
  assert.equal(only.className, "recent-empty");
  assert.equal(only.textContent, "NO RECENT FILES");
});

test("renderRecentList builds one button per file with name and path", () => {
  reset();
  renderRecentList([
    { name: "a.png", path: "/x/a.png", display: "~/x/a.png" },
    { name: "b.png", path: "/x/b.png" },
  ]);
  const rows = dom.recentList.children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].className, "recent-item");
  assert.equal(rows[0].title, "/x/a.png");
  assert.equal(rows[0].children[0].textContent, "a.png");
  assert.match(rows[0].children[1].textContent, /~\/x\/a\.png$/);
  assert.match(rows[1].children[1].textContent, /\/x\/b\.png$/);
});

test("openRecentDialog needs the bridge, then fills and shows the modal", async () => {
  reset();
  await openRecentDialog();
  assert.equal(isRecentModalOpen(), false);

  window.pywebview = {
    api: { get_recent_files: async () => ({ files: [{ name: "a.png", path: "/a.png" }] }) },
  };
  await openRecentDialog();
  assert.equal(isRecentModalOpen(), true);
  assert.equal(dom.recentList.children.length, 1);

  closeRecentModal();
  assert.equal(isRecentModalOpen(), false);
});

test("openRecentEntry ingests the granted file and closes the modal", async () => {
  reset();
  const opened = [];
  window.pywebview = {
    api: {
      open_recent_file: async (path) => {
        opened.push(path);
        return { data_b64: b64, name: "a.png" };
      },
    },
  };
  dom.recentModal.classList.add("active");
  await openRecentEntry("/x/a.png");
  assert.deepEqual(opened, ["/x/a.png"]);
  assert.equal(isRecentModalOpen(), false);
  assert.equal(state.sourceFile.name, "a.png");
});

test("openRecentEntry reports a missing file and refreshes the list", async () => {
  reset();
  let refreshed = 0;
  window.pywebview = {
    api: {
      open_recent_file: async () => ({ error: "Gone." }),
      get_recent_files: async () => {
        refreshed += 1;
        return { files: [] };
      },
    },
  };
  await openRecentEntry("/x/gone.png");
  assert.match(dom.errorToast.textContent, /Gone\./);
  assert.equal(refreshed, 1);
  assert.equal(state.tabs.length, 0);

  window.pywebview.api.open_recent_file = async () => {
    throw new Error("boom");
  };
  await openRecentEntry("/x/a.png");
  assert.match(dom.errorToast.textContent, /could not open the recent file/i);
});

test("clearRecentFiles clears the bridge list even if the call fails", async () => {
  reset();
  let cleared = 0;
  window.pywebview = {
    api: {
      clear_recent_files: async () => {
        cleared += 1;
        throw new Error("boom");
      },
    },
  };
  renderRecentList([{ name: "a.png", path: "/a.png" }]);
  await clearRecentFiles();
  assert.equal(cleared, 1);
  assert.equal(dom.recentList.children[0].className, "recent-empty");
});
