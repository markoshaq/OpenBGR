"""
Computer vision post-processing (edge color decontamination, color spill
suppression, RGBA composition) and neural foreground segmentation pipeline.
"""

from __future__ import annotations

import io
import itertools
import threading
import time
from collections import OrderedDict
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageFilter, ImageOps
from scipy.ndimage import gaussian_filter1d, maximum_filter1d, minimum_filter1d
from torchvision import transforms

from .config import (
    DEVICE,
    DTYPE,
    RECOMMENDED_TIER,
    SYSTEM_MEMORY_GB,
    TIERS,
    logger,
    normalize_tier_key,
)
from .models import (
    MANAGER,
    compute_dynamic_size,
    get_preprocess_transform,
    set_job_phase,
)


def _square_min_filter(arr: np.ndarray, size: int) -> np.ndarray:
    """
    Square morphological min filter computed as two separable 1-D passes
    (horizontal then vertical). Output is identical to PIL's
    `ImageFilter.MinFilter(size)` on `mode="nearest"` borders, but costs
    O(2*size) per pixel instead of O(size^2).
    """
    return minimum_filter1d(
        minimum_filter1d(arr, size, axis=0, mode="nearest"),
        size,
        axis=1,
        mode="nearest",
    )


def _square_max_filter(arr: np.ndarray, size: int) -> np.ndarray:
    """
    Square morphological max filter computed as two separable 1-D passes
    (horizontal then vertical). Output is identical to PIL's
    `ImageFilter.MaxFilter(size)` on `mode="nearest"` borders, but costs
    O(2*size) per pixel instead of O(size^2).
    """
    return maximum_filter1d(
        maximum_filter1d(arr, size, axis=0, mode="nearest"),
        size,
        axis=1,
        mode="nearest",
    )


def adjust_alpha_geometry(
    alpha_np: np.ndarray, shift_px: int = 0, feather_px: float = 0.0
) -> np.ndarray:
    """
    Contracts or expands the matte edge by `shift_px` pixels (negative erodes
    the cutout inward, positive dilates it outward), then softens it with a
    Gaussian feather of sigma `feather_px`. Both passes reuse the separable
    1-D filters: an `n`px shift costs O(4n) per pixel instead of O(n^2), and
    `mode="nearest"` keeps subjects touching the frame border intact.
    """
    adjusted = alpha_np
    shift = int(shift_px)
    if shift != 0:
        size = 2 * abs(shift) + 1
        fn = _square_max_filter if shift > 0 else _square_min_filter
        adjusted = fn(adjusted, size)
    feather = float(feather_px)
    if feather > 0:
        blurred = gaussian_filter1d(
            gaussian_filter1d(adjusted.astype(np.float32), feather, axis=0, mode="nearest"),
            feather,
            axis=1,
            mode="nearest",
        )
        adjusted = np.clip(blurred + 0.5, 0, 255).astype(np.uint8)
    return adjusted


def decontaminate_edge_colors(rgb_np: np.ndarray, alpha_np: np.ndarray) -> np.ndarray:
    """
    Removes background color bleed ("halos") from semi-transparent edge pixels.

    Why this matters:
    In natural images, boundary pixels along hair strands or soft edges are a
    linear mixture of foreground color F and background color B:
        I = alpha * F + (1 - alpha) * B
    Simply attaching the predicted alpha mask to the original RGB pixels (`I`)
    leaves `(1 - alpha) * B` visible when composited onto a new backdrop.

    This function approximates local foreground color `F` in the transition band
    (0.03 < alpha < 0.94) using a fast C-accelerated 5x5 morphological maximum
    filter followed by a 3x3 box blur, blending the propagated foreground color
    into semi-transparent edge pixels proportionally to their transparency.
    """
    alpha_norm = alpha_np.astype(np.float32) / 255.0

    # Identify semi-transparent transition pixels (hair strands, soft object borders).
    edge_mask = (alpha_norm > 0.03) & (alpha_norm < 0.94)
    if not np.any(edge_mask):
        return rgb_np

    # Dilate nearby solid foreground colors outward and smooth transitions.
    dilated_np = _square_max_filter(rgb_np, 5)
    with Image.fromarray(dilated_np).filter(ImageFilter.BoxBlur(1)) as dilated_pil:
        smooth_fg = np.array(dilated_pil, dtype=np.float32)

    # Higher alpha pixels retain more of their original RGB; lower alpha pixels
    # receive stronger foreground color propagation. Indexing by edge_mask runs
    # the blend on an (n_edge, 3) subset instead of materializing ~1GB of
    # full-frame float32 temporaries on 24MP images.
    fg_weight = np.clip((alpha_norm[edge_mask] - 0.5) * 2.0, 0.0, 1.0)[:, None]
    blend_strength = (1.0 - fg_weight) * 0.65
    cleaned_rgb = rgb_np.copy()
    cleaned_rgb[edge_mask] = np.clip(
        rgb_np[edge_mask].astype(np.float32) * (1.0 - blend_strength)
        + smooth_fg[edge_mask] * blend_strength,
        0,
        255,
    ).astype(np.uint8)
    return cleaned_rgb


def suppress_color_spill(rgb_np: np.ndarray, alpha_norm: np.ndarray) -> np.ndarray:
    """
    Neutralizes background color spill (rim reflections & color bounce) along
    the outer boundary of the subject and inside semi-transparent glass/hair.

    Algorithm:
    1. Estimates the local removed background RGB color (`local_bg`) adjacent to
       the subject via normalized box-filter convolution over background pixels (`alpha < 0.15`).
    2. Computes a spill receiver weight map combining:
       - The outer solid rim of the subject (via a separable 15x15 morphological erosion).
       - Semi-transparent regions (`0.02 < alpha < 0.98`, such as hair, glass, or sheer fabric).
    3. Projects each receiver pixel's chromatic vector (`RGB - Luma`) onto the local
       background's chromatic vector (`B_local - B_luma`). Any positive chromatic alignment
       (indicating background color bounce/spill) is subtracted while preserving 100% of
       the pixel's original luminance and sharpness.
    """
    bg_mask = (alpha_norm < 0.15).astype(np.float32)
    if not np.any(bg_mask > 0):
        return rgb_np

    # Build rim + semi-transparent receiver weight map. It does not depend on
    # the blurred background maps, so computing it first lets the no-receiver
    # early-out skip the BoxBlur passes entirely.
    eroded_norm = _square_min_filter(alpha_norm, 15)
    solid_rim_weight = np.clip(alpha_norm - eroded_norm, 0.0, 1.0)
    translucent_weight = np.clip(4.0 * alpha_norm * (1.0 - alpha_norm), 0.0, 1.0)
    receiver_weight = np.clip(
        np.maximum(solid_rim_weight * 0.7, translucent_weight * 0.85), 0.0, 1.0
    ) * (alpha_norm > 0.02)

    if not np.any(receiver_weight > 0.01):
        return rgb_np

    # Compute spatially-varying local background color via fast C-accelerated BoxBlur
    bg_weight_u8 = (bg_mask * 255.0).astype(np.uint8)
    with Image.fromarray(bg_weight_u8) as bg_weight_img:
        bg_weight_blur = (
            np.array(bg_weight_img.filter(ImageFilter.BoxBlur(24)), dtype=np.float32) / 255.0
        )

    prem_bg_u8 = rgb_np * bg_mask.astype(np.uint8)[..., None]
    with Image.fromarray(prem_bg_u8) as prem_bg_img:
        prem_bg_blur = np.array(prem_bg_img.filter(ImageFilter.BoxBlur(24)), dtype=np.float32)

    # Fall back to global median background color where local background weight
    # is zero. A strided spatial subsample keeps the median robust without
    # copying ~70MB of masked pixels on 24MP inputs.
    bg_sub = rgb_np[::8, ::8][bg_mask[::8, ::8] > 0.5]
    if not bg_sub.size:
        # Stray background pixels can miss the stride-8 grid entirely; fall back
        # to the exact masked median so `global_bg` stays finite. Non-empty is
        # guaranteed by the `np.any(bg_mask > 0)` early-out above.
        bg_sub = rgb_np[bg_mask > 0.5]
    global_bg = np.median(bg_sub, axis=0).astype(np.float32)

    # The chromatic projection only runs on receiver pixels (the rim plus
    # semi-transparent areas): extracting that (n_recv, 3) subset avoids
    # keeping ~1GB of full-frame float32 chroma maps live on 24MP images.
    recv_mask = receiver_weight > 0
    bg_w = bg_weight_blur[recv_mask]
    local_bg = np.where(
        (bg_w > 0.02)[:, None],
        prem_bg_blur[recv_mask] / np.maximum(bg_w, 0.02)[:, None],
        global_bg,
    )

    # Chromatic projection: isolate color cast without altering pixel luminance
    fg_sub = rgb_np[recv_mask].astype(np.float32)
    fg_luma = np.mean(fg_sub, axis=-1, keepdims=True)
    bg_luma = np.mean(local_bg, axis=-1, keepdims=True)
    fg_chroma = fg_sub - fg_luma
    bg_chroma = local_bg - bg_luma

    bg_chroma_norm_sq = np.sum(bg_chroma * bg_chroma, axis=-1, keepdims=True) + 1e-5
    proj = np.sum(fg_chroma * bg_chroma, axis=-1, keepdims=True) / bg_chroma_norm_sq
    # Only subtract positive chromatic alignment (up to 100% of background chroma)
    spill_amount = np.clip(proj, 0.0, 1.0) * receiver_weight[recv_mask][:, None]

    despilled = rgb_np.copy()
    despilled[recv_mask] = np.clip(fg_sub - spill_amount * bg_chroma, 0, 255).astype(np.uint8)
    return despilled


# Bounded LRU cache of raw pre-refinement outputs (`rgb`, `alpha`) keyed by
# `job_id`. Caching per job_id lets multi-tab workspaces tweak edge filters
# (defringe/despill/shift/feather) across tabs in ~20ms without re-running the
# neural network, while the total-byte and entry caps bound memory usage.
_JOB_ID_SEQ = itertools.count(1)
_REFINE_JOBS: OrderedDict[int, dict[str, Any]] = OrderedDict()
_LAST_JOB_LOCK = threading.Lock()
_LAST_JOB_MAX_BYTES = (64 if SYSTEM_MEMORY_GB < 14.0 else 256) * 1024 * 1024
_REFINE_MAX_ENTRIES = 128
MAX_ANIMATION_FRAMES = 120
# Total decoded-RGBA budget for one animation: bounds the temporary frame
# list (and the base64 PNG payload the API builds on top) so a large-dimension
# animation cannot spike memory far beyond the upload cap.
MAX_ANIMATION_PIXEL_BYTES = (128 if SYSTEM_MEMORY_GB < 14.0 else 512) * 1024 * 1024

# Serializes compose_rgba across threads: segment_foreground runs it inside
# inference_lock while /api/refine calls it standalone. Concurrent passes
# would pile ~1GB of float32 temporaries onto a 24MP job.
_COMPOSE_LOCK = threading.Lock()


def clear_refine_jobs() -> None:
    """Clears all cached raw job buffers."""
    with _LAST_JOB_LOCK:
        _REFINE_JOBS.clear()


def cache_refine_job(job_id: int, rgb: np.ndarray, alpha: np.ndarray) -> bool:
    """
    Stores `(rgb, alpha)` in the bounded LRU refine cache under `job_id`,
    evicting oldest entries to stay within `_LAST_JOB_MAX_BYTES` and
    `_REFINE_MAX_ENTRIES`. Returns False when a single job exceeds the budget.
    """
    entry_bytes = int(rgb.nbytes + alpha.nbytes)
    with _LAST_JOB_LOCK:
        _REFINE_JOBS.pop(job_id, None)
        if entry_bytes > _LAST_JOB_MAX_BYTES:
            logger.info(
                "[Pipeline] Job over %dMB refine cache cap; skipping buffers.",
                _LAST_JOB_MAX_BYTES // (1024 * 1024),
            )
            return False
        total_bytes = sum(int(v.get("bytes", 0)) for v in _REFINE_JOBS.values())
        while _REFINE_JOBS and (
            len(_REFINE_JOBS) >= _REFINE_MAX_ENTRIES
            or total_bytes + entry_bytes > _LAST_JOB_MAX_BYTES
        ):
            _, evicted = _REFINE_JOBS.popitem(last=False)
            total_bytes -= int(evicted.get("bytes", 0))
        _REFINE_JOBS[job_id] = {
            "id": job_id,
            "rgb": rgb,
            "alpha": alpha,
            "bytes": entry_bytes,
        }
        return True


def get_last_job(job_id: int) -> dict[str, Any] | None:
    """
    Returns a snapshot of the cached raw RGB/alpha for `job_id` (marking it
    most-recently-used), or None when `job_id` is unknown or was evicted.
    """
    with _LAST_JOB_LOCK:
        entry = _REFINE_JOBS.get(job_id)
        if entry is None or "rgb" not in entry:
            return None
        _REFINE_JOBS.move_to_end(job_id)
        return dict(entry)


def compose_rgba(
    rgb_raw: np.ndarray,
    alpha_np: np.ndarray,
    defringe: bool,
    despill: bool,
    edge_shift: int = 0,
    edge_feather: float = 0.0,
) -> Image.Image:
    """
    Applies the optional edge-refinement filters onto the raw RGB + alpha and
    composites the final 32-bit RGBA image. Runs in milliseconds (pure NumPy /
    Pillow C filters); no neural network involved. Edge geometry is applied
    first so the color decontamination band follows the shifted edge.
    """
    with _COMPOSE_LOCK:
        alpha_out = adjust_alpha_geometry(alpha_np, edge_shift, edge_feather)
        rgb_np = decontaminate_edge_colors(rgb_raw, alpha_out) if defringe else rgb_raw
        if despill:
            alpha_norm = alpha_out.astype(np.float32) / 255.0
            rgb_np = suppress_color_spill(rgb_np, alpha_norm)
        return Image.fromarray(np.dstack((rgb_np, alpha_out)))


def segment_foreground(
    raw_image: Image.Image,
    tier: str = "general",
    defringe: bool = True,
    despill: bool = True,
    matting: bool = False,
    job_epoch: int | None = None,
    edge_shift: int = 0,
    edge_feather: float = 0.0,
) -> tuple[Image.Image, float, dict[str, Any], int]:
    """
    Executes the full background removal pipeline on a PIL image under a thread-safe
    inference lock with cooperative cancellation checkpoints and explicit tensor cleanup.
    """
    if job_epoch is None:
        job_epoch = MANAGER.cancel_epoch

    norm_tier = "matting" if matting else normalize_tier_key(tier)
    if norm_tier not in TIERS:
        norm_tier = RECOMMENDED_TIER

    tier_cfg = dict(TIERS[norm_tier])
    model_key = tier_cfg["model_key"]

    # Serialize GPU/MPS execution so cancelling and starting a new job never
    # causes two concurrent forward passes or mid-pass model eviction.
    with MANAGER.inference_lock:
        MANAGER.check_cancelled(job_epoch)
        model = MANAGER.get_or_load(model_key)
        MANAGER.check_cancelled(job_epoch)
        set_job_phase("inference", model_key)

        start_time = time.perf_counter()

        oriented_image = ImageOps.exif_transpose(raw_image)
        orig_w, orig_h = oriented_image.size
        rgb_image = oriented_image.convert("RGB")
        if oriented_image is not raw_image:
            oriented_image.close()

        # rgb_image must be released on every exit path: the outer finally also
        # covers cancels and OOM raised during preprocessing or inference, not
        # just the post-inference composition block.
        mask_pil: Image.Image | None = None
        try:
            if tier_cfg.get("dynamic"):
                dyn_h, dyn_w = compute_dynamic_size(orig_w, orig_h, int(tier_cfg["resolution"]))
                preprocess = get_preprocess_transform((dyn_h, dyn_w))
                tier_cfg["sublabel"] = f"Dynamic / {dyn_w}x{dyn_h}"
            else:
                tier_res = int(tier_cfg["resolution"])
                # Avoid upscaling small images (such as 480p GIF frames) to 1024x1024 or 2K:
                # clamping to the next multiple of 32 (floor 512) cuts MPS/VRAM peak by ~1-3 GB
                # and doubles frame throughput without sacrificing sub-pixel detail.
                long_side = max(orig_w, orig_h)
                eff_res = (
                    min(tier_res, max(512, ((long_side + 31) // 32) * 32))
                    if long_side < tier_res
                    else tier_res
                )
                preprocess = get_preprocess_transform(eff_res)
            input_tensor: torch.Tensor | None = None
            outputs: Any = None
            pred_logits: torch.Tensor | None = None
            alpha_tensor: torch.Tensor | None = None

            try:
                input_tensor = preprocess(rgb_image).unsqueeze(0).to(device=DEVICE, dtype=DTYPE)
                MANAGER.check_cancelled(job_epoch)

                with torch.inference_mode():
                    outputs = model(input_tensor)
                    del input_tensor
                    input_tensor = None
                    pred_logits = outputs[-1] if isinstance(outputs, (list, tuple)) else outputs
                    del outputs
                    outputs = None
                    alpha_tensor = pred_logits.float().sigmoid().cpu()
                    del pred_logits
                    pred_logits = None

                MANAGER.check_cancelled(job_epoch)

                mask_pil = transforms.ToPILImage()(alpha_tensor[0].squeeze(0)).resize(
                    (orig_w, orig_h), resample=Image.Resampling.LANCZOS
                )
            finally:
                # Explicitly release GPU/MPS tensors immediately after forward pass,
                # then flush the device caching allocator: freed MPS blocks are kept
                # for reuse otherwise, so a big-tier pass would pin its activation
                # peak (~1-2 GB unified RAM at 1536px) for the rest of the session.
                del input_tensor, outputs, pred_logits, alpha_tensor
                MANAGER.flush_device_memory()

            job_id = next(_JOB_ID_SEQ)
            MANAGER.check_cancelled(job_epoch)
            alpha_np = np.array(mask_pil, dtype=np.uint8)
            rgb_np_raw = np.array(rgb_image, dtype=np.uint8)

            # Snapshot the raw RGB + alpha in the bounded LRU refine cache so
            # /api/refine can re-apply edge filters across tabs without re-running inference.
            cache_refine_job(job_id, rgb_np_raw, alpha_np)

            MANAGER.check_cancelled(job_epoch)
            result_image = compose_rgba(
                rgb_np_raw, alpha_np, defringe, despill, edge_shift, edge_feather
            )
        finally:
            if mask_pil is not None:
                mask_pil.close()
            rgb_image.close()

        elapsed_ms = (time.perf_counter() - start_time) * 1000.0
        return result_image, elapsed_ms, tier_cfg, job_id


def extract_animation_frames(
    raw_image: Image.Image,
    max_frames: int = MAX_ANIMATION_FRAMES,
) -> tuple[list[tuple[Image.Image, int]], bool]:
    """
    Extracts individual RGBA frames and per-frame durations (in milliseconds)
    from a multi-frame image (GIF / animated WebP). Returns `([], False)` for
    single-frame images, or `(frames, truncated)` when `n_frames > 1`.
    """
    n_frames = int(getattr(raw_image, "n_frames", 1) or 1)
    if n_frames <= 1:
        return [], False
    width, height = raw_image.size
    pixel_cap = max(1, MAX_ANIMATION_PIXEL_BYTES // max(1, width * height * 4))
    limit = max(1, min(n_frames, max_frames, pixel_cap))
    frames: list[tuple[Image.Image, int]] = []
    for idx in range(limit):
        raw_image.seek(idx)
        raw_dur = int(raw_image.info.get("duration") or 0)
        # Browsers map 0..10ms GIF delays to 100ms per the HTML/GIF de-facto spec.
        duration_ms = 100 if raw_dur <= 10 else min(10_000, max(20, raw_dur))
        frames.append((raw_image.convert("RGBA"), duration_ms))
    return frames, n_frames > limit


def _rgba_to_gif_frame(rgba: Image.Image) -> tuple[Image.Image, bool]:
    """
    Quantizes a 32-bit RGBA image to a palette (`P`) frame suitable for GIF
    encoding, reserving palette index 255 for transparent pixels (`alpha < 128`)
    so transparent cutouts never leave black halos or bleed across frames.
    """
    rgba_img = rgba.convert("RGBA") if rgba.mode != "RGBA" else rgba
    alpha = np.asarray(rgba_img.getchannel("A"), dtype=np.uint8)
    has_transparent = bool((alpha < 128).any())
    rgb = rgba_img.convert("RGB")
    try:
        if not has_transparent:
            p_img = rgb.quantize(colors=256, method=Image.Quantize.FASTOCTREE)
            p_img.info["disposal"] = 2
            return p_img, False

        p_img = rgb.quantize(colors=255, method=Image.Quantize.FASTOCTREE)
        raw_palette = p_img.getpalette() or []
        palette = (raw_palette + [0] * 768)[:768]
        idx_arr = np.asarray(p_img, dtype=np.uint8).copy()
        idx_arr[alpha < 128] = 255
        out = Image.fromarray(idx_arr, mode="P")
        out.putpalette(palette)
        out.info["transparency"] = 255
        out.info["disposal"] = 2
        return out, True
    finally:
        rgb.close()
        if rgba_img is not rgba:
            rgba_img.close()


def encode_animated_image(
    frames: list[Image.Image],
    durations_ms: list[int],
    fmt: str = "gif",
) -> bytes:
    """
    Encodes a sequence of RGBA frames and per-frame durations (in ms) into an
    animated GIF (`fmt='gif'`) or animated WebP (`fmt='webp'`).
    """
    if not frames:
        raise ValueError("Cannot encode an empty animation.")
    norm_durations = [
        min(10_000, max(20, int(durations_ms[i]) if i < len(durations_ms) else 100))
        for i in range(len(frames))
    ]
    fmt_clean = (fmt or "gif").strip().lower()
    buf = io.BytesIO()
    try:
        if fmt_clean == "webp":
            rgba_frames = [f.convert("RGBA") if f.mode != "RGBA" else f for f in frames]
            try:
                rgba_frames[0].save(
                    buf,
                    format="WEBP",
                    save_all=True,
                    append_images=rgba_frames[1:],
                    duration=norm_durations,
                    loop=0,
                    quality=95,
                    method=4,
                )
            finally:
                for orig, conv in zip(frames, rgba_frames, strict=False):
                    if conv is not orig:
                        conv.close()
            return buf.getvalue()

        gif_frames: list[Image.Image] = []
        any_transparent = False
        try:
            for frame in frames:
                p_frame, is_trans = _rgba_to_gif_frame(frame)
                gif_frames.append(p_frame)
                any_transparent = any_transparent or is_trans
            save_kwargs: dict[str, Any] = {
                "format": "GIF",
                "save_all": True,
                "append_images": gif_frames[1:],
                "duration": norm_durations,
                "loop": 0,
                "disposal": 2,
                "optimize": False,
            }
            if any_transparent:
                save_kwargs["transparency"] = 255
            gif_frames[0].save(buf, **save_kwargs)
        finally:
            for p_frame in gif_frames:
                p_frame.close()
        return buf.getvalue()
    finally:
        buf.close()
