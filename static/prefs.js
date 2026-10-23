/**
 * Shared model/format/theme constants and persisted user preferences
 * (`localStorage` schema, sanitization, load/save/reset).
 * Importing this module has no DOM or network side effects.
 */

export const DOT_TOOLTIPS = {
  ready: "READY OFFLINE: Model weights are cached on disk",
  downloadable: "ON DEMAND: Model downloads on first run",
  unavailable: "NOT CACHED: model must be downloaded or imported manually",
};

export const TIER_KEYS = [
  "lite",
  "general",
  "hr",
  "portrait",
  "matting",
  "dynamic",
];

export const TIER_ALIASES = {
  low: "lite",
  mid: "general",
  full: "general",
  high: "hr",
};

/** Resolves legacy tier keys (`low`/`mid`/`high`) and display labels to a canonical model key. */
export function normalizeTierKey(key) {
  const cleaned = String(key || "").trim().toLowerCase();
  return TIER_ALIASES[cleaned] || cleaned;
}

/** Display names matching the sidebar tier-labels exactly. */
export const PRESET_NAMES = {
  lite: "LITE",
  general: "GENERAL",
  hr: "ULTRA HR",
  portrait: "PORTRAIT",
  matting: "MATTING",
  dynamic: "DYNAMIC",
};

export const FORMAT_EXT = {
  png: "png",
  webp: "webp",
  jpg: "jpg",
  mask: "png",
  gif: "gif",
};

export const FORMAT_LABELS = {
  png: "PNG",
  webp: "WEBP",
  jpg: "JPG",
  mask: "MASK",
  gif: "GIF",
};

/** Default Auto-Crop padding: percent of the tight box's longest side. */
export const DEFAULT_CROP_PADDING = 5;

export const ACCENTS = {
  white: ["#fafafa", "#09090b"],
  green: ["#34d399", "#052e1b"],
  blue: ["#60a5fa", "#0b1c3a"],
  amber: ["#fbbf24", "#3a2a05"],
  red: ["#f87171", "#3a0a0a"],
  violet: ["#a78bfa", "#1e1245"],
};

const STORAGE_KEY_CONFIRM_CLOSE = "openbgr_confirm_close_tab";
const STORAGE_KEY_PREFS = "openbgr_prefs";

/** Returns the factory-default preference snapshot (theme, model, filters, export). */
export function getDefaultPrefs() {
  return {
    theme: "dark",
    accent: "default",
    defaultTier: "auto",
    defaultFormat: "png",
    defaultBackdrop: "checker",
    confirmClose: true,
    qaTier: "general",
    qaSaveMode: "same_folder",
    qaFormat: "png",
    qaEdgeRefine: true,
    qaCopyClipboard: false,
    qaNotify: true,
    inferEstimates: {},
  };
}

const PREF_SCHEMA = {
  theme: { values: ["dark", "light"], fallback: "dark" },
  accent: { values: ["default", ...Object.keys(ACCENTS)], fallback: "default" },
  defaultTier: {
    values: ["auto", ...TIER_KEYS],
    fallback: "auto",
  },
  defaultFormat: { values: ["png", "webp", "jpg", "mask"], fallback: "png" },
  defaultBackdrop: {
    values: ["checker", "#ffffff", "#000000", "#18181b"],
    fallback: "checker",
  },
  confirmClose: { type: "boolean", fallback: true },
  qaTier: {
    values: [...TIER_KEYS],
    fallback: "general",
  },
  qaSaveMode: {
    values: ["same_folder", "ask"],
    fallback: "same_folder",
  },
  qaFormat: { values: ["png", "webp", "jpg", "mask"], fallback: "png" },
  qaEdgeRefine: { type: "boolean", fallback: true },
  qaCopyClipboard: { type: "boolean", fallback: false },
  qaNotify: { type: "boolean", fallback: true },
};

/** Validates a stored preference object against the schema; unknown/invalid values fall back to defaults. */
function sanitizePrefs(stored) {
  const clean = {};
  for (const [key, rule] of Object.entries(PREF_SCHEMA)) {
    let v = stored[key];
    if (
      (key === "defaultTier" || key === "qaTier") &&
      typeof v === "string" &&
      v !== "auto"
    ) {
      v = normalizeTierKey(v);
    }
    if (rule.type === "boolean") {
      clean[key] = typeof v === "boolean" ? v : rule.fallback;
    } else {
      clean[key] = rule.values.includes(v) ? v : rule.fallback;
    }
  }
  const est = {};
  if (stored.inferEstimates && typeof stored.inferEstimates === "object") {
    for (const k of TIER_KEYS) {
      const ms = Number(stored.inferEstimates[k]);
      if (Number.isFinite(ms) && ms > 0) est[k] = ms;
    }
  }
  clean.inferEstimates = est;
  return clean;
}

/** Reads preferences from `localStorage`, sanitizes them, and merges over defaults. */
export function loadPrefs() {
  let stored = {};
  let legacyConfirm = null;
  try {
    stored = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY_PREFS) || "{}");
    legacyConfirm = globalThis.localStorage?.getItem(STORAGE_KEY_CONFIRM_CLOSE) ?? null;
  } catch (_) {}
  const clean = sanitizePrefs(typeof stored === "object" && stored ? stored : {});
  if (legacyConfirm !== null) {
    clean.confirmClose = legacyConfirm !== "false";
  }
  return clean;
}

export const prefs = loadPrefs();

/** Persists the current preference object (plus resolved accent pair for pre-paint boot) to `localStorage`. */
export function savePrefs() {
  try {
    const payload = {
      ...prefs,
      accentPair: ACCENTS[prefs.accent] || null,
    };
    globalThis.localStorage?.setItem(STORAGE_KEY_PREFS, JSON.stringify(payload));
  } catch (err) {
    console.warn("[OpenBGR] Failed to persist preferences:", err);
  }
}

/** Updates one preference key and persists the whole object to `localStorage`. */
export function setPref(key, value) {
  prefs[key] = value;
  savePrefs();
}

/** Restores every preference to its factory default and persists it. */
export function resetPrefs() {
  Object.assign(prefs, getDefaultPrefs());
  savePrefs();
}
