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
  TIER_STATUS_SHORT,
  PRESET_NAMES,
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

const MODEL_CTX_LABELS = {
  lite: "LITE 1K",
  general: "GENERAL 1K",
  hr: "ULTRA HR 2K",
  portrait: "PORTRAIT 1K",
  matting: "MATTING 2K",
  dynamic: "DYNAMIC",
};

export function formatDiskBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return "0 MB";
  const gb = n / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function getTierInfo(key) {
  const norm = normalizeTierKey(key);
  return state.serverStatus?.tiers?.[norm] || null;
}

function getTierAvailability(tierInfo) {
  if (tierInfo?.cached) return "ready";
  return navigator.onLine ? "downloadable" : "unavailable";
}

function applyDotState(dotEl, status) {
  if (!dotEl) return;
  dotEl.classList.remove("ready", "downloadable", "unavailable");
  dotEl.classList.add(status);
  const tip = DOT_TOOLTIPS[status] || "";
  dotEl.setAttribute("data-tooltip", tip);
  // Skip native title tooltip when an ancestor already provides a styled tooltip.
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
    const isInstalled = Boolean(tierInfo?.cached || sizeBytes > 0);
    if (isInstalled) installedCount++;
    totalBytes += sizeBytes;
    const sizeLabel = isInstalled ? formatDiskBytes(sizeBytes) : "0 MB";

    applyDotState(document.getElementById(`dot-${key}`), status);
    applyDotState(document.getElementById(`sysdot-${key}`), status);

    const statusDetail = isInstalled
      ? `CACHED OFFLINE (${sizeLabel}) · Right-click to uninstall`
      : TIER_STATUS_SHORT[status] || "";

    const tierBtn = document.querySelector(
      `#tierSelector .tier-btn[data-tier="${key}"]`
    );
    if (tierBtn) {
      tierBtn.setAttribute("data-tooltip", statusDetail);
    }

    const sizeEl = document.getElementById(`syssize-${key}`);
    if (sizeEl) {
      sizeEl.textContent = isInstalled ? sizeLabel : "0 MB";
      sizeEl.classList.toggle("dim", !isInstalled);
    }

    const badge = document.getElementById(`sysbadge-${key}`);
    if (badge) {
      const isActive = Boolean(tierInfo?.active);
      badge.textContent = isActive
        ? "ACTIVE"
        : status === "ready"
          ? "CACHED"
          : status === "downloadable"
            ? "ON DEMAND"
            : "OFFLINE";
      badge.classList.toggle("on", isActive);
    }

    const uninstallBtn = document.getElementById(`sysbtn-${key}`);
    if (uninstallBtn) {
      uninstallBtn.disabled = !isInstalled || state.isProcessing;
      uninstallBtn.textContent = "UNINSTALL";
    }
  });

  const serverTotal = state.serverStatus?.total_cache_bytes;
  const finalTotal = typeof serverTotal === "number" ? serverTotal : totalBytes;
  const totalSummary = `${formatDiskBytes(finalTotal)} (${installedCount} OF ${TIER_KEYS.length} INSTALLED)`;

  const totalEl = document.getElementById("modelsTotalSize");
  if (totalEl) totalEl.textContent = totalSummary;

  const sysSummaryEl = document.getElementById("sysCacheSummary");
  if (sysSummaryEl) sysSummaryEl.textContent = totalSummary;

  const cacheDirEl = document.getElementById("modelsCacheDir");
  if (cacheDirEl && state.serverStatus?.cache_dir) {
    cacheDirEl.textContent = state.serverStatus.cache_dir;
  }

  const uninstallAllBtn = document.getElementById("btnUninstallAllModels");
  if (uninstallAllBtn) {
    uninstallAllBtn.disabled =
      (installedCount === 0 && finalTotal === 0) || state.isProcessing;
    uninstallAllBtn.textContent = "UNINSTALL ALL";
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

export function showModelContextMenu(key, x, y) {
  const menu = dom.tabContextMenu;
  if (!menu) return;
  menu.innerHTML = "";

  const tierInfo = getTierInfo(key);
  const sizeBytes = Number(tierInfo?.size_bytes) || 0;
  const isInstalled = Boolean(tierInfo?.cached || sizeBytes > 0);
  const sizeLabel = isInstalled ? formatDiskBytes(sizeBytes) : "0 MB";
  const titleLabel =
    MODEL_CTX_LABELS[key] || PRESET_NAMES[key] || key.toUpperCase();

  const head = document.createElement("div");
  head.className = "ctx-head";
  head.textContent = `${titleLabel} · ${isInstalled ? `${sizeLabel} ON DISK` : "NOT INSTALLED"}`;
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

  if (isInstalled) {
    addItem(
      `UNINSTALL MODEL (${sizeLabel})`,
      () => uninstallModel(key),
      state.isProcessing
    );
  } else {
    addItem("NOT INSTALLED (0 MB)", () => {}, true);
  }

  const sep = document.createElement("div");
  sep.className = "ctx-sep";
  menu.appendChild(sep);

  addItem("MANAGE MODELS IN SETTINGS…", () => openPrefsDialog("models"));

  menu.style.display = "block";
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
}

export async function syncServerStatus(isInitialLoad = false, onSelectTier = null) {
  try {
    const response = await fetch("/api/status");
    state.serverStatus = await response.json();

    const { device_label, precision, recommended_tier, version } = state.serverStatus;
    dom.hwCompute.textContent = (device_label || "LOCAL ENGINE").toUpperCase();
    if (dom.hwPrecision) dom.hwPrecision.textContent = (precision || "—").toUpperCase();
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
  root.classList.toggle("density-compact", prefs.density === "compact");

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
  dom.prefDensityComfortable?.classList.toggle("active", prefs.density !== "compact");
  dom.prefDensityCompact?.classList.toggle("active", prefs.density === "compact");
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
