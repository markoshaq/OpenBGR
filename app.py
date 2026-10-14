import gc
import io
import os
import platform
import subprocess
import threading
import time
import warnings
import webbrowser
from pathlib import Path
from typing import Optional

# Enable automatic CPU fallback for any PyTorch MPS op not yet native on Apple Silicon
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

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
STATIC_DIR.mkdir(exist_ok=True)

# Optimize CPU thread utilization for systems without a dedicated GPU
if os.cpu_count():
    torch.set_num_threads(max(1, min(8, os.cpu_count() or 4)))

MODELS = {
    "lite": "ZhengPeng7/BiRefNet_lite",
    "full": "ZhengPeng7/BiRefNet",
}

TIERS = {
    "low": {
        "key": "low",
        "label": "Low-End",
        "sublabel": "Fast • 768px Lite",
        "model_key": "lite",
        "repo_id": MODELS["lite"],
        "resolution": 768,
        "description": "Fastest inference (~0.6s GPU / ~2.5s CPU). Best for integrated graphics, older laptops, or batch speed.",
    },
    "mid": {
        "key": "mid",
        "label": "Mid-Range",
        "sublabel": "Balanced • 1024px Lite",
        "model_key": "lite",
        "repo_id": MODELS["lite"],
        "resolution": 1024,
        "description": "High-resolution 1024px alpha matting with low memory footprint. Recommended for most systems.",
    },
    "high": {
        "key": "high",
        "label": "High-End",
        "sublabel": "Ultra • 1024px Full",
        "model_key": "full",
        "repo_id": MODELS["full"],
        "resolution": 1024,
        "description": "Full Swin-L BiRefNet architecture for studio-grade hair strands, fur, and fine semi-transparent edges.",
    },
}


def get_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def get_device_label(device: torch.device) -> str:
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


def get_recommended_tier(device: torch.device) -> str:
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


DEVICE = get_device()
DEVICE_LABEL = get_device_label(DEVICE)
DTYPE = torch.float16 if DEVICE.type in ("mps", "cuda") else torch.float32
PRECISION_LABEL = "FP16" if DTYPE == torch.float16 else "FP32"
RECOMMENDED_TIER = get_recommended_tier(DEVICE)

_TRANSFORMS: dict[int, transforms.Compose] = {}


def get_transform(res: int) -> transforms.Compose:
    if res not in _TRANSFORMS:
        _TRANSFORMS[res] = transforms.Compose(
            [
                transforms.Resize(
                    (res, res), interpolation=transforms.InterpolationMode.BILINEAR
                ),
                transforms.ToTensor(),
                transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
            ]
        )
    return _TRANSFORMS[res]


def is_model_cached(repo_id: str) -> bool:
    try:
        cached_path = try_to_load_from_cache(repo_id, "model.safetensors")
        return isinstance(cached_path, str) and os.path.exists(cached_path)
    except Exception:
        return False


class ModelManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.active_model_key: Optional[str] = None
        self.model: Optional[torch.nn.Module] = None

    def clear_memory(self) -> None:
        gc.collect()
        if DEVICE.type == "mps":
            try:
                torch.mps.empty_cache()
            except Exception:
                pass
        elif DEVICE.type == "cuda":
            torch.cuda.empty_cache()

    def load(self, model_key: str) -> torch.nn.Module:
        if model_key not in MODELS:
            raise ValueError(f"Unknown model key: {model_key}")

        with self._lock:
            if self.active_model_key == model_key and self.model is not None:
                return self.model

            if self.model is not None:
                print(f"[Memory] Unloading previous model ({self.active_model_key})...")
                del self.model
                self.model = None
                self.active_model_key = None
                self.clear_memory()

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
                    f"[Model] {repo_id} not in local cache yet. Downloading from Hugging Face (one-time)..."
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


def decontaminate_edges(rgb_image: Image.Image, alpha_np: np.ndarray) -> np.ndarray:
    """
    Removes background color bleed from semi-transparent edge pixels (hair/fur)
    by propagating nearby solid foreground colors into the transition boundary.
    """
    rgb_np = np.array(rgb_image, dtype=np.uint8)
    alpha_norm = alpha_np.astype(np.float32) / 255.0
    edge_mask = (alpha_norm > 0.03) & (alpha_norm < 0.94)
    if not np.any(edge_mask):
        return rgb_np

    fg_weight = np.clip((alpha_norm - 0.5) * 2.0, 0.0, 1.0)[..., None]
    rgb_f = rgb_np.astype(np.float32)

    dilated_pil = rgb_image.filter(ImageFilter.MaxFilter(5)).filter(
        ImageFilter.BoxBlur(1)
    )
    smooth_fg = np.array(dilated_pil, dtype=np.float32)

    blend_strength = (1.0 - fg_weight) * 0.65
    cleaned = np.where(
        edge_mask[..., None],
        rgb_f * (1.0 - blend_strength) + smooth_fg * blend_strength,
        rgb_f,
    )
    return np.clip(cleaned, 0, 255).astype(np.uint8)


def remove_background_pil(
    raw_image: Image.Image,
    tier: str = "mid",
    defringe: bool = True,
) -> tuple[Image.Image, float, dict]:
    if tier not in TIERS:
        tier = RECOMMENDED_TIER

    tier_cfg = TIERS[tier]
    model_key = tier_cfg["model_key"]
    res = tier_cfg["resolution"]

    model = MANAGER.load(model_key)

    start_t = time.perf_counter()

    image = ImageOps.exif_transpose(raw_image)
    orig_w, orig_h = image.size
    rgb_image = image.convert("RGB")

    transform = get_transform(res)
    input_tensor = transform(rgb_image).unsqueeze(0).to(device=DEVICE, dtype=DTYPE)

    with torch.no_grad():
        outputs = model(input_tensor)
        pred_logits = outputs[-1] if isinstance(outputs, (list, tuple)) else outputs
        preds = pred_logits.float().sigmoid().cpu()

    mask_pil = transforms.ToPILImage()(preds[0].squeeze(0)).resize(
        (orig_w, orig_h), resample=Image.Resampling.LANCZOS
    )

    alpha_np = np.array(mask_pil, dtype=np.uint8)
    if defringe:
        rgb_np = decontaminate_edges(rgb_image, alpha_np)
    else:
        rgb_np = np.array(rgb_image, dtype=np.uint8)

    rgba_np = np.dstack((rgb_np, alpha_np))
    result_image = Image.fromarray(rgba_np, mode="RGBA")

    elapsed_ms = (time.perf_counter() - start_t) * 1000.0
    return result_image, elapsed_ms, tier_cfg


app = FastAPI(
    title="REMOVEBG — Local Background Removal Studio",
    description="100% Local & Offline Background Removal powered by BiRefNet",
)


@app.on_event("startup")
def preload_cached_default_model() -> None:
    """If the default model is already cached on disk, warm it up in the background."""
    default_model_key = TIERS[RECOMMENDED_TIER]["model_key"]
    if is_model_cached(MODELS[default_model_key]):
        threading.Thread(
            target=lambda: MANAGER.load(default_model_key), daemon=True
        ).start()


@app.get("/api/status")
def api_status():
    tiers_status = {}
    for key, cfg in TIERS.items():
        tiers_status[key] = {
            **cfg,
            "cached": is_model_cached(cfg["repo_id"]),
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
):
    if tier not in TIERS:
        raise HTTPException(status_code=400, detail=f"Invalid hardware tier '{tier}'.")

    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    try:
        pil_img = Image.open(io.BytesIO(raw_bytes))
        pil_img.load()
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"Could not decode image file: {exc}"
        ) from exc

    try:
        result_img, elapsed_ms, tier_cfg = remove_background_pil(
            pil_img, tier=tier, defringe=defringe
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"Background removal failed: {exc}"
        ) from exc

    out_buf = io.BytesIO()
    # compress_level=1 is 100% lossless PNG while encoding ~4x faster than level 6
    result_img.save(out_buf, format="PNG", compress_level=1)
    png_bytes = out_buf.getvalue()

    headers = {
        "X-Inference-Time-Ms": f"{elapsed_ms:.1f}",
        "X-Tier-Used": f"{tier_cfg['label']} ({tier_cfg['sublabel']})",
        "X-Device": f"{DEVICE_LABEL} • {PRECISION_LABEL}",
        "X-Image-Width": str(result_img.width),
        "X-Image-Height": str(result_img.height),
        "Access-Control-Expose-Headers": "X-Inference-Time-Ms, X-Tier-Used, X-Device, X-Image-Width, X-Image-Height",
    }
    return Response(content=png_bytes, media_type="image/png", headers=headers)


@app.get("/")
def serve_index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "7860"))
    url = f"http://127.0.0.1:{port}"
    print("-" * 64)
    print("  REMOVEBG // LOCAL AI STUDIO")
    print(f"  Compute  : {DEVICE_LABEL} ({PRECISION_LABEL})")
    print(f"  Default  : {TIERS[RECOMMENDED_TIER]['label']} ({TIERS[RECOMMENDED_TIER]['sublabel']})")
    print(f"  Endpoint : {url}")
    print("-" * 64)

    if os.environ.get("NO_BROWSER") != "1":
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
