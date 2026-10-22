"""
Computer vision post-processing (edge color decontamination, color spill
suppression, RGBA composition) and neural foreground segmentation pipeline.
"""

from __future__ import annotations

import itertools
import threading
import time
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
    TIERS,
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
    global_bg = np.median(rgb_np[::8, ::8][bg_mask[::8, ::8] > 0.5], axis=0).astype(np.float32)

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


# Cached raw outputs of the most recent segmentation job. Storing the
# pre-refinement RGB and alpha lets /api/refine re-apply the edge filters
# (defringe/despill) in ~20ms without re-running the neural network.
_JOB_ID_SEQ = itertools.count(1)
_LAST_JOB: dict[str, Any] = {}
_LAST_JOB_LOCK = threading.Lock()

# Serializes compose_rgba across threads: segment_foreground runs it inside
# inference_lock while /api/refine calls it standalone. Concurrent passes
# would pile ~1GB of float32 temporaries onto a 24MP job.
_COMPOSE_LOCK = threading.Lock()


def get_last_job(job_id: int) -> dict[str, Any] | None:
    """
    Returns a snapshot of the cached last-job raw RGB/alpha iff `job_id`
    matches the latest completed job, else None. Keeps `_LAST_JOB` and its
    lock private to this module.
    """
    with _LAST_JOB_LOCK:
        job = dict(_LAST_JOB)
    return job if job.get("id") == job_id else None


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
        if defringe:
            rgb_np = decontaminate_edge_colors(rgb_raw, alpha_out)
        else:
            rgb_np = rgb_raw
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

        if tier_cfg.get("dynamic"):
            dyn_h, dyn_w = compute_dynamic_size(orig_w, orig_h, int(tier_cfg["resolution"]))
            preprocess = get_preprocess_transform((dyn_h, dyn_w))
            tier_cfg["sublabel"] = f"Dynamic / {dyn_w}x{dyn_h}"
        else:
            preprocess = get_preprocess_transform(int(tier_cfg["resolution"]))
        input_tensor: torch.Tensor | None = None
        outputs: Any = None
        pred_logits: torch.Tensor | None = None
        alpha_tensor: torch.Tensor | None = None

        try:
            input_tensor = preprocess(rgb_image).unsqueeze(0).to(device=DEVICE, dtype=DTYPE)
            MANAGER.check_cancelled(job_epoch)

            with torch.no_grad():
                outputs = model(input_tensor)
                pred_logits = outputs[-1] if isinstance(outputs, (list, tuple)) else outputs
                alpha_tensor = pred_logits.float().sigmoid().cpu()

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
        try:
            MANAGER.check_cancelled(job_epoch)
            alpha_np = np.array(mask_pil, dtype=np.uint8)
            rgb_np_raw = np.array(rgb_image, dtype=np.uint8)

            # Snapshot the raw RGB + alpha so /api/refine can re-apply the
            # edge filters later without re-running inference.
            with _LAST_JOB_LOCK:
                _LAST_JOB["id"] = job_id
                _LAST_JOB["rgb"] = rgb_np_raw
                _LAST_JOB["alpha"] = alpha_np

            MANAGER.check_cancelled(job_epoch)
            result_image = compose_rgba(
                rgb_np_raw, alpha_np, defringe, despill, edge_shift, edge_feather
            )
        finally:
            mask_pil.close()
            rgb_image.close()

        elapsed_ms = (time.perf_counter() - start_time) * 1000.0
        return result_image, elapsed_ms, tier_cfg, job_id
