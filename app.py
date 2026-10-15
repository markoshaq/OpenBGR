# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "torch>=2.5.0",
#   "torchvision>=0.20.0",
#   "transformers>=4.45.0,<5.0.0",
#   "huggingface-hub>=0.25.0",
#   "timm>=1.0.0",
#   "kornia>=0.7.0",
#   "einops>=0.8.0",
#   "scipy>=1.14.0",
#   "pillow>=10.4.0",
#   "fastapi>=0.115.0",
#   "uvicorn>=0.30.0",
#   "python-multipart>=0.0.9",
#   "pywebview>=5.0",
# ]
# ///
"""
OpenBGR — Local Background Removal Studio
=========================================

A self-hosted FastAPI inference engine for background removal powered by BiRefNet
(Bilateral Reference Network for High-Resolution Dichotomous Image Segmentation).

Key Architectural Features:
---------------------------
1. Hardware Auto-Detection & Mixed Precision:
   Automatically dispatches workloads to NVIDIA CUDA, Apple Metal (MPS), or
   multi-threaded CPU backends. Uses FP16 (16-bit half-precision) on GPU/MPS
   targets to cut memory bandwidth by 50% and accelerate inference up to 5.5x.

2. Three Distinct BiRefNet Model Architectures:
   - Low-End (Lite 1K)   : `ZhengPeng7/BiRefNet_lite` (Swin-T @ 1024x1024, ~110 MB FP16)
                           Designed for CPU-only laptops, integrated GPUs, and fast batching.
   - Mid-Range (Full 1K) : `ZhengPeng7/BiRefNet` (Swin-L @ 1024x1024, ~440 MB FP16)
                           Default on Apple Silicon (MPS) and CUDA GPUs for studio hair/fur detail.
   - High-End (Ultra 2K) : `ZhengPeng7/BiRefNet_HR` (Swin-L @ 2048x2048, ~440 MB weights + 4x tokens)
                           Trained natively at 2048x2048 (4.19M pixels) for 4K/8K photography.

3. Deterministic Memory Lifecycle (`ModelManager`):
   Thread-safe singleton model loader that explicitly evicts inactive backbones
   and flushes hardware allocator caches (`torch.cuda.empty_cache()` /
   `torch.mps.empty_cache()`) when switching between Lite and Full models.

4. Cache-First Air-Gapped Loading:
   Probes local Hugging Face cache (`local_files_only=True`) before opening any
   network sockets, ensuring 100% offline operation after initial weight hydration.

5. Morphological Edge Color Decontamination (Defringe):
   Eliminates background color halos in semi-transparent boundary pixels
   (0.03 < alpha < 0.94) via C-accelerated morphological dilation and box-filtered
   foreground color propagation.
"""

from __future__ import annotations

import asyncio
import base64
import gc
import io
import os
import platform
import shutil
import socket
import subprocess
import threading
import time
import warnings
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

# Must be set before importing PyTorch so any non-native Apple Silicon MPS operator
# transparently falls back to CPU execution without raising a runtime error.
os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
warnings.filterwarnings("ignore", category=FutureWarning)

import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from huggingface_hub import try_to_load_from_cache
from PIL import Image, ImageFilter, ImageOps
from torchvision import transforms
from transformers import AutoModelForImageSegmentation

# ---------------------------------------------------------------------------
# Path & Runtime Configuration
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
STATIC_DIR.mkdir(exist_ok=True)

# Scale intra-op CPU parallelism for machines running without a GPU accelerator.
if os.cpu_count():
    torch.set_num_threads(max(1, min(8, os.cpu_count() or 4)))

# ImageNet normalization constants required by BiRefNet Swin-T / Swin-L backbones.
IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]

def get_system_memory_gb() -> float:
    """Estimates total system or GPU memory in GiB to prevent swap thrashing on 2K tensors."""
    if torch.cuda.is_available():
        try:
            return torch.cuda.get_device_properties(0).total_memory / (1024**3)
        except Exception:
            pass
    if platform.system() == "Darwin":
        try:
            mem_bytes = int(
                subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True).strip()
            )
            return mem_bytes / (1024**3)
        except Exception:
            pass
    try:
        page_size = os.sysconf("SC_PAGE_SIZE")
        page_count = os.sysconf("SC_PHYS_PAGES")
        if page_size > 0 and page_count > 0:
            return (page_size * page_count) / (1024**3)
    except Exception:
        pass
    return 16.0


SYSTEM_MEMORY_GB: float = get_system_memory_gb()
# Evaluating BiRefNet_HR at 2048x2048 allocates >6 GB of intermediate attention feature
# pyramids; on 8 GB systems, 1536x1536 (2.25x pixel density of 1024x1024) prevents swap thrashing.
HR_RESOLUTION: int = 2048 if SYSTEM_MEMORY_GB >= 14.0 else 1536

# Supported Hugging Face model repositories — each tier maps to a distinct trained model,
# plus `ZhengPeng7/BiRefNet-matting` for trimap-free alpha matting of glass/water/sheer materials.
MODELS: dict[str, str] = {
    "lite": "ZhengPeng7/BiRefNet_lite",         # Swin-T backbone trained at 1024x1024
    "full": "ZhengPeng7/BiRefNet",              # Swin-L backbone trained at 1024x1024
    "hr": "ZhengPeng7/BiRefNet_HR",             # Swin-L high-res backbone (1536px / 2048px)
    "matting": "ZhengPeng7/BiRefNet-matting",   # Swin-L alpha matting backbone for glass/sheer/water
}

# Hardware execution tiers. Each tier loads a dedicated BiRefNet checkpoint.
TIERS: dict[str, dict[str, Any]] = {
    "low": {
        "key": "low",
        "label": "Low-End",
        "sublabel": "Lite / 1024px Swin-T",
        "model_key": "lite",
        "repo_id": MODELS["lite"],
        "resolution": 1024,
        "description": (
            "Lightweight BiRefNet_lite (Swin-T) at 1024x1024 (~110 MB in FP16). "
            "Fastest inference for CPU-only machines and integrated graphics."
        ),
    },
    "mid": {
        "key": "mid",
        "label": "Mid-Range",
        "sublabel": "Full / 1024px Swin-L",
        "model_key": "full",
        "repo_id": MODELS["full"],
        "resolution": 1024,
        "description": (
            "Full BiRefNet (Swin-L) at 1024x1024 (~440 MB in FP16). Default for Apple "
            "Silicon and GPUs, delivering studio-grade hair, fur, and soft edge matting."
        ),
    },
    "high": {
        "key": "high",
        "label": "High-End",
        "sublabel": f"Ultra HR / {HR_RESOLUTION}px Swin-L",
        "model_key": "hr",
        "repo_id": MODELS["hr"],
        "resolution": HR_RESOLUTION,
        "description": (
            f"High-Resolution BiRefNet_HR (Swin-L) evaluated at {HR_RESOLUTION}x{HR_RESOLUTION} "
            "for high-megapixel commercial photography and micro-strand detail."
        ),
    },
}


# ---------------------------------------------------------------------------
# Hardware Discovery & Auto-Tuning
# ---------------------------------------------------------------------------


def detect_compute_device() -> torch.device:
    """
    Selects the fastest available PyTorch compute device in priority order:
    1. NVIDIA CUDA / AMD ROCm (`cuda`)
    2. Apple Silicon Metal Performance Shaders (`mps`)
    3. Multi-threaded Host CPU (`cpu`)
    """
    if torch.cuda.is_available():
        return torch.device("cuda")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def format_device_label(device: torch.device) -> str:
    """Returns an ASCII-safe hardware identifier for UI telemetry and HTTP headers."""
    if device.type == "cuda":
        try:
            return f"CUDA / {torch.cuda.get_device_name(0)}"
        except Exception:
            return "NVIDIA CUDA GPU"

    if device.type == "mps":
        chip = "Apple Silicon"
        if platform.system() == "Darwin":
            try:
                out = subprocess.check_output(
                    ["sysctl", "-n", "machdep.cpu.brand_string"], text=True
                ).strip()
                if out:
                    chip = out
            except Exception:
                pass
        return f"MPS / {chip}"

    cpu_name = platform.processor() or platform.machine() or "CPU"
    return f"CPU / {cpu_name}"


def select_recommended_tier(device: torch.device) -> str:
    """
    Heuristically chooses the default hardware preset at startup:
    - CPU hosts default to 'low' (1024x1024 BiRefNet_lite) for responsive latency.
    - Dedicated CUDA GPUs with >= 16 GB VRAM default to 'high' (2048x2048 BiRefNet_HR).
    - All other GPU/MPS accelerators default to 'mid' (1024x1024 Full BiRefNet Swin-L).
    """
    if device.type == "cpu":
        return "low"
    if device.type == "cuda":
        try:
            vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024**3)
            if vram_gb >= 16.0:
                return "high"
        except Exception:
            pass
    return "mid"


DEVICE: torch.device = detect_compute_device()
DEVICE_LABEL: str = format_device_label(DEVICE)

# Use FP16 half-precision on GPU accelerators (CUDA / MPS) to halve memory usage
# and maximize tensor throughput; retain FP32 on CPU for numerical compatibility.
DTYPE: torch.dtype = torch.float16 if DEVICE.type in ("mps", "cuda") else torch.float32
PRECISION_LABEL: str = "FP16" if DTYPE == torch.float16 else "FP32"
RECOMMENDED_TIER: str = select_recommended_tier(DEVICE)

# Cache compiled torchvision transform pipelines keyed by target resolution.
_TRANSFORM_CACHE: dict[int, transforms.Compose] = {}


def get_preprocess_transform(resolution: int) -> transforms.Compose:
    """
    Returns a cached torchvision preprocessing pipeline that resizes an RGB PIL
    image to `(resolution, resolution)` and applies ImageNet normalization.
    """
    if resolution not in _TRANSFORM_CACHE:
        _TRANSFORM_CACHE[resolution] = transforms.Compose(
            [
                transforms.Resize(
                    (resolution, resolution),
                    interpolation=transforms.InterpolationMode.BILINEAR,
                ),
                transforms.ToTensor(),
                transforms.Normalize(IMAGENET_MEAN, IMAGENET_STD),
            ]
        )
    return _TRANSFORM_CACHE[resolution]


def is_model_cached_locally(repo_id: str) -> bool:
    """
    Checks whether a Hugging Face model's weight file (`model.safetensors`) is
    already present in the local disk cache without making any network requests.
    """
    try:
        cached_path = try_to_load_from_cache(repo_id, "model.safetensors")
        return isinstance(cached_path, str) and os.path.exists(cached_path)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Thread-Safe Model Lifecycle Manager
# ---------------------------------------------------------------------------


class ModelManager:
    """
    Manages the lifecycle of BiRefNet segmentation models in device memory.

    Ensures only one model backbone is resident in VRAM / Unified RAM at any
    given time. When switching between `lite` (Swin-T) and `full` (Swin-L),
    the previous model is explicitly dereferenced and hardware caches are
    flushed before allocating the new weights.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.active_model_key: Optional[str] = None
        self.model: Optional[torch.nn.Module] = None

    def flush_device_memory(self) -> None:
        """Forces Python garbage collection and releases unused GPU/MPS cache blocks."""
        gc.collect()
        if DEVICE.type == "mps":
            try:
                torch.mps.empty_cache()
            except Exception:
                pass
        elif DEVICE.type == "cuda":
            torch.cuda.empty_cache()

    def get_or_load(self, model_key: str) -> torch.nn.Module:
        """
        Returns the requested model instance, loading it into device memory if
        it is not currently active.

        Attempts an offline cache load (`local_files_only=True`) first so that
        zero external network calls are made once weights are cached locally.
        """
        if model_key not in MODELS:
            raise ValueError(f"Unsupported model key: {model_key}")

        with self._lock:
            # Fast path: requested backbone is already resident in memory.
            if self.active_model_key == model_key and self.model is not None:
                return self.model

            # Evict currently loaded backbone before allocating a new one.
            if self.model is not None:
                print(f"[Memory] Evicting previous backbone ({self.active_model_key})...")
                del self.model
                self.model = None
                self.active_model_key = None
                self.flush_device_memory()

            repo_id = MODELS[model_key]
            print(f"[Model] Loading {repo_id} ({PRECISION_LABEL}) on {DEVICE_LABEL}...")

            try:
                loaded_model = AutoModelForImageSegmentation.from_pretrained(
                    repo_id,
                    trust_remote_code=True,
                    local_files_only=True,
                )
                print(f"[Model] Loaded {repo_id} from local offline cache.")
            except Exception:
                print(
                    f"[Model] {repo_id} not found in local cache. "
                    "Downloading weights from Hugging Face Hub (one-time)..."
                )
                loaded_model = AutoModelForImageSegmentation.from_pretrained(
                    repo_id,
                    trust_remote_code=True,
                    local_files_only=False,
                )
                print(f"[Model] Download complete for {repo_id}.")

            loaded_model.to(device=DEVICE, dtype=DTYPE)
            loaded_model.eval()

            self.model = loaded_model
            self.active_model_key = model_key
            return self.model


MANAGER = ModelManager()


# ---------------------------------------------------------------------------
# Computer Vision Post-Processing & Matting Pipeline
# ---------------------------------------------------------------------------


def decontaminate_edge_colors(
    rgb_image: Image.Image, alpha_np: np.ndarray
) -> np.ndarray:
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
    rgb_np = np.array(rgb_image, dtype=np.uint8)
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
    dilated_pil = rgb_image.filter(ImageFilter.MaxFilter(5)).filter(
        ImageFilter.BoxBlur(1)
    )
    smooth_fg = np.array(dilated_pil, dtype=np.float32)

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
            Image.fromarray(bg_weight_u8, mode="L").filter(ImageFilter.BoxBlur(24)),
            dtype=np.float32,
        )
        / 255.0
    )

    prem_bg_u8 = np.clip(rgb_float * bg_mask[..., None], 0, 255).astype(np.uint8)
    prem_bg_blur = np.array(
        Image.fromarray(prem_bg_u8, mode="RGB").filter(ImageFilter.BoxBlur(24)),
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
    eroded_norm = (
        np.array(mask_pil.filter(ImageFilter.MinFilter(15)), dtype=np.float32) / 255.0
    )
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


def segment_foreground(
    raw_image: Image.Image,
    tier: str = "mid",
    defringe: bool = True,
    despill: bool = True,
    matting: bool = False,
) -> tuple[Image.Image, float, dict[str, Any]]:
    """
    Executes the full background removal pipeline on a PIL image:
    1. Resolves the requested hardware tier (or `BiRefNet-matting` when `matting=True`)
       and ensures the backbone is loaded.
    2. Applies EXIF orientation transposition (fixing rotated smartphone photos)
       and projects the input to a clean 3-channel RGB image.
    3. Resizes to the tier's internal tensor resolution and runs a forward pass
       in FP16 (CUDA/MPS) or FP32 (CPU).
    4. Upsamples the predicted sigmoid alpha matte back to the exact original
       image dimensions `(orig_w, orig_h)` using Lanczos interpolation.
    5. Optionally applies morphological edge color decontamination (`defringe`)
       and rim color spill / reflection suppression (`despill`).
    """
    if tier not in TIERS:
        tier = RECOMMENDED_TIER

    tier_cfg = dict(TIERS[tier])
    if matting:
        model_key = "matting"
        internal_res = 1024
        tier_cfg["sublabel"] = "Matting / 1024px Glass & Sheer"
    else:
        model_key = tier_cfg["model_key"]
        internal_res = tier_cfg["resolution"]

    # Ensure model weights are resident in memory before starting inference timer.
    model = MANAGER.get_or_load(model_key)

    start_time = time.perf_counter()

    # Normalize EXIF orientation tags and convert any input mode (RGBA, P, L, CMYK) to RGB.
    oriented_image = ImageOps.exif_transpose(raw_image)
    orig_w, orig_h = oriented_image.size
    rgb_image = oriented_image.convert("RGB")

    # Prepare normalized input batch tensor [1, 3, H, W].
    preprocess = get_preprocess_transform(internal_res)
    input_tensor = preprocess(rgb_image).unsqueeze(0).to(device=DEVICE, dtype=DTYPE)

    # Execute forward pass without autograd tracking.
    with torch.no_grad():
        outputs = model(input_tensor)
        pred_logits = outputs[-1] if isinstance(outputs, (list, tuple)) else outputs
        # Cast back to FP32 before sigmoid to preserve smooth 8-bit alpha gradients.
        alpha_tensor = pred_logits.float().sigmoid().cpu()

    # Upsample predicted alpha mask to exact native source dimensions.
    mask_pil = transforms.ToPILImage()(alpha_tensor[0].squeeze(0)).resize(
        (orig_w, orig_h), resample=Image.Resampling.LANCZOS
    )

    alpha_np = np.array(mask_pil, dtype=np.uint8)
    alpha_norm = alpha_np.astype(np.float32) / 255.0

    if defringe:
        rgb_np = decontaminate_edge_colors(rgb_image, alpha_np)
    else:
        rgb_np = np.array(rgb_image, dtype=np.uint8)

    if despill:
        rgb_np = suppress_color_spill(rgb_np, mask_pil, alpha_norm)

    # Combine RGB channels with the 8-bit alpha matte into a 32-bit RGBA image.
    rgba_np = np.dstack((rgb_np, alpha_np))
    result_image = Image.fromarray(rgba_np, mode="RGBA")

    elapsed_ms = (time.perf_counter() - start_time) * 1000.0
    return result_image, elapsed_ms, tier_cfg


# ---------------------------------------------------------------------------
# FastAPI Application & HTTP Endpoints
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """
    Application lifespan hook. If the recommended default model is already
    present in the local Hugging Face cache, preloads it into device memory
    on a background daemon thread so the first request has zero cold-start latency.
    """
    default_model_key = TIERS[RECOMMENDED_TIER]["model_key"]
    if is_model_cached_locally(MODELS[default_model_key]):
        threading.Thread(
            target=lambda: MANAGER.get_or_load(default_model_key),
            daemon=True,
        ).start()
    yield


app = FastAPI(
    title="OpenBGR — Local Background Removal Studio",
    description="Self-hosted, zero-telemetry dichotomous image segmentation powered by BiRefNet",
    lifespan=lifespan,
)


@app.get("/api/status")
def api_status() -> dict[str, Any]:
    """
    Returns detected compute hardware, floating-point precision mode,
    recommended preset, and local offline cache availability for each tier.
    """
    tiers_status = {}
    for key, cfg in TIERS.items():
        tiers_status[key] = {
            **cfg,
            "cached": is_model_cached_locally(cfg["repo_id"]),
            "active": MANAGER.active_model_key == cfg["model_key"],
        }
    return {
        "device": DEVICE.type,
        "device_label": DEVICE_LABEL,
        "precision": PRECISION_LABEL,
        "recommended_tier": RECOMMENDED_TIER,
        "active_model": MANAGER.active_model_key,
        "tiers": tiers_status,
        "matting": {
            "repo_id": MODELS["matting"],
            "cached": is_model_cached_locally(MODELS["matting"]),
            "active": MANAGER.active_model_key == "matting",
        },
    }


@app.post("/api/remove-bg")
async def api_remove_bg(
    file: UploadFile = File(...),
    tier: str = Form("mid"),
    defringe: bool = Form(True),
    despill: bool = Form(True),
    matting: bool = Form(False),
) -> Response:
    """
    Accepts an uploaded image file and returns a full-resolution, lossless
    32-bit RGBA PNG along with performance telemetry HTTP headers.
    """
    if tier not in TIERS:
        raise HTTPException(status_code=400, detail=f"Invalid hardware preset '{tier}'.")

    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="Uploaded image file is empty.")

    try:
        pil_img = Image.open(io.BytesIO(raw_bytes))
        pil_img.load()
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"Unable to decode image file: {exc}"
        ) from exc

    try:
        # Offload blocking PyTorch inference to a worker thread so the ASGI
        # event loop stays responsive to status polls and client cancellation.
        result_img, elapsed_ms, tier_cfg = await asyncio.to_thread(
            segment_foreground, pil_img, tier, defringe, despill, matting
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"Segmentation pipeline failed: {exc}"
        ) from exc

    # Encode as 32-bit RGBA PNG. DEFLATE compress_level=1 is 100% lossless
    # while serializing ~4x faster than default level 6 on high-megapixel images.
    output_buffer = io.BytesIO()
    result_img.save(output_buffer, format="PNG", compress_level=1)

    telemetry_headers = {
        "X-Inference-Time-Ms": f"{elapsed_ms:.1f}",
        "X-Tier-Used": f"{tier_cfg['label']} ({tier_cfg['sublabel']})",
        "X-Device": f"{DEVICE_LABEL} / {PRECISION_LABEL}",
        "X-Image-Width": str(result_img.width),
        "X-Image-Height": str(result_img.height),
        "Access-Control-Expose-Headers": (
            "X-Inference-Time-Ms, X-Tier-Used, X-Device, X-Image-Width, X-Image-Height"
        ),
    }
    # Ensure all HTTP header values are strictly latin-1 safe per RFC 7230.
    safe_headers = {
        k: v.encode("latin-1", errors="ignore").decode("latin-1")
        for k, v in telemetry_headers.items()
    }
    return Response(
        content=output_buffer.getvalue(),
        media_type="image/png",
        headers=safe_headers,
    )


@app.get("/")
def serve_index() -> FileResponse:
    """Serves the single-page studio interface."""
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ---------------------------------------------------------------------------
# Native Desktop Window (pywebview) & Chromeless Browser Fallback
# ---------------------------------------------------------------------------


class DesktopApi:
    """
    JavaScript-to-Python bridge exposed as `window.pywebview.api` when running
    inside the native pywebview desktop window. Allows the frontend EXPORT button
    to open a native OS "Save As" file dialog.
    """

    def __init__(self) -> None:
        self.window: Any = None

    def save_file(self, data_base64: str, default_filename: str) -> dict[str, Any]:
        """Opens a native OS Save dialog and writes the base64-encoded image to disk."""
        if self.window is None:
            return {"saved": False, "error": "Desktop window is not initialized."}
        try:
            import webview

            dest = self.window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=default_filename,
            )
            if not dest:
                return {"saved": False, "cancelled": True}

            target_path = dest[0] if isinstance(dest, (list, tuple)) else str(dest)
            raw_bytes = base64.b64decode(data_base64)
            Path(target_path).write_bytes(raw_bytes)
            return {"saved": True, "path": target_path}
        except Exception as exc:
            return {"saved": False, "error": str(exc)}


def wait_for_server(host: str, port: int, timeout_s: float = 15.0) -> bool:
    """Polls until the local Uvicorn TCP socket is accepting connections."""
    deadline = time.perf_counter() + timeout_s
    while time.perf_counter() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.25):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def open_fallback_app_window(url: str) -> None:
    """
    Fallback if pywebview is unavailable (e.g. Linux without GTK WebKit).
    Attempts to open a chromeless standalone `--app` window via Chrome, Edge,
    or Brave before falling back to the default system web browser.
    """
    candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "google-chrome",
        "chromium",
        "chromium-browser",
        "brave-browser",
        "microsoft-edge",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    ]
    for binary in candidates:
        resolved = binary if os.path.exists(binary) else shutil.which(binary)
        if resolved:
            try:
                subprocess.Popen(
                    [resolved, f"--app={url}", "--window-size=1380,860"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                return
            except Exception:
                continue
    webbrowser.open(url)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "7860"))
    host = "127.0.0.1"
    url = f"http://{host}:{port}"

    print("-" * 68)
    print("  OpenBGR // LOCAL AI SEGMENTATION STUDIO")
    print(f"  Compute   : {DEVICE_LABEL} ({PRECISION_LABEL})")
    print(f"  Default   : {TIERS[RECOMMENDED_TIER]['label']} ({TIERS[RECOMMENDED_TIER]['sublabel']})")
    print(f"  Interface : {url}")
    print("-" * 68)

    # Headless / server-only mode when NO_BROWSER=1 or OPENBGR_BROWSER=1 is set
    if os.environ.get("NO_BROWSER") == "1":
        uvicorn.run(app, host=host, port=port, log_level="warning")
    elif os.environ.get("OPENBGR_BROWSER") == "1":
        threading.Timer(1.0, lambda: open_fallback_app_window(url)).start()
        uvicorn.run(app, host=host, port=port, log_level="warning")
    else:
        # Start FastAPI server in a background daemon thread and open native desktop window
        server_thread = threading.Thread(
            target=lambda: uvicorn.run(app, host=host, port=port, log_level="warning"),
            daemon=True,
        )
        server_thread.start()
        wait_for_server(host, port)

        try:
            import webview

            api_bridge = DesktopApi()
            window = webview.create_window(
                title="OpenBGR",
                url=url,
                width=1380,
                height=860,
                min_size=(980, 640),
                background_color="#09090b",
                js_api=api_bridge,
            )
            api_bridge.window = window
            webview.start()
        except Exception as exc:
            print(f"[Desktop] Native window unavailable ({exc}); opening app window...")
            open_fallback_app_window(url)
            server_thread.join()
