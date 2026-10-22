/**
 * Open Recent modal (desktop mode): persisted file paths served by the bridge.
 * Importing this module has no side effects; app.js calls `initRecent()`.
 */

import { dom, setError, filesFromDialogResult } from "./state.js";
import { ingestWithConfirm } from "./clipboard.js";

/** True while the Open Recent modal is showing. */
export function isRecentModalOpen() {
  return Boolean(dom.recentModal?.classList.contains("active"));
}

/** Closes the Open Recent modal. */
export function closeRecentModal() {
  dom.recentModal?.classList.remove("active");
}

/** Repaints the recent-files list; each row opens that path through the bridge. */
export function renderRecentList(files) {
  if (!dom.recentList) return;
  dom.recentList.replaceChildren();
  if (!files.length) {
    const empty = document.createElement("div");
    empty.className = "recent-empty";
    empty.textContent = "NO RECENT FILES";
    dom.recentList.appendChild(empty);
    return;
  }
  files.forEach((f) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "recent-item";
    b.title = f.path;
    const name = document.createElement("span");
    name.textContent = f.name;
    const path = document.createElement("span");
    path.className = "recent-path";
    path.textContent = ` — ${f.display || f.path}`;
    b.append(name, path);
    b.addEventListener("click", () => openRecentEntry(f.path));
    dom.recentList.appendChild(b);
  });
}

/** Opens the Open Recent modal with a freshly fetched list. */
export async function openRecentDialog() {
  if (!window.pywebview?.api?.get_recent_files || !dom.recentModal) return;
  try {
    const res = await window.pywebview.api.get_recent_files();
    renderRecentList(res?.files || []);
    dom.recentModal.classList.add("active");
  } catch (err) {
    console.warn("[OpenBGR] Recent files lookup failed:", err);
  }
}

/** Grants a recent-file path through the bridge and ingests it into a tab. */
export async function openRecentEntry(path) {
  try {
    const res = await window.pywebview.api.open_recent_file(path);
    const files = await filesFromDialogResult(res);
    if (!files.length) {
      setError(res?.error || "File is no longer available.");
      openRecentDialog();
      return;
    }
    closeRecentModal();
    ingestWithConfirm(files[0]);
  } catch (_) {
    setError("Could not open the recent file.");
  }
}

/** Forgets every recent file on the bridge and empties the list. */
export async function clearRecentFiles() {
  try {
    await window.pywebview?.api?.clear_recent_files?.();
  } catch (_) {}
  renderRecentList([]);
}

/** Wires the modal's close, clear, and backdrop-click controls. */
export function initRecent() {
  dom.recentClose?.addEventListener("click", closeRecentModal);
  dom.recentClear?.addEventListener("click", clearRecentFiles);
  dom.recentModal?.addEventListener("click", (e) => {
    if (e.target === dom.recentModal) closeRecentModal();
  });
}
