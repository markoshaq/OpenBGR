/**
 * Preferences modal, appearance theming, model cache indicators, and
 * `/api/status` hardware capability synchronization.
 */

import {
  state,
  dom,
  prefs,
  apiFetch,
  apiErrorDetail,
  DOT_TOOLTIPS,
  TIER_KEYS,
  ACCENTS,
  normalizeTierKey,
  setError,
  setSuccess,
  openConfirmModal,
  createByteSmoother,
  updateTierDownloadUI,
  clearTierDownloadProgress,
  getTierDownloadText,
  formatDiskBytes,
} from "./state.js";

const PREFS_SECTION_MAP = {
  preferences: "settings-general",
  appearance: "settings-preferences",
  general: "settings-general",
  behavior: "settings-general",
  quickaction: "settings-quick-action",
  "quick-action": "settings-quick-action",
  models: "settings-models",
  storage: "settings-models",
  system: "settings-about",
  shortcuts: "settings-shortcuts",
  hotkeys: "settings-shortcuts",
  keyboard: "settings-shortcuts",
  about: "settings-about",
};

const MODEL_TECH_NAMES = {
  lite: "BiRefNet_lite",
  general: "BiRefNet",
  hr: "BiRefNet_HR",
  portrait: "BiRefNet-portrait",
  matting: "BiRefNet_HR-matting",
  dynamic: "BiRefNet_dynamic",
};

let installingModelKey = null;

/** True while a Settings/context-menu model install is in flight. */
export function isModelInstallInProgress() {
  return installingModelKey !== null;
}

/** Looks up the TIER registry entry for a model key. */
function getTierInfo(key) {
  const norm = normalizeTierKey(key);
  return state.serverStatus?.tiers?.[norm] || null;
}

/** True when the server-side offline switch blocks all Hugging Face traffic. */
export function serverOffline() {
  return Boolean(state.serverStatus?.offline_mode);
}

/** Resolves a model's install state to `{cached, repoId, sizeBytes}` from server status. */
function getTierAvailability(tierInfo) {
  if (tierInfo?.cached) return "ready";
  return navigator.onLine && !serverOffline() ? "downloadable" : "unavailable";
}

/** Paints a cache-indicator dot green (cached) or amber (on-demand) and sets its tooltip. */
function applyDotState(dotEl, status, allowTooltip = true) {
  if (!dotEl) return;
  dotEl.classList.remove("ready", "downloadable", "unavailable");
  dotEl.classList.add(status);
  if (!allowTooltip) {
    dotEl.removeAttribute("title");
    dotEl.removeAttribute("data-tooltip");
    return;
  }
  const tip = DOT_TOOLTIPS[status] || "";
  dotEl.setAttribute("data-tooltip", tip);
  dotEl.removeAttribute("title");
}

/** Refreshes every model card dot plus the Settings model inventory rows from server status. */
export function updateCacheIndicator() {
  const tiers = state.serverStatus?.tiers;
  if (!tiers) return;

  let installedCount = 0;
  let totalBytes = 0;

  TIER_KEYS.forEach((key) => {
    const tierInfo = tiers[key];
    const status = getTierAvailability(tierInfo);
    const sizeBytes = Number(tierInfo?.size_bytes) || 0;
    const expectedBytes = Number(tierInfo?.expected_bytes) || 0;
    const isInstalled = Boolean(tierInfo?.cached || sizeBytes > 0);
    if (isInstalled) installedCount++;
    totalBytes += sizeBytes;
    const sizeLabel = isInstalled ? formatDiskBytes(sizeBytes) : "0 MB";
    const techName = tierInfo?.tech_name || MODEL_TECH_NAMES[key] || key;

    applyDotState(document.getElementById(`dot-${key}`), status, true);

    const tierBtn = document.querySelector(
      `#tierSelector .tier-btn[data-tier="${key}"]`
    );
    tierBtn?.classList.toggle("uncached", !isInstalled);
    if (isInstalled) tierBtn?.style.removeProperty("--dl");

    const techEl = document.getElementById(`tech-${key}`);
    if (techEl) {
      techEl.dataset.name = techName;
      // Always show the download size so the label matches install progress;
      // installed disk footprint (FP16-compacted) lives in the Settings pane.
      const dlText = getTierDownloadText(key);
      const sizeText =
        dlText || (expectedBytes > 0 ? formatDiskBytes(expectedBytes, true) : "");
      techEl.textContent = sizeText ? `${techName} (${sizeText})` : techName;
    }

    const sizeEl = document.getElementById(`syssize-${key}`);
    if (sizeEl) {
      sizeEl.textContent = isInstalled
        ? sizeLabel
        : formatDiskBytes(expectedBytes);
      sizeEl.classList.toggle("dim", !isInstalled);
    }

    const uninstallBtn = document.getElementById(`sysbtn-${key}`);
    if (uninstallBtn) {
      if (isInstalled) {
        uninstallBtn.disabled =
          state.isProcessing || Boolean(installingModelKey);
        uninstallBtn.textContent = "UNINSTALL";
      } else {
        uninstallBtn.disabled = true;
        uninstallBtn.textContent =
          installingModelKey === key
            ? getTierDownloadText(key) || "0MB"
            : "NOT INSTALLED";
      }
    }
  });

  const serverTotal = state.serverStatus?.total_cache_bytes;
  const modelBytes = typeof serverTotal === "number" ? serverTotal : totalBytes;
  const appBytes = Number(state.serverStatus?.app_size_bytes) || 0;
  const totalDisk =
    Number(state.serverStatus?.total_disk_bytes) || modelBytes + appBytes;
  const totalSummary =
    appBytes > 0
      ? `${formatDiskBytes(totalDisk)} (${formatDiskBytes(appBytes)} APP + ${formatDiskBytes(modelBytes)} MODELS)`
      : `${formatDiskBytes(modelBytes)} (${installedCount} OF ${TIER_KEYS.length} INSTALLED)`;

  const totalEl = document.getElementById("modelsTotalSize");
  if (totalEl) totalEl.textContent = totalSummary;

  const cacheDirEl = document.getElementById("modelsCacheDir");
  if (cacheDirEl && state.serverStatus?.cache_dir) {
    cacheDirEl.textContent = state.serverStatus.cache_dir;
  }

  const uninstallAllBtn = document.getElementById("btnUninstallAllModels");
  if (uninstallAllBtn) {
    uninstallAllBtn.disabled =
      (installedCount === 0 && modelBytes === 0) || state.isProcessing;
    uninstallAllBtn.textContent = "UNINSTALL ALL";
  }
}

/** Opens the Hugging Face cache directory in the OS file manager via the API/native bridge. */
export async function openCacheFolder() {
  try {
    if (window.pywebview?.api?.open_cache_dir) {
      const res = await window.pywebview.api.open_cache_dir();
      if (res?.opened) return;
    }
    const response = await apiFetch("/api/open-cache-dir", { method: "POST" });
    if (!response.ok) {
      throw new Error("Could not open cache folder.");
    }
  } catch (err) {
    setError(err?.message || "Could not open cache folder.");
  }
}

/** Opens `~/.openbgr/` (containing `openbgr.log`) in the OS file manager. */
export async function openLogsFolder() {
  try {
    if (window.pywebview?.api?.open_logs_dir) {
      const res = await window.pywebview.api.open_logs_dir();
      if (res?.opened) return;
    }
    const response = await apiFetch("/api/open-logs-dir", { method: "POST" });
    if (!response.ok) {
      throw new Error("Could not open logs folder.");
    }
  } catch (err) {
    setError(err?.message || "Could not open logs folder.");
  }
}

/** Uninstalls a checkpoint via `/api/models/uninstall` and refreshes indicators/status. */
export async function uninstallModel(target) {
  if (state.isProcessing) {
    setError("Cannot uninstall model weights while processing is running.");
    return;
  }

  const btn =
    target === "all"
      ? document.getElementById("btnUninstallAllModels")
      : document.getElementById(`sysbtn-${target}`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = "REMOVING…";
  }

  const keys =
    target === "all" ? TIER_KEYS : [normalizeTierKey(target)];
  const tierBtns = keys
    .map((key) =>
      document.querySelector(`#tierSelector .tier-btn[data-tier="${key}"]`)
    )
    .filter(Boolean);
  tierBtns.forEach((tb) => {
    tb.classList.add("uninstalling");
    tb.classList.add("uncached");
  });

  try {
    const fd = new FormData();
    fd.append("target", target);
    const response = await apiFetch("/api/models/uninstall", {
      method: "POST",
      body: fd,
    });
    if (!response.ok) {
      throw new Error(await apiErrorDetail(response));
    }
    const payload = await response.json();
    if (payload?.status) {
      state.serverStatus = payload.status;
    }
    updateCacheIndicator();
  } catch (err) {
    setError(err?.message || "Failed to uninstall model weights.");
    updateCacheIndicator();
  } finally {
    // Keep `.uninstalling` long enough for the 1.1s drain animation to
    // complete even when the delete request finishes quickly.
    tierBtns.forEach((tb) =>
      setTimeout(() => tb.classList.remove("uninstalling"), 1150)
    );
  }
}

/** Downloads + compacts a checkpoint via `/api/models/install` and refreshes indicators/status. */
async function installModel(target) {
  if (state.isProcessing || installingModelKey) {
    setError("Another model operation is already in progress.");
    return;
  }
  if (serverOffline()) {
    setError(
      "Internet access is blocked. Import the checkpoint folder under Settings > Models."
    );
    return;
  }
  if (!navigator.onLine) {
    setError("Cannot install model weights while device is offline.");
    return;
  }

  const norm = normalizeTierKey(target);
  installingModelKey = norm;
  updateCacheIndicator();

  const smooth = createByteSmoother();
  let dlPeak = 0;
  const installPoll = setInterval(() => {
    apiFetch("/api/progress")
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => {
        if (!p || p.phase !== "download") return;
        const dl = Number(p.downloaded_bytes) || 0;
        const tot = Number(p.total_bytes) || 0;
        const shown = Math.max(smooth(dl, tot), dlPeak);
        dlPeak = shown;
        const expectedBytes =
          Number(state.serverStatus?.tiers?.[norm]?.expected_bytes) || 0;
        const sizeEl = document.getElementById(`syssize-${norm}`);
        if (sizeEl) {
          sizeEl.textContent =
            tot > 0
              ? `${formatDiskBytes(shown, true)} / ${formatDiskBytes(tot, true)}`
              : formatDiskBytes(shown, true);
        }
        updateTierDownloadUI(norm, shown, tot, expectedBytes);
      })
      .catch(() => {});
  }, 250);

  try {
    const fd = new FormData();
    fd.append("target", norm);
    const response = await apiFetch("/api/models/install", {
      method: "POST",
      body: fd,
    });
    if (!response.ok) {
      throw new Error(await apiErrorDetail(response));
    }
    const payload = await response.json();
    if (payload?.status) {
      state.serverStatus = payload.status;
    }
  } catch (err) {
    setError(err?.message || "Failed to install model weights.");
  } finally {
    clearInterval(installPoll);
    installingModelKey = null;
    clearTierDownloadProgress(norm);
    updateCacheIndicator();
  }
}

/** Builds the right-click menu for a model card (title, Install/Uninstall, Manage in Settings). */
export function showModelContextMenu(key, x, y) {
  const menu = dom.tabContextMenu;
  if (!menu) return;
  menu.replaceChildren();

  const norm = normalizeTierKey(key);
  const tierInfo = getTierInfo(norm);
  const sizeBytes = Number(tierInfo?.size_bytes) || 0;
  const expectedBytes = Number(tierInfo?.expected_bytes) || 0;
  const isInstalled = Boolean(tierInfo?.cached || sizeBytes > 0);
  const sizeNum = isInstalled && sizeBytes > 0 ? sizeBytes : expectedBytes;
  const compactSize = sizeNum > 0 ? formatDiskBytes(sizeNum, true) : null;
  const sizeSuffix = compactSize ? ` (${compactSize})` : "";
  const techName = tierInfo?.tech_name || MODEL_TECH_NAMES[norm] || norm;

  const head = document.createElement("div");
  head.className = "ctx-head";
  head.textContent = techName;
  menu.appendChild(head);

  const addItem = (label, fn, disabled = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `ctx-item${disabled ? " ctx-disabled" : ""}`;
    b.textContent = label;
    if (!disabled) {
      b.addEventListener("click", () => {
        menu.style.display = "none";
        fn();
      });
    }
    menu.appendChild(b);
  };

  const busy = state.isProcessing || Boolean(installingModelKey);
  if (isInstalled) {
    addItem(
      `Uninstall${sizeSuffix}`,
      () =>
        openConfirmModal(
          {
            title: `UNINSTALL ${String(techName).toUpperCase()}?`,
            message: `This deletes ${compactSize || "the cached model weights"} from disk. You will need to re-download the model to use it again.`,
            confirmText: "UNINSTALL",
            cancelText: "KEEP MODEL",
          },
          () => uninstallModel(norm)
        ),
      busy
    );
  } else {
    addItem(
      `Install${sizeSuffix}`,
      () => installModel(norm),
      busy || !navigator.onLine || serverOffline()
    );
    if (serverOffline()) {
      addItem("Import Model Folder…", () => openPrefsDialog("models"));
    }
  }

  const sep = document.createElement("div");
  sep.className = "ctx-sep";
  menu.appendChild(sep);

  addItem("Manage Models in Settings…", () => openPrefsDialog("models"));

  menu.style.display = "block";
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
}

/** Persists the current Quick Action preferences to `~/.openbgr/quick_action.json` via the server. */
export async function syncQuickActionConfigToServer() {
  try {
    const fd = new FormData();
    fd.append(
      "tier",
      prefs.qaTier && prefs.qaTier !== "auto" ? prefs.qaTier : "general"
    );
    fd.append("save_mode", prefs.qaSaveMode || "same_folder");
    fd.append("format", prefs.qaFormat || "png");
    fd.append("edge_refine", String(Boolean(prefs.qaEdgeRefine)));
    fd.append("copy_clipboard", String(Boolean(prefs.qaCopyClipboard)));
    fd.append("notify", String(Boolean(prefs.qaNotify)));
    const res = await apiFetch("/api/quick-action-config", {
      method: "POST",
      body: fd,
    });
    if (res.ok) {
      const qa = await res.json();
      if (state.serverStatus) {
        state.serverStatus.quick_action = qa;
      }
      updateQuickActionInstallStatus();
    }
  } catch (err) {
    console.warn("[OpenBGR] Quick Action config sync failed:", err);
  }
}

/** Updates the Quick Action system-integration status text and install/uninstall button. */
function updateQuickActionInstallStatus() {
  const qa = state.serverStatus?.quick_action;
  const installed = Boolean(qa?.installed);
  if (dom.btnQaInstallToggle) {
    dom.btnQaInstallToggle.disabled = false;
    dom.btnQaInstallToggle.textContent = installed ? "UNINSTALL" : "INSTALL";
  }
  if (dom.qaInstallStatusDesc) {
    dom.qaInstallStatusDesc.textContent = installed
      ? 'Installed ("Remove Background with OpenBGR" is active in your right-click menu).'
      : 'Adds "Remove Background with OpenBGR" when right-clicking one or more images.';
  }
}

/** Installs or removes the OS right-click Quick Action via `/api/quick-action-install`. */
export async function toggleQuickActionInstall() {
  const currentlyInstalled = Boolean(state.serverStatus?.quick_action?.installed);
  const action = currentlyInstalled ? "remove" : "install";
  if (dom.btnQaInstallToggle) {
    dom.btnQaInstallToggle.disabled = true;
    dom.btnQaInstallToggle.textContent = currentlyInstalled
      ? "REMOVING…"
      : "INSTALLING…";
  }
  try {
    const fd = new FormData();
    fd.append("action", action);
    const res = await apiFetch("/api/quick-action-install", {
      method: "POST",
      body: fd,
    });
    if (!res.ok) {
      throw new Error(await apiErrorDetail(res));
    }
    const payload = await res.json();
    if (payload?.quick_action && state.serverStatus) {
      state.serverStatus.quick_action = payload.quick_action;
    }
    updateQuickActionInstallStatus();
  } catch (err) {
    setError(err?.message || "Failed to update Quick Action integration.");
    updateQuickActionInstallStatus();
  }
}

/** Reflects the server-side offline switch onto the Settings toggle. */
export function updateOfflineModeUI() {
  const offline = serverOffline();
  const forced = Boolean(state.serverStatus?.offline_forced);
  if (dom.btnToggleOfflineMode) {
    dom.btnToggleOfflineMode.classList.toggle("active", offline);
    dom.btnToggleOfflineMode.disabled = forced;
  }
  if (dom.offlineModeDesc) {
    dom.offlineModeDesc.textContent = forced
      ? "Forced on by OPENBGR_OFFLINE / HF_HUB_OFFLINE environment variable. Restart without it to change."
      : "Never connect to Hugging Face. Checkpoints must be imported manually under Models.";
  }
}

/** Persists the offline-mode switch via `/api/settings` and refreshes model indicators. */
export async function toggleOfflineMode() {
  const next = !serverOffline();
  try {
    const fd = new FormData();
    fd.append("offline_mode", String(next));
    const res = await apiFetch("/api/settings", { method: "POST", body: fd });
    if (!res.ok) {
      throw new Error(await apiErrorDetail(res));
    }
    const payload = await res.json();
    if (state.serverStatus) {
      state.serverStatus.offline_mode = payload.offline_mode;
      state.serverStatus.offline_forced = payload.offline_forced;
    }
    updateOfflineModeUI();
    updateCacheIndicator();
  } catch (err) {
    setError(err?.message || "Failed to update offline mode.");
    updateOfflineModeUI();
  }
}

/** Opens the native folder picker (desktop only) and fills the import path field. */
export async function chooseImportFolder() {
  try {
    if (window.pywebview?.api?.choose_output_dir) {
      const res = await window.pywebview.api.choose_output_dir();
      if (res?.path && dom.importFolderPath) {
        dom.importFolderPath.value = res.path;
      } else if (res?.error) {
        setError(res.error);
      }
      return;
    }
    dom.importFolderPath?.focus();
    setError("Paste the model folder path into the field, then click IMPORT.");
  } catch {
    setError("Could not open the folder picker.");
  }
}

/** Copies a user-downloaded checkpoint folder into the HF cache via `/api/models/import`. */
export async function importModelFromFolder() {
  const target = dom.prefImportTier?.value || "general";
  const path = (dom.importFolderPath?.value || "").trim();
  if (!path) {
    setError("Choose the folder containing the downloaded checkpoint first.");
    return;
  }
  if (dom.btnImportModel) {
    dom.btnImportModel.disabled = true;
    dom.btnImportModel.textContent = "IMPORTING…";
  }
  try {
    const fd = new FormData();
    fd.append("target", target);
    fd.append("path", path);
    const res = await apiFetch("/api/models/import", {
      method: "POST",
      body: fd,
    });
    if (!res.ok) {
      throw new Error(await apiErrorDetail(res));
    }
    const payload = await res.json();
    if (payload?.status) {
      state.serverStatus = payload.status;
    }
    if (dom.importFolderPath) dom.importFolderPath.value = "";
    updateCacheIndicator();
    const name = MODEL_TECH_NAMES[target] || target;
    setSuccess(`${name} imported and ready to use.`);
  } catch (err) {
    setError(err?.message || "Failed to import model folder.");
  } finally {
    if (dom.btnImportModel) {
      dom.btnImportModel.disabled = false;
      dom.btnImportModel.textContent = "IMPORT";
    }
  }
}

/** Fetches `/api/status`, populates hardware/model/cache/system readouts, and syncs default model. */
export async function syncServerStatus(isInitialLoad = false, onSelectTier = null) {
  try {
    const response = await apiFetch("/api/status");
    state.serverStatus = await response.json();

    const { device_label, precision, ram_label, ram_gb, recommended_tier, version } =
      state.serverStatus;
    dom.hwCompute.textContent = (device_label || "LOCAL ENGINE").toUpperCase();
    if (dom.hwPrecision) dom.hwPrecision.textContent = (precision || "--").toUpperCase();
    if (dom.hwMemory) {
      const memText = ram_label || (ram_gb ? `${ram_gb} GB` : "--");
      dom.hwMemory.textContent = String(memText).toUpperCase();
    }
    const verLabel = version ? `V${version}` : "V--";
    if (dom.aboutVersion) dom.aboutVersion.textContent = verLabel;
    if (dom.statusVersion) dom.statusVersion.textContent = verLabel;

    if (isInitialLoad && onSelectTier) {
      const targetTier =
        prefs.defaultTier && prefs.defaultTier !== "auto"
          ? prefs.defaultTier
          : recommended_tier || "general";
      onSelectTier(targetTier);
    }
    if (isInitialLoad) {
      syncQuickActionConfigToServer();
    }
    updateQuickActionInstallStatus();
    updateOfflineModeUI();
    updateCacheIndicator();
  } catch (err) {
    console.warn("[OpenBGR] /api/status request failed:", err);
    dom.hwCompute.textContent = "LOCAL ENGINE";
  }
}

/** Activates a nav button + pane pair inside the Settings modal. */
export function selectPrefsPane(paneId) {
  dom.infoModal.querySelectorAll(".prefs-nav-item").forEach((item) => {
    item.classList.toggle("active", item.getAttribute("data-pane") === paneId);
  });
  dom.infoModal.querySelectorAll(".prefs-pane").forEach((pane) => {
    pane.classList.toggle("active", pane.id === paneId);
  });
}

let lastPrefsFocus = null;

/** Shows the Settings modal on a given pane (default: preferences). */
export function openPrefsDialog(section) {
  lastPrefsFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  dom.infoModal.classList.add("active");
  const paneId = PREFS_SECTION_MAP[section] || "settings-general";
  selectPrefsPane(paneId);
  dom.btnPrefsCloseX?.focus?.();
}

/** Dismisses the Settings modal and restores keyboard focus to the trigger. */
export function closePrefsDialog() {
  dom.infoModal.classList.remove("active");
  if (lastPrefsFocus && document.contains(lastPrefsFocus)) {
    lastPrefsFocus.focus?.();
  }
  lastPrefsFocus = null;
}

/** Pushes stored prefs into the live UI (theme, swatch, toggles, format, model selection). */
export function applyPreferences(onSyncMenu) {
  const root = document.documentElement;
  root.classList.toggle("theme-light", prefs.theme === "light");

  const accent = ACCENTS[prefs.accent];
  if (prefs.accent !== "default" && accent) {
    root.style.setProperty("--accent", accent[0]);
    root.style.setProperty("--accent-contrast", accent[1]);
  } else {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-contrast");
  }

  dom.prefThemeDark?.classList.toggle("active", prefs.theme !== "light");
  dom.prefThemeLight?.classList.toggle("active", prefs.theme === "light");
  document.querySelectorAll("#accentSwatches .swatch").forEach((s) => {
    s.classList.toggle("active", s.getAttribute("data-accent") === prefs.accent);
  });
  if (dom.prefDefaultTier) dom.prefDefaultTier.value = prefs.defaultTier || "auto";
  if (dom.prefDefaultFormat) dom.prefDefaultFormat.value = prefs.defaultFormat;
  if (dom.prefDefaultBackdrop) dom.prefDefaultBackdrop.value = prefs.defaultBackdrop;
  dom.btnToggleConfirmClose?.classList.toggle("active", prefs.confirmClose);

  if (dom.prefQaTier) {
    dom.prefQaTier.value =
      prefs.qaTier && prefs.qaTier !== "auto" ? prefs.qaTier : "general";
  }
  if (dom.prefQaSaveMode) dom.prefQaSaveMode.value = prefs.qaSaveMode || "same_folder";
  if (dom.prefQaFormat) dom.prefQaFormat.value = prefs.qaFormat || "png";
  dom.btnToggleQaEdgeRefine?.classList.toggle("active", Boolean(prefs.qaEdgeRefine));
  dom.btnToggleQaClipboard?.classList.toggle("active", Boolean(prefs.qaCopyClipboard));
  dom.btnToggleQaNotify?.classList.toggle("active", Boolean(prefs.qaNotify));

  try {
    window.pywebview?.api?.set_window_theme?.(prefs.theme);
  } catch (err) {
    console.warn("[OpenBGR] Native window theme sync failed:", err);
  }

  onSyncMenu?.();
}
