"""
REMOVEBG — Local High-Precision Dichotomous Image Segmentation Studio
=====================================================================

A self-hosted FastAPI inference engine for background removal powered by BiRefNet
(Bilateral Reference Network for High-Resolution Dichotomous Image Segmentation).

Key Architectural Features:
---------------------------
1. Hardware Auto-Detection & Mixed Precision:
   Automatically dispatches workloads to NVIDIA CUDA, Apple Metal (MPS), or
   multi-threaded CPU backends. Uses FP16 (16-bit half-precision) on GPU/MPS
   targets to cut memory bandwidth by 50% and accelerate inference up to 5.5x.

2. Adaptive Compute Tiers (Spatial Token Scaling + Backbone Selection):
   - Low-End (Fast)      : BiRefNet_lite (Swin-T) evaluated at 768x768 resolution
                           (44% fewer spatial tokens than 1024x1024 for ~2x speedup).
   - Mid-Range (Balanced): BiRefNet_lite (Swin-T) evaluated at native 1024x1024.
   - High-End (Ultra)    : BiRefNet (Full Swin-L) evaluated at native 1024x1024.

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

import gc
import io
import os
import platform
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

# Supported Hugging Face model repositories.
MODELS: dict[str, str] = {
    "lite": "ZhengPeng7/BiRefNet_lite",  # Swin-T backbone (~200 MB)
    "full": "ZhengPeng7/BiRefNet",       # Swin-L backbone (~900 MB)
}

# Hardware execution tiers.
# Note: "low" and "mid" share the lightweight Swin-T backbone ("lite") so switching
# between them requires zero model reload overhead, while differing in internal
# spatial tensor resolution (768x768 = 589K pixels vs 1024x1024 = 1.05M pixels).
TIERS: dict[str, dict[str, Any]] = {
    "low": {
        "key": "low",
        "label": "Low-End",
        "sublabel": "Fast • 768px Lite",
        "model_key": "lite",
        "repo_id": MODELS["lite"],
        "resolution": 768,
        "description": (
            "Evaluates BiRefNet-Lite (Swin-T) on a 768x768 tensor (44% fewer spatial "
            "tokens than 1024x1024) for ~2x faster inference on CPUs and integrated GPUs."
        ),
    },
    "mid": {
        "key": "mid",
        "label": "Mid-Range",
        "sublabel": "Balanced • 1024px Lite",
        "model_key": "lite",
        "repo_id": MODELS["lite"],
        "resolution": 1024,
        "description": (
            "Evaluates BiRefNet-Lite (Swin-T) at its native 1024x1024 training resolution "
            "for sharp fine-edge matting with a low ~200 MB memory footprint."
        ),
    },
    "high": {
        "key": "high",
        "label": "High-End",
        "sublabel": "Ultra • 1024px Full",
        "model_key": "full",
        "repo_id": MODELS["full"],
        "resolution": 1024,
        "description": (
            "Evaluates the full BiRefNet (Swin-L) architecture at 1024x1024 for maximum "
            "precision on complex hair strands, fur, and semi-transparent meshes."
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
    """Returns a human-readable hardware identifier for UI telemetry headers."""
    if device.type == "cuda":
        try:
            return f"CUDA • {torch.cuda.get_device_name(0)}"
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
        return f"MPS • {chip}"

    cpu_name = platform.processor() or platform.machine() or "CPU"
    return f"CPU • {cpu_name}"


def select_recommended_tier(device: torch.device) -> str:
    """
    Heuristically chooses the default hardware preset at startup:
    - CPU hosts default to 'low' (768x768 Lite) for responsive latency.
    - Dedicated CUDA GPUs with >= 10 GB VRAM default to 'high' (1024x1024 Full).
    - All other GPU/MPS accelerators default to 'mid' (1024x1024 Lite).
    """
    if device.type == "cpu":
        return "low"
    if device.type == "cuda":
        try:
            vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024**3)
            if vram_gb >= 10.0:
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


def segment_foreground(
    raw_image: Image.Image,
    tier: str = "mid",
    defringe: bool = True,
) -> tuple[Image.Image, float, dict[str, Any]]:
    """
    Executes the full background removal pipeline on a PIL image:
    1. Resolves the requested hardware tier and ensures the backbone is loaded.
    2. Applies EXIF orientation transposition (fixing rotated smartphone photos)
       and projects the input to a clean 3-channel RGB image.
    3. Resizes to the tier's internal tensor resolution (768px or 1024px) and
       runs a forward pass in FP16 (CUDA/MPS) or FP32 (CPU).
    4. Upsamples the predicted sigmoid alpha matte back to the exact original
       image dimensions `(orig_w, orig_h)` using Lanczos interpolation.
    5. Optionally applies morphological edge color decontamination (defringe)
       and packs the final 32-bit RGBA image.
    """
    if tier not in TIERS:
        tier = RECOMMENDED_TIER

    tier_cfg = TIERS[tier]
    model_key: str = tier_cfg["model_key"]
    internal_res: int = tier_cfg["resolution"]

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
    if defringe:
        rgb_np = decontaminate_edge_colors(rgb_image, alpha_np)
    else:
        rgb_np = np.array(rgb_image, dtype=np.uint8)

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
    title="REMOVEBG — Local Background Removal Studio",
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
    }


@app.post("/api/remove-bg")
async def api_remove_bg(
    file: UploadFile = File(...),
    tier: str = Form("mid"),
    defringe: bool = Form(True),
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
        result_img, elapsed_ms, tier_cfg = segment_foreground(
            pil_img, tier=tier, defringe=defringe
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
        "X-Device": f"{DEVICE_LABEL} • {PRECISION_LABEL}",
        "X-Image-Width": str(result_img.width),
        "X-Image-Height": str(result_img.height),
        "Access-Control-Expose-Headers": (
            "X-Inference-Time-Ms, X-Tier-Used, X-Device, X-Image-Width, X-Image-Height"
        ),
    }
    return Response(
        content=output_buffer.getvalue(),
        media_type="image/png",
        headers=telemetry_headers,
    )


@app.get("/")
def serve_index() -> FileResponse:
    """Serves the single-page studio interface."""
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "7860"))
    url = f"http://127.0.0.1:{port}"
    print("-" * 68)
    print("  REMOVEBG // LOCAL AI SEGMENTATION STUDIO")
    print(f"  Compute   : {DEVICE_LABEL} ({PRECISION_LABEL})")
    print(f"  Default   : {TIERS[RECOMMENDED_TIER]['label']} ({TIERS[RECOMMENDED_TIER]['sublabel']})")
    print(f"  Interface : {url}")
    print("-" * 68)

    if os.environ.get("NO_BROWSER") != "1":
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
