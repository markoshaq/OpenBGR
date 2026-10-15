#!/usr/bin/env python3
"""
OpenBGR — macOS Squircle App Icon Renderer
==========================================
Pure-Pillow renderer shared by `app.py` (runtime Dock/window icon) and
`scripts/build_release.py` (packaged `OpenBGR.icns`).

The mark follows Apple's Big Sur+ icon grid: the artwork lives inside a
centered ~80% superellipse ("squircle") on a transparent canvas, matching
every other macOS app icon in the Dock. Rendering is supersampled 4x and
downscaled with Lanczos for crisp continuous-curve edges.

Motif: the left half is solid white (the subject) and the right half is a
dark checkerboard (the removed background / transparency preview), split by
a two-tone center seam — the "cutout" metaphor.
"""

from __future__ import annotations

import math

from PIL import Image, ImageDraw

# Apple's icon grid: artwork occupies ~824pt of the 1024pt canvas.
ART_FRACTION = 824.0 / 1024.0
SUPERSAMPLE = 4
# Superellipse exponent approximating Apple's continuous-curvature squircle.
SQUIRCLE_EXPONENT = 4.6


def _squircle_points(cx: float, cy: float, half: float, samples: int = 720) -> list[tuple[float, float]]:
    """Parametric Lamé/superellipse polygon approximating the macOS squircle."""
    exp = 2.0 / SQUIRCLE_EXPONENT
    pts = []
    for i in range(samples):
        t = 2.0 * math.pi * i / samples
        c, s = math.cos(t), math.sin(t)
        x = cx + half * math.copysign(abs(c) ** exp, c)
        y = cy + half * math.copysign(abs(s) ** exp, s)
        pts.append((x, y))
    return pts


def render_icon(size: int = 1024) -> Image.Image:
    """Renders the OpenBGR squircle icon as an RGBA image of `size`x`size`."""
    s = size * SUPERSAMPLE
    margin = s * (1.0 - ART_FRACTION) / 2.0
    art = s - 2.0 * margin
    cx = cy = s / 2.0
    half = art / 2.0
    left, top = cx - half, cy - half
    right, bottom = cx + half, cy + half
    mid = cx

    squircle = _squircle_points(cx, cy, half)
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).polygon(squircle, fill=255)

    # Artwork layer: solid left half, dark checkerboard right half.
    layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rectangle((left, top, mid, bottom), fill=(250, 250, 250, 255))
    rows = cols = 8
    tile_w, tile_h = half / cols, art / rows
    for r in range(rows):
        for c in range(cols):
            color = (39, 39, 42, 255) if (r + c) % 2 == 0 else (16, 16, 18, 255)
            d.rectangle(
                (mid + c * tile_w, top + r * tile_h,
                 mid + (c + 1) * tile_w + 1, top + (r + 1) * tile_h + 1),
                fill=color,
            )

    # Two-tone center seam: dark on the white half, white on the dark half.
    seam = max(2, int(s * 0.004))
    d.rectangle((mid - seam, top, mid, bottom), fill=(9, 9, 11, 255))
    d.rectangle((mid, top, mid + seam, bottom), fill=(250, 250, 250, 255))

    # Subtle top-light gradient for depth (classic macOS sheen).
    sheen = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sheen)
    span = int(art)
    for i in range(span):
        alpha = int(22 * (1.0 - i / span))
        if alpha:
            sd.line((left, top + i, right, top + i), fill=(255, 255, 255, alpha))
    layer = Image.alpha_composite(layer, sheen)

    # Soft inner edge stroke so the icon reads on light wallpapers too —
    # drawn onto the artwork layer, then clipped so only the inner half shows.
    ImageDraw.Draw(layer).line(
        squircle + [squircle[0]],
        fill=(0, 0, 0, 110),
        width=max(2, int(s * 0.008)),
        joint="curve",
    )

    # Clip artwork to the squircle.
    icon = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    icon.paste(layer, (0, 0), mask)

    return icon.resize((size, size), Image.Resampling.LANCZOS)


if __name__ == "__main__":
    render_icon(1024).save("/tmp/openbgr_icon_preview.png")
    print("wrote /tmp/openbgr_icon_preview.png")
