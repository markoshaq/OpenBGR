"""
Thread-safe BiRefNet model lifecycle manager, Hugging Face Hub cache inspection,
FP16 weight compaction, and preprocessing transforms.
"""

from __future__ import annotations

import gc
import os
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import torch
from huggingface_hub import HfApi, try_to_load_from_cache
from huggingface_hub.constants import HF_HUB_CACHE
from huggingface_hub.file_download import repo_folder_name
from torchvision import transforms
from transformers import AutoModelForImageSegmentation

from .config import (
    DEVICE,
    DEVICE_LABEL,
    DTYPE,
    IMAGENET_MEAN,
    IMAGENET_STD,
    MODELS,
    PRECISION_LABEL,
    logger,
)

# Cache compiled torchvision transform pipelines keyed by target (height, width).
_TRANSFORM_CACHE: dict[tuple[int, int], transforms.Compose] = {}


def get_preprocess_transform(
    resolution: int | tuple[int, int],
) -> transforms.Compose:
    """
    Returns a cached torchvision preprocessing pipeline that resizes an RGB PIL
    image to `(height, width)` and applies ImageNet normalization.
    """
    size_hw = (
        (resolution, resolution)
        if isinstance(resolution, int)
        else (int(resolution[0]), int(resolution[1]))
    )
    if size_hw not in _TRANSFORM_CACHE:
        _TRANSFORM_CACHE[size_hw] = transforms.Compose(
            [
                transforms.Resize(
                    size_hw,
                    interpolation=transforms.InterpolationMode.BILINEAR,
                ),
                transforms.ToTensor(),
                transforms.Normalize(IMAGENET_MEAN, IMAGENET_STD),
            ]
        )
    return _TRANSFORM_CACHE[size_hw]


def compute_dynamic_size(orig_w: int, orig_h: int, max_side: int) -> tuple[int, int]:
    """
    Computes a `(height, width)` pair for `BiRefNet_dynamic` that preserves the
    source image's aspect ratio within `[256, max_side]` while rounding both axes
    to multiples of 32 (required by the 4-stage Swin-L window/patch hierarchy).
    """
    long_side = max(1, orig_w, orig_h)
    if long_side > max_side:
        scale = max_side / float(long_side)
    elif long_side < 512:
        scale = 512.0 / float(long_side)
    else:
        scale = 1.0
    target_w = max(256, min(max_side, int(round((orig_w * scale) / 32.0)) * 32))
    target_h = max(256, min(max_side, int(round((orig_h * scale) / 32.0)) * 32))
    return (target_h, target_w)


def get_model_cache_dir(repo_id: str) -> Path:
    """Returns the local Hugging Face Hub cache directory for `repo_id`."""
    return Path(HF_HUB_CACHE) / repo_folder_name(repo_id=repo_id, repo_type="model")


def get_model_disk_bytes(repo_id: str) -> int:
    """Returns total bytes on disk occupied by `repo_id` inside the HF Hub cache."""
    try:
        folder = get_model_cache_dir(repo_id)
        if not folder.exists():
            return 0
        return sum(
            f.stat().st_size for f in folder.rglob("*") if f.is_file() and not f.is_symlink()
        )
    except Exception:
        return 0


# Shared job-progress state polled by `/api/progress`. `phase` is one of
# `idle | download | load | inference`; byte fields are only meaningful while
# `phase == "download"`.
JOB_PROGRESS_LOCK = threading.Lock()
JOB_PROGRESS: dict[str, Any] = {
    "phase": "idle",
    "model_key": None,
    "downloaded_bytes": 0,
    "total_bytes": 0,
}

_VALID_PHASES = {"idle", "download", "load", "inference"}


def set_job_phase(phase: str, model_key: str | None = None) -> None:
    """Publishes the current pipeline stage so the UI can render honest progress."""
    if phase not in _VALID_PHASES:
        return
    with JOB_PROGRESS_LOCK:
        if phase == "download" and JOB_PROGRESS["phase"] != "download":
            JOB_PROGRESS["downloaded_bytes"] = 0
            JOB_PROGRESS["total_bytes"] = 0
        JOB_PROGRESS["phase"] = phase
        if model_key is not None:
            JOB_PROGRESS["model_key"] = model_key
        if phase != "download":
            JOB_PROGRESS["downloaded_bytes"] = 0
            JOB_PROGRESS["total_bytes"] = 0


def _expected_download_bytes(repo_id: str) -> int:
    """Returns total remote bytes for `repo_id` via HF metadata (0 on failure)."""
    try:
        info = HfApi().model_info(repo_id, files_metadata=True)
        return int(sum(f.size or 0 for f in (info.siblings or [])))
    except Exception:
        return 0


def _download_progress_watcher(
    repo_id: str, model_key: str | None, stop: threading.Event
) -> None:
    """Polls the HF `blobs/` dir (including `*.incomplete` files) for byte progress."""
    blob_dir = get_model_cache_dir(repo_id) / "blobs"
    total = _expected_download_bytes(repo_id)
    while not stop.is_set():
        try:
            downloaded = (
                sum(f.stat().st_size for f in blob_dir.rglob("*") if f.is_file())
                if blob_dir.exists()
                else 0
            )
        except OSError:
            downloaded = 0
        with JOB_PROGRESS_LOCK:
            JOB_PROGRESS["phase"] = "download"
            if model_key is not None:
                JOB_PROGRESS["model_key"] = model_key
            JOB_PROGRESS["downloaded_bytes"] = downloaded
            if total:
                JOB_PROGRESS["total_bytes"] = total
        stop.wait(0.4)


@contextmanager
def track_model_download(repo_id: str, model_key: str | None = None) -> Iterator[None]:
    """
    Reports live Hugging Face download progress into `JOB_PROGRESS` while the
    wrapped block fetches weights. Works for both `snapshot_download` and
    `from_pretrained`, since both stream into `blobs/*.incomplete` on disk.
    """
    set_job_phase("download", model_key)
    stop = threading.Event()
    watcher = threading.Thread(
        target=_download_progress_watcher,
        args=(repo_id, model_key, stop),
        daemon=True,
    )
    watcher.start()
    try:
        yield
    finally:
        stop.set()
        watcher.join(timeout=2.0)


def _resolve_cache_lookup() -> Any:
    """Returns `try_to_load_from_cache`, honoring any test patch on `app`."""
    app_mod = sys.modules.get("app")
    if app_mod is not None and hasattr(app_mod, "try_to_load_from_cache"):
        return app_mod.try_to_load_from_cache
    return try_to_load_from_cache


def compact_model_cache_fp16(repo_id: str) -> int:
    """
    Compacts any FP32 `model.safetensors` checkpoint in the local HF cache (such as
    `BiRefNet-matting` at 844 MB) down to FP16 (~424 MB) in-place on disk.
    Returns the number of bytes saved, or 0 if already FP16.
    """
    try:
        from safetensors import safe_open
        from safetensors.torch import load_file, save_file

        lookup = _resolve_cache_lookup()
        cached_path = lookup(repo_id, "model.safetensors")
        if not isinstance(cached_path, str) or not os.path.exists(cached_path):
            return 0
        blob_path = Path(os.path.realpath(cached_path))
        if not blob_path.is_file():
            return 0

        needs_fp16 = False
        metadata: dict[str, str] = {}
        with safe_open(str(blob_path), framework="pt", device="cpu") as f:
            metadata = f.metadata() or {}
            for k in list(f.keys())[:8]:
                if f.get_slice(k).get_dtype() == "F32":
                    needs_fp16 = True
                    break
        if not needs_fp16:
            return 0

        old_size = blob_path.stat().st_size
        tensors = load_file(str(blob_path), device="cpu")
        fp16_tensors = {
            k: (v.half() if v.is_floating_point() and v.dtype == torch.float32 else v)
            for k, v in tensors.items()
        }
        del tensors
        tmp_path = blob_path.with_suffix(".fp16.tmp")
        save_file(fp16_tensors, str(tmp_path), metadata=metadata or {"format": "pt"})
        del fp16_tensors
        os.replace(tmp_path, blob_path)
        new_size = blob_path.stat().st_size
        saved = max(0, old_size - new_size)
        if saved > 0:
            logger.info(
                "[Model] Compacted %s cache to FP16 (%.1f MB -> %.1f MB).",
                repo_id,
                old_size / 1024**2,
                new_size / 1024**2,
            )
        return saved
    except Exception as exc:
        logger.warning("[Model] Failed to compact %s cache to FP16: %s", repo_id, exc)
        return 0


def is_model_cached_locally(repo_id: str) -> bool:
    """
    Checks whether a Hugging Face model's weight file (`model.safetensors`) is
    already present in the local disk cache without making any network requests.
    """
    try:
        lookup = _resolve_cache_lookup()
        cached_path = lookup(repo_id, "model.safetensors")
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
    given time. When switching between checkpoints (e.g. `lite` Swin-T vs a
    Swin-L variant), the previous model is explicitly dereferenced and
    hardware caches are flushed before allocating the new weights.
    """

    def __init__(self) -> None:
        """Initializes the unloaded state, job lock, and cancellation epoch."""
        self._lock = threading.Lock()
        self.inference_lock = threading.Lock()
        self.cancel_epoch: int = 0
        self.active_model_key: str | None = None
        self.model: torch.nn.Module | None = None

    def request_cancel(self) -> int:
        """Increments the cancellation epoch so any queued or active job aborts early."""
        self.cancel_epoch += 1
        return self.cancel_epoch

    def check_cancelled(self, job_epoch: int) -> None:
        """Raises `InterruptedError` if a cancellation occurred since `job_epoch` started."""
        if job_epoch < self.cancel_epoch:
            raise InterruptedError("Segmentation job was cancelled by the user.")

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

    def unload(self) -> None:
        """Explicitly unloads the active model and flushes device memory."""
        with self._lock:
            if self.model is not None:
                del self.model
                self.model = None
                self.active_model_key = None
            self.flush_device_memory()

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
                logger.info("[Memory] Evicting previous backbone (%s)...", self.active_model_key)
                del self.model
                self.model = None
                self.active_model_key = None
                self.flush_device_memory()

            repo_id = MODELS[model_key]
            logger.info("[Model] Loading %s (%s) on %s...", repo_id, PRECISION_LABEL, DEVICE_LABEL)
            set_job_phase("load", model_key)

            try:
                loaded_model = AutoModelForImageSegmentation.from_pretrained(
                    repo_id,
                    trust_remote_code=True,
                    local_files_only=True,
                )
                logger.info("[Model] Loaded %s from local offline cache.", repo_id)
            except Exception:
                logger.info(
                    "[Model] %s not found in local cache. "
                    "Downloading weights from Hugging Face Hub (one-time)...",
                    repo_id,
                )
                with track_model_download(repo_id, model_key):
                    loaded_model = AutoModelForImageSegmentation.from_pretrained(
                        repo_id,
                        trust_remote_code=True,
                        local_files_only=False,
                    )
                logger.info("[Model] Download complete for %s.", repo_id)
                set_job_phase("load", model_key)
                compact_model_cache_fp16(repo_id)

            loaded_model.to(device=DEVICE, dtype=DTYPE)
            loaded_model.eval()

            self.model = loaded_model
            self.active_model_key = model_key
            return self.model


MANAGER = ModelManager()
