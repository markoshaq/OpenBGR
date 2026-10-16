/**
 * Preferences modal, appearance theming, model cache indicators, and
 * `/api/status` hardware capability synchronization.
 */

import {
  state,
  dom,
  prefs,
  DOT_TOOLTIPS,
  TIER_KEYS,
  ACCENTS,
  normalizeTierKey,
  setError,
} from "./state.js";

const PREFS_SECTION_MAP = {
  preferences: "settings-preferences",
  appearance: "settings-preferences",
  general: "settings-general",
  behavior: "settings-general",
  models: "settings-models",
  storage: "settings-models",
  system: "settings-system",
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

const MODEL_EXPECTED_BYTES = {
  lite: 177669592,
  general: 444566476,
  hr: 444566476,
  portrait: 444566476,
  matting: 444566476,
  dynamic: 444566476,
};

let installingModelKey = null;

export function formatDiskBytes(bytes, compact = false) {
  const n = Number(bytes) || 0;
  const sp = compact ? "" : " ";
  if (n <= 0) return `0${sp}MB`;
  const gb = n / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)}${sp}GB`;
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)}${sp}MB`;
  return `${Math.max(1, Math.round(n / 1024))}${sp}KB`;
}

function getTierInfo(key) {
  const norm = normalizeTierKey(key);
  return state.serverStatus?.tiers?.[norm] || null;
}

function getTierAvailability(tierInfo) {
  if (tierInfo?.cached) return "ready";
  return navigator.onLine ? "downloadable" : "unavailable";
}

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
  if (dotEl.classList.contains("has-tooltip") || dotEl.closest(".has-tooltip")) {
    dotEl.removeAttribute("title");
  } else {
    dotEl.setAttribute("title", tip);
  }
}

export function updateCacheIndicator() {
  const tiers = state.serverStatus?.tiers;
  if (!tiers) return;

  let installedCount = 0;
  let totalBytes = 0;

  TIER_KEYS.forEach((key) => {
    const tierInfo = tiers[key];
    const status = getTierAvailability(tierInfo);
    const sizeBytes = Number(tierInfo?.size_bytes) || 0;
    const expectedBytes =
      Number(tierInfo?.expected_bytes) || MODEL_EXPECTED_BYTES[key] || 0;
    const isInstalled = Boolean(tierInfo?.cached || sizeBytes > 0);
    if (isInstalled) installedCount++;
    totalBytes += sizeBytes;
    const sizeLabel = isInstalled ? formatDiskBytes(sizeBytes) : "0 MB";
    const compactSize = formatDiskBytes(
      isInstalled && sizeBytes > 0 ? sizeBytes : expectedBytes,
      true
    );
    const techName = tierInfo?.tech_name || MODEL_TECH_NAMES[key] || key;

    applyDotState(document.getElementById(`dot-${key}`), status, false);
    applyDotState(document.getElementById(`sysdot-${key}`), status, true);

    const techEl = document.getElementById(`tech-${key}`);
    if (techEl) {
      techEl.textContent =
        installingModelKey === key
          ? `${techName} (Installing…)`
          : `${techName} (${compactSize})`;
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
          installingModelKey === key ? "INSTALLING…" : "NOT INSTALLED";
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

export async function openCacheFolder() {
  try {
    if (window.pywebview?.api?.open_cache_dir) {
      const res = await window.pywebview.api.open_cache_dir();
      if (res?.opened) return;
    }
    const response = await fetch("/api/open-cache-dir", { method: "POST" });
    if (!response.ok) {
      throw new Error("Could not open cache folder.");
    }
  } catch (err) {
    setError(err?.message || "Could not open cache folder.");
  }
}

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

  try {
    const fd = new FormData();
    fd.append("target", target);
    const response = await fetch("/api/models/uninstall", {
      method: "POST",
      body: fd,
    });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        if (err?.detail) detail = err.detail;
      } catch (_) {}
      throw new Error(detail);
    }
    const payload = await response.json();
    if (payload?.status) {
      state.serverStatus = payload.status;
    }
    updateCacheIndicator();
  } catch (err) {
    setError(err?.message || "Failed to uninstall model weights.");
    updateCacheIndicator();
  }
}

export async function installModel(target) {
  if (state.isProcessing || installingModelKey) {
    setError("Another model operation is already in progress.");
    return;
  }
  if (!navigator.onLine) {
    setError("Cannot install model weights while device is offline.");
    return;
  }

  const norm = normalizeTierKey(target);
  installingModelKey = norm;
  updateCacheIndicator();

  try {
    const fd = new FormData();
    fd.append("target", norm);
    const response = await fetch("/api/models/install", {
      method: "POST",
      body: fd,
    });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        if (err?.detail) detail = err.detail;
      } catch (_) {}
      throw new Error(detail);
    }
    const payload = await response.json();
    if (payload?.status) {
      state.serverStatus = payload.status;
    }
  } catch (err) {
    setError(err?.message || "Failed to install model weights.");
  } finally {
    installingModelKey = null;
    updateCacheIndicator();
  }
}

export function showModelContextMenu(key, x, y) {
  const menu = dom.tabContextMenu;
  if (!menu) return;
  menu.innerHTML = "";

  const norm = normalizeTierKey(key);
  const tierInfo = getTierInfo(norm);
  const sizeBytes = Number(tierInfo?.size_bytes) || 0;
  const expectedBytes =
    Number(tierInfo?.expected_bytes) || MODEL_EXPECTED_BYTES[norm] || 0;
  const isInstalled = Boolean(tierInfo?.cached || sizeBytes > 0);
  const compactSize = formatDiskBytes(
    isInstalled && sizeBytes > 0 ? sizeBytes : expectedBytes,
    true
  );
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
    addItem(`Uninstall (${compactSize})`, () => uninstallModel(norm), busy);
  } else {
    addItem(
      installingModelKey === norm
        ? `Installing (${compactSize})…`
        : `Install (${compactSize})`,
      () => installModel(norm),
      busy || !navigator.onLine
    );
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

export async function syncServerStatus(isInitialLoad = false, onSelectTier = null) {
  try {
    const response = await fetch("/api/status");
    state.serverStatus = await response.json();

    const { device_label, precision, ram_label, ram_gb, recommended_tier, version } =
      state.serverStatus;
    dom.hwCompute.textContent = (device_label || "LOCAL ENGINE").toUpperCase();
    if (dom.hwPrecision) dom.hwPrecision.textContent = (precision || "—").toUpperCase();
    if (dom.hwMemory) {
      const memText = ram_label || (ram_gb ? `${ram_gb} GB` : "—");
      dom.hwMemory.textContent = String(memText).toUpperCase();
    }
    const verLabel = version ? `V${version}` : "V—";
    if (dom.prefsVersion) dom.prefsVersion.textContent = verLabel;
    if (dom.sysVersion) dom.sysVersion.textContent = verLabel;
    if (dom.aboutVersion) dom.aboutVersion.textContent = verLabel;

    if (isInitialLoad && onSelectTier) {
      const targetTier =
        prefs.defaultTier && prefs.defaultTier !== "auto"
          ? prefs.defaultTier
          : recommended_tier || "general";
      onSelectTier(targetTier);
    }
    updateCacheIndicator();
  } catch (_) {
    dom.hwCompute.textContent = "LOCAL ENGINE";
  }
}

export function selectPrefsPane(paneId) {
  dom.infoModal.querySelectorAll(".prefs-nav-item").forEach((item) => {
    item.classList.toggle("active", item.getAttribute("data-pane") === paneId);
  });
  dom.infoModal.querySelectorAll(".prefs-pane").forEach((pane) => {
    pane.classList.toggle("active", pane.id === paneId);
  });
}

export function openPrefsDialog(section) {
  dom.infoModal.classList.add("active");
  const paneId = PREFS_SECTION_MAP[section] || "settings-preferences";
  selectPrefsPane(paneId);
}

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

  try {
    window.pywebview?.api?.set_window_theme?.(prefs.theme);
  } catch (_) {}

  onSyncMenu?.();
}
