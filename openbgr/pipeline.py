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

    # Higher alpha pixels retain more of their original RGB; lower alpha pixels
    # receive stronger foreground color propagation.
    fg_weight = np.clip((alpha_norm - 0.5) * 2.0, 0.0, 1.0)[..., None]
    rgb_float = rgb_np.astype(np.float32)

    # Dilate nearby solid foreground colors outward and smooth transitions.
    dilated_pil = (
        Image.fromarray(rgb_np).filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.BoxBlur(1))
    )
    smooth_fg = np.array(dilated_pil, dtype=np.float32)
    dilated_pil.close()

    blend_strength = (1.0 - fg_weight) * 0.65
    cleaned_rgb = np.where(
        edge_mask[..., None],
        rgb_float * (1.0 - blend_strength) + smooth_fg * blend_strength,
        rgb_float,
    )
    return np.clip(cleaned_rgb, 0, 255).astype(np.uint8)


def suppress_color_spill(
    rgb_np: np.ndarray, mask_pil: Image.Image, alpha_norm: np.ndarray
) -> np.ndarray:
    """
    Neutralizes background color spill (rim reflections & color bounce) along
    the outer boundary of the subject and inside semi-transparent glass/hair.

    Algorithm:
    1. Estimates the local removed background RGB color (`local_bg`) adjacent to
       the subject via normalized box-filter convolution over background pixels (`alpha < 0.15`).
    2. Computes a spill receiver weight map combining:
       - The outer solid rim of the subject (via morphological erosion `MinFilter(15)`).
       - Semi-transparent regions (`0.02 < alpha < 0.98`, such as hair, glass, or sheer fabric).
    3. Projects each receiver pixel's chromatic vector (`RGB - Luma`) onto the local
       background's chromatic vector (`B_local - B_luma`). Any positive chromatic alignment
       (indicating background color bounce/spill) is subtracted while preserving 100% of
       the pixel's original luminance and sharpness.
    """
    bg_mask = (alpha_norm < 0.15).astype(np.float32)
    if not np.any(bg_mask > 0):
        return rgb_np

    rgb_float = rgb_np.astype(np.float32)

    # Compute spatially-varying local background color via fast C-accelerated BoxBlur
    bg_weight_u8 = (bg_mask * 255.0).astype(np.uint8)
    bg_weight_blur = (
        np.array(
            Image.fromarray(bg_weight_u8).filter(ImageFilter.BoxBlur(24)),
            dtype=np.float32,
        )
        / 255.0
    )

    prem_bg_u8 = np.clip(rgb_float * bg_mask[..., None], 0, 255).astype(np.uint8)
    prem_bg_blur = np.array(
        Image.fromarray(prem_bg_u8).filter(ImageFilter.BoxBlur(24)),
        dtype=np.float32,
    )

    # Fall back to global median background color where local background weight is zero
    global_bg = np.median(rgb_float[bg_mask > 0.5], axis=0)
    valid_w = bg_weight_blur[..., None] > 0.02
    local_bg = np.where(
        valid_w,
        prem_bg_blur / np.maximum(bg_weight_blur[..., None], 0.02),
        global_bg,
    )

    # Build rim + semi-transparent receiver weight map
    eroded_norm = np.array(mask_pil.filter(ImageFilter.MinFilter(15)), dtype=np.float32) / 255.0
    solid_rim_weight = np.clip(alpha_norm - eroded_norm, 0.0, 1.0)
    translucent_weight = np.clip(4.0 * alpha_norm * (1.0 - alpha_norm), 0.0, 1.0)
    receiver_weight = np.clip(
        np.maximum(solid_rim_weight * 0.7, translucent_weight * 0.85), 0.0, 1.0
    ) * (alpha_norm > 0.02)

    if not np.any(receiver_weight > 0.01):
        return rgb_np

    # Chromatic projection: isolate color cast without altering pixel luminance
    fg_luma = np.mean(rgb_float, axis=-1, keepdims=True)
    bg_luma = np.mean(local_bg, axis=-1, keepdims=True)
    fg_chroma = rgb_float - fg_luma
    bg_chroma = local_bg - bg_luma

    bg_chroma_norm_sq = np.sum(bg_chroma * bg_chroma, axis=-1, keepdims=True) + 1e-5
    proj = np.sum(fg_chroma * bg_chroma, axis=-1, keepdims=True) / bg_chroma_norm_sq
    # Only subtract positive chromatic alignment (up to 100% of background chroma)
    spill_amount = np.clip(proj, 0.0, 1.0) * receiver_weight[..., None]

    despilled = rgb_float - spill_amount * bg_chroma
    return np.clip(despilled, 0, 255).astype(np.uint8)


# Cached raw outputs of the most recent segmentation job. Storing the
# pre-refinement RGB and alpha lets /api/refine re-apply the edge filters
# (defringe/despill) in ~20ms without re-running the neural network.
_JOB_ID_SEQ = itertools.count(1)
_LAST_JOB: dict[str, Any] = {}
_LAST_JOB_LOCK = threading.Lock()


def compose_rgba(
    rgb_raw: np.ndarray, alpha_np: np.ndarray, defringe: bool, despill: bool
) -> Image.Image:
    """
    Applies the optional edge-refinement filters onto the raw RGB + alpha and
    composites the final 32-bit RGBA image. Runs in milliseconds (pure NumPy /
    Pillow C filters); no neural network involved.
    """
    if defringe:
        rgb_np = decontaminate_edge_colors(rgb_raw, alpha_np)
    else:
        rgb_np = rgb_raw
    if despill:
        alpha_norm = alpha_np.astype(np.float32) / 255.0
        mask_pil = Image.fromarray(alpha_np)
        try:
            rgb_np = suppress_color_spill(rgb_np, mask_pil, alpha_norm)
        finally:
            mask_pil.close()
    return Image.fromarray(np.dstack((rgb_np, alpha_np)))


def segment_foreground(
    raw_image: Image.Image,
    tier: str = "general",
    defringe: bool = True,
    despill: bool = True,
    matting: bool = False,
    job_epoch: int | None = None,
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
            # Explicitly release GPU/MPS tensors immediately after forward pass
            del input_tensor, outputs, pred_logits, alpha_tensor

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
            result_image = compose_rgba(rgb_np_raw, alpha_np, defringe, despill)
        finally:
            mask_pil.close()
            rgb_image.close()

        elapsed_ms = (time.perf_counter() - start_time) * 1000.0
        return result_image, elapsed_ms, tier_cfg, job_id
