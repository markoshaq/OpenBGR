/**
 * Shared floating tooltip anchored to the viewport on `<body>` for every
 * `[data-tooltip]` element, so scrollable sidebars cannot clip it.
 * Importing this module has no side effects; app.js calls `initTooltips()`.
 */

const TIP_GAP = 6;
const TIP_MARGIN = 8;

/**
 * Places the tip below its host (above when it would overflow the bottom),
 * centered horizontally and clamped inside the viewport margins.
 */
export function placeTooltip(hostRect, tipRect, viewW, viewH) {
  let top = hostRect.bottom + TIP_GAP;
  if (top + tipRect.height > viewH - TIP_MARGIN) {
    top = hostRect.top - tipRect.height - TIP_GAP;
  }
  top = Math.max(
    TIP_MARGIN,
    Math.min(top, viewH - tipRect.height - TIP_MARGIN)
  );
  let left = hostRect.left + hostRect.width / 2 - tipRect.width / 2;
  left = Math.max(
    TIP_MARGIN,
    Math.min(left, viewW - tipRect.width - TIP_MARGIN)
  );
  return { left: Math.round(left), top: Math.round(top) };
}

/** Creates the tooltip controller; the tip element is built on first show. */
export function createTooltip() {
  let tipEl = null;
  let tipHost = null;

  const ensureTip = () => {
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.className = "floating-tooltip";
      tipEl.setAttribute("role", "tooltip");
      document.body.appendChild(tipEl);
    }
    return tipEl;
  };

  const hide = () => {
    tipHost = null;
    tipEl?.classList.remove("visible");
  };

  const onMouseOver = (e) => {
    const host = e.target?.closest?.("[data-tooltip]");
    const text = host?.getAttribute("data-tooltip");
    if (!text) {
      if (tipHost) hide();
      return;
    }
    if (host === tipHost && tipEl?.textContent === text) return;
    tipHost = host;
    const tip = ensureTip();
    tip.textContent = text;
    tip.classList.add("visible");
    const { left, top } = placeTooltip(
      host.getBoundingClientRect(),
      tip.getBoundingClientRect(),
      window.innerWidth,
      window.innerHeight
    );
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  const onKeydown = (e) => {
    if (e.key === "Escape") hide();
  };

  return {
    hide,
    onMouseOver,
    onKeydown,
    get element() {
      return tipEl;
    },
  };
}

/** Wires the shared tooltip to document hover and every dismiss trigger. */
export function initTooltips() {
  const tip = createTooltip();
  document.addEventListener("mouseover", tip.onMouseOver);
  document.addEventListener("pointerdown", tip.hide, true);
  document.addEventListener("mouseleave", tip.hide);
  document.addEventListener("keydown", tip.onKeydown);
  window.addEventListener("scroll", tip.hide, true);
  window.addEventListener("blur", tip.hide);
  return tip;
}
