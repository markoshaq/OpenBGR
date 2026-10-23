/**
 * Byte/duration formatting, download-rate smoothing, and per-tier download
 * progress rendering. Importing this module has no side effects.
 */

/**
 * Returns a function `(downloadedBytes, totalBytes) => shownBytes` that
 * extrapolates the last observed download rate between samples, so coarse
 * xet chunk flushes still render as smooth progress.
 */
export function createByteSmoother() {
  let rate = 0;
  let lastBytes = 0;
  let lastAt = 0;
  return (dl, tot) => {
    const now = performance.now();
    if (dl > lastBytes) {
      if (lastAt) {
        const r = (dl - lastBytes) / ((now - lastAt) / 1000);
        rate = rate ? rate * 0.5 + r * 0.5 : r;
      }
      lastBytes = dl;
      lastAt = now;
    }
    return Math.min(
      tot > 0 ? tot : lastBytes,
      lastBytes + rate * ((now - lastAt) / 1000)
    );
  };
}

/** Formats a duration for the elapsed readouts: "34.2s", "2m 05s", "1h 23m". */
export function formatElapsed(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const totalSec = Math.floor(s);
  const m = Math.floor(totalSec / 60);
  if (m < 60) return `${m}m ${String(totalSec % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Formats a byte count for display (MiB/GiB units). */
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

/** Live "XMB/YMB" download text per model key, shared by every progress poller. */
const tierDownloadText = new Map();

/** Highest rendered download byte count per model key; displayed progress never regresses. */
const tierDownloadPeak = new Map();

/**
 * Paints live model-download progress onto a sidebar tier button (fill +
 * label). The label's total uses `expectedBytes` (same source as the static
 * label) so the number can't drift mid-download; the fill uses the real
 * downloaded/total ratio.
 */
export function updateTierDownloadUI(key, shownBytes, totBytes, expectedBytes) {
  if (!key) return;
  const peak = Math.max(shownBytes, tierDownloadPeak.get(key) || 0);
  tierDownloadPeak.set(key, peak);
  const totalShown = expectedBytes > 0 ? expectedBytes : totBytes;
  const text =
    totalShown > 0
      ? `${formatDiskBytes(peak, true)}/${formatDiskBytes(totalShown, true)}`
      : formatDiskBytes(peak, true);
  tierDownloadText.set(key, text);
  const tierBtn = document.querySelector(
    `#tierSelector .tier-btn[data-tier="${key}"]`
  );
  if (tierBtn) {
    tierBtn.classList.add("downloading");
    if (totBytes > 0) {
      tierBtn.style.setProperty(
        "--dl",
        `${Math.min(100, (peak / totBytes) * 100)}%`
      );
    }
  }
  const techEl = document.getElementById(`tech-${key}`);
  if (techEl) {
    const name =
      techEl.dataset.name ||
      techEl.textContent.replace(/\s*\([^)]*\)\s*$/, "").trim();
    techEl.textContent = `${name} (${text})`;
  }
}

/** Clears live download progress from a sidebar tier button. */
export function clearTierDownloadProgress(key) {
  if (!key) return;
  tierDownloadText.delete(key);
  tierDownloadPeak.delete(key);
  const tierBtn = document.querySelector(
    `#tierSelector .tier-btn[data-tier="${key}"]`
  );
  if (tierBtn) {
    tierBtn.classList.remove("downloading");
    tierBtn.style.removeProperty("--dl");
  }
}

/** Returns the live "XMB/YMB" label for a downloading model, or null. */
export function getTierDownloadText(key) {
  return tierDownloadText.get(key) || null;
}
