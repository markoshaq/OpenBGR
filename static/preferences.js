/**
 * Preferences modal, appearance theming, model cache indicators, and
 * `/api/status` hardware capability synchronization.
 */

import {
  state,
  dom,
  prefs,
  DOT_TOOLTIPS,
  TIER_STATUS_SHORT,
  TIER_META,
  ACCENTS,
} from "./state.js";

const PREFS_SECTION_MAP = {
  preferences: "settings-preferences",
  appearance: "settings-preferences",
  general: "settings-general",
  behavior: "settings-general",
  system: "settings-system",
  about: "settings-about",
};

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

  const inventory = {
    low: tiers.low,
    mid: tiers.mid,
    high: tiers.high,
    matting: state.serverStatus?.matting,
  };

  Object.entries(inventory).forEach(([key, tierInfo]) => {
    const status = getTierAvailability(tierInfo);
    applyDotState(document.getElementById(`dot-${key}`), status);
    applyDotState(document.getElementById(`sysdot-${key}`), status);

    const tierBtn = document.querySelector(
      `#tierSelector .tier-btn[data-tier="${key}"]`
    );
    if (tierBtn) {
      const tip = `${TIER_META[key] || ""} ${TIER_STATUS_SHORT[status] || ""}`.trim();
      tierBtn.setAttribute("data-tooltip", tip);
    }

    if (key === "matting") {
      const matBtn = document.getElementById("btnMatting");
      if (matBtn) {
        const tip = `${TIER_META.matting} ${TIER_STATUS_SHORT[status] || ""}`.trim();
        matBtn.setAttribute("data-tooltip", tip);
      }
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
  });
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
          : recommended_tier || "mid";
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
