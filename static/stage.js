/**
 * Interactive stage viewport: split-plane comparison geometry, pan/zoom
 * transforms, and the 4x circular magnifier loupe.
 */

import { state, dom } from "./state.js";

export function renderStageGeometry() {
  if (state.viewMode === "split") {
    dom.beforeClip.style.display = "block";
    dom.splitLine.style.display = "block";
    dom.lblLeft.style.display = "block";
    dom.lblRight.style.display = "block";
    dom.beforeClip.style.clipPath = `inset(0 ${100 - state.splitPercent}% 0 0)`;
    dom.splitLine.style.left = `${state.splitPercent}%`;
  } else if (state.viewMode === "cutout") {
    dom.beforeClip.style.display = "none";
    dom.splitLine.style.display = "none";
    dom.lblLeft.style.display = "none";
    dom.lblRight.style.display = "block";
  } else {
    dom.beforeClip.style.display = "block";
    dom.beforeClip.style.clipPath = "inset(0 0 0 0)";
    dom.splitLine.style.display = "none";
    dom.lblLeft.style.display = "block";
    dom.lblRight.style.display = "none";
  }
}

export function applyZoomTransform() {
  if (!dom.stage) return;
  if (state.zoom <= 1) {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
  }
  dom.stage.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  if (dom.btnZoomReset) {
    dom.btnZoomReset.textContent = `${Math.round(state.zoom * 100)}%`;
  }
}

export function setZoom(newZoom) {
  state.zoom = Math.max(1, Math.min(8, newZoom));
  applyZoomTransform();
}

export function renderLoupeAtPointer(clientX, clientY) {
  if (!state.loupeEnabled || !state.sourceFile || !dom.loupeCanvas) {
    dom.loupeCanvas?.classList.remove("visible");
    return;
  }

  const stageRect = dom.stage.getBoundingClientRect();
  const vpRect = dom.viewport.getBoundingClientRect();
  if (
    !stageRect.width ||
    clientX < stageRect.left ||
    clientX > stageRect.right ||
    clientY < stageRect.top ||
    clientY > stageRect.bottom
  ) {
    dom.loupeCanvas.classList.remove("visible");
    return;
  }

  dom.loupeCanvas.classList.add("visible");
  dom.loupeCanvas.style.left = `${clientX - vpRect.left}px`;
  dom.loupeCanvas.style.top = `${clientY - vpRect.top}px`;

  const normX = (clientX - stageRect.left) / stageRect.width;
  const normY = (clientY - stageRect.top) / stageRect.height;

  const size = 180;
  const zoomFactor = 4;
  const ctx = dom.loupeCanvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);

  if (state.activeBackdrop === "checker") {
    const cs = getComputedStyle(document.documentElement);
    const checkerA = cs.getPropertyValue("--checker-a").trim() || "#16161a";
    const checkerB = cs.getPropertyValue("--checker-b").trim() || "#0e0e11";
    const tile = 10;
    for (let y = 0; y < size; y += tile) {
      for (let x = 0; x < size; x += tile) {
        ctx.fillStyle = ((x / tile + y / tile) & 1) === 0 ? checkerA : checkerB;
        ctx.fillRect(x, y, tile, tile);
      }
    }
  } else {
    ctx.fillStyle = state.activeBackdrop;
    ctx.fillRect(0, 0, size, size);
  }

  const drawMagnifiedSource = (imgEl) => {
    const imgW = imgEl.naturalWidth;
    const imgH = imgEl.naturalHeight;
    if (!imgW || !imgH) return;

    const sampleW = (size / stageRect.width) * (imgW / zoomFactor);
    const sampleH = (size / stageRect.height) * (imgH / zoomFactor);
    const sx = normX * imgW - sampleW / 2;
    const sy = normY * imgH - sampleH / 2;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(imgEl, sx, sy, sampleW, sampleH, 0, 0, size, size);
  };

  if (state.viewMode === "original") {
    drawMagnifiedSource(dom.beforeImg);
  } else if (state.viewMode === "split" && normX * 100 < state.splitPercent) {
    drawMagnifiedSource(dom.beforeImg);
  } else {
    drawMagnifiedSource(dom.afterImg);
  }
}

export function handleSplitDrag(clientX) {
  if (state.loupeEnabled || !state.isDraggingSplit || state.viewMode !== "split") return;
  const rect = dom.stage.getBoundingClientRect();
  if (!rect.width) return;

  const rawPct = ((clientX - rect.left) / rect.width) * 100;
  state.splitPercent = Math.max(0, Math.min(100, rawPct));
  renderStageGeometry();
}
