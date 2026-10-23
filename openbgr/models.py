"""
Thread-safe BiRefNet model lifecycle manager, Hugging Face Hub cache inspection,
FP16 weight compaction, and preprocessing transforms.
"""

from __future__ import annotations

import functools
import gc
import importlib
import os
import shutil
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import torch
from huggingface_hub import HfApi, snapshot_download, try_to_load_from_cache
from huggingface_hub.constants import HF_HUB_CACHE
from huggingface_hub.file_download import repo_folder_name
from torchvision import transforms
from tqdm.auto import tqdm as _TqdmAuto
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
from .settings import offline_mode_enabled


@functools.lru_cache(maxsize=64)
def _build_preprocess_transform(size_hw: tuple[int, int]) -> transforms.Compose:
    """Builds the cached preprocessing pipeline for one (height, width) pair."""
    return transforms.Compose(
        [
            transforms.Resize(
                size_hw,
                interpolation=transforms.InterpolationMode.BILINEAR,
            ),
            transforms.ToTensor(),
            transforms.Normalize(IMAGENET_MEAN, IMAGENET_STD),
        ]
    )


def get_preprocess_transform(
    resolution: int | tuple[int, int],
) -> transforms.Compose:
    """
    Returns a cached torchvision preprocessing pipeline that resizes an RGB PIL
    image to `(height, width)` and applies ImageNet normalization. Bounded so
    the dynamic tier's per-image (h, w) pairs can't grow the cache forever.
    """
    size_hw = (
        (resolution, resolution)
        if isinstance(resolution, int)
        else (int(resolution[0]), int(resolution[1]))
    )
    return _build_preprocess_transform(size_hw)


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


# /api/status calls get_model_disk_bytes once per tier; a full HF cache rglob
# is slow enough to matter when the endpoint is polled, so results are cached
# briefly and the cache is dropped wherever model bytes can change.
_MODEL_DISK_BYTES_TTL_S = 30.0
_MODEL_DISK_BYTES_CACHE: dict[str, tuple[float, int]] = {}


def clear_model_disk_bytes_cache() -> None:
    """Drops cached disk sizes after a cache mutation (install/uninstall/import)."""
    _MODEL_DISK_BYTES_CACHE.clear()


def get_model_disk_bytes(repo_id: str) -> int:
    """Returns total bytes on disk occupied by `repo_id` inside the HF Hub cache."""
    now = time.monotonic()
    hit = _MODEL_DISK_BYTES_CACHE.get(repo_id)
    if hit is not None and now - hit[0] < _MODEL_DISK_BYTES_TTL_S:
        return hit[1]
    try:
        folder = get_model_cache_dir(repo_id)
        total = (
            sum(f.stat().st_size for f in folder.rglob("*") if f.is_file() and not f.is_symlink())
            if folder.exists()
            else 0
        )
    except Exception:
        total = 0
    _MODEL_DISK_BYTES_CACHE[repo_id] = (now, total)
    return total


# Shared job-progress state polled by `/api/progress`. `phase` is one of
# `idle | download | load | inference`; byte fields are only meaningful while
# `phase == "download"`.
JOB_PROGRESS_LOCK = threading.Lock()
JOB_PROGRESS: dict[str, Any] = {
    "phase": "idle",
    "model_key": None,
    "downloaded_bytes": 0,
    "total_bytes": 0,
    # Private: model key and cancel epoch of the download currently holding
    # `_MODEL_DOWNLOAD_LOCK`, consumed by /api/progress (popped before return).
    "_dl_key": None,
    "_dl_epoch": None,
}

_VALID_PHASES = {"idle", "download", "load", "inference"}

# Serializes model downloads and cache mutations (uninstall/import) so the
# shared progress state, the module-level tqdm patch below, and the HF cache
# directory are only ever mutated by one operation at a time.
_MODEL_DOWNLOAD_LOCK = threading.Lock()
# True only while `track_model_download` is actively transferring weights,
# so `model_download_guard` critical sections (uninstall/import) do not cause
# `/api/progress` to misreport `phase: "download"`.
_DOWNLOAD_IN_FLIGHT = False


def model_download_active() -> bool:
    """True while a model download is actively transferring weights."""
    return _DOWNLOAD_IN_FLIGHT


@contextmanager
def model_download_guard(blocking: bool = True) -> Iterator[None]:
    """
    Serializes an arbitrary critical section against in-flight model
    downloads (and blocks new ones while held). Used by the uninstall and
    import endpoints so a download cannot start between fast-fail checks and
    the cache mutation itself. With `blocking=False`, raises
    `BlockingIOError` instead of waiting when the lock is held.
    """
    if not _MODEL_DOWNLOAD_LOCK.acquire(blocking):
        raise BlockingIOError("a model download is in progress")
    try:
        yield
    finally:
        _MODEL_DOWNLOAD_LOCK.release()


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
        # When a download owned by another operation is in flight, its byte
        # counters must survive this operation's phase transitions (the
        # /api/progress endpoint derives the download phase from _DOWNLOAD_IN_FLIGHT).
        if phase != "download" and not _DOWNLOAD_IN_FLIGHT:
            JOB_PROGRESS["downloaded_bytes"] = 0
            JOB_PROGRESS["total_bytes"] = 0


# The module object behind `huggingface_hub.utils.tqdm`, NOT the `tqdm`
# class re-exported under the same attribute name. None when a future
# huggingface_hub moves the private module: `track_model_download` then
# degrades to phase-only progress with a warning instead of failing import.
try:
    _HF_TQDM_MODULE: Any = importlib.import_module("huggingface_hub.utils.tqdm")
except ImportError:
    _HF_TQDM_MODULE = None


class _JobDownloadTqdm(_TqdmAuto):
    """
    `tqdm` subclass swapped into `huggingface_hub.utils.tqdm.tqdm` while a
    model download is active. Every per-file progress bar the HF downloader
    creates (HTTP `iter_content` chunks and hf-xet `progress_updater` deltas
    alike, including inside `from_pretrained`) then reports real byte
    progress into `JOB_PROGRESS`, instead of relying on coarse
    `.incomplete` flushes on disk.
    """

    # False for `snapshot_download`'s outer `thread_map` bar: its `total` is a
    # file count and `update(1)` fires per completed file, not bytes.
    _track_bytes = True

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        """Seeds `JOB_PROGRESS` byte counters from the bar's declared totals."""
        # Capture before super(): tqdm short-circuits `__init__` when
        # `disable=True` and never sets `self.total`/`self.initial`.
        initial = kwargs.get("initial", 0) or 0
        total = kwargs.get("total") or 0
        kwargs["disable"] = True
        super().__init__(*args, **kwargs)
        if not self._track_bytes:
            return
        with JOB_PROGRESS_LOCK:
            if total > 0:
                JOB_PROGRESS["total_bytes"] += int(total)
            if initial > 0:
                JOB_PROGRESS["downloaded_bytes"] += int(initial)

    def update(self, n: Any = 1) -> Any:
        """Mirrors each byte increment into `JOB_PROGRESS["downloaded_bytes"]`."""
        # Cooperative cancel: hf_hub's download loop calls update() per chunk,
        # which is the only place an in-flight download can be aborted.
        with JOB_PROGRESS_LOCK:
            dl_epoch = JOB_PROGRESS["_dl_epoch"]
        if dl_epoch is not None and dl_epoch < MANAGER.cancel_epoch:
            raise InterruptedError("Model download was cancelled by the user.")
        if not self._track_bytes:
            return super().update(n)
        try:
            amount = int(n)
        except (TypeError, ValueError):
            amount = 0
        if amount > 0:
            with JOB_PROGRESS_LOCK:
                new_total = JOB_PROGRESS["downloaded_bytes"] + amount
                if JOB_PROGRESS["total_bytes"] > 0:
                    new_total = min(new_total, JOB_PROGRESS["total_bytes"])
                JOB_PROGRESS["downloaded_bytes"] = new_total
        return super().update(n)


class _JobOuterBarTqdm(_JobDownloadTqdm):
    """Suppresses byte accounting for `snapshot_download`'s outer file-count bar."""

    _track_bytes = False


@contextmanager
def track_model_download(model_key: str | None = None) -> Iterator[type]:
    """
    Sets the `download` job phase and yields a tqdm class (for callers that
    pass `tqdm_class`, e.g. `snapshot_download`'s outer bar). Per-file
    progress is captured by temporarily swapping the class inside
    `huggingface_hub.utils.tqdm`, since `tqdm_class` alone only reaches the outer
    "Fetching N files" bar, not individual downloads.

    The cancel epoch is snapshotted on entry; if `request_cancel()` fires
    while the download is active, the patched tqdm bars raise
    `InterruptedError` mid-transfer.
    """
    global _DOWNLOAD_IN_FLIGHT
    # Serialize: a second tracked download waits for the current one so the
    # shared tqdm patch and JOB_PROGRESS bytes never interleave.
    _MODEL_DOWNLOAD_LOCK.acquire()
    _DOWNLOAD_IN_FLIGHT = True
    try:
        with JOB_PROGRESS_LOCK:
            JOB_PROGRESS["_dl_key"] = model_key
            JOB_PROGRESS["_dl_epoch"] = MANAGER.cancel_epoch
        set_job_phase("download", model_key)
        with JOB_PROGRESS_LOCK:
            JOB_PROGRESS["downloaded_bytes"] = 0
            JOB_PROGRESS["total_bytes"] = 0
        # Swap the tqdm class used by `huggingface_hub`'s internal progress-bar
        # factory so per-file download bars (and their chunk deltas) report into
        # `JOB_PROGRESS`. Restored on exit regardless of outcome. When the
        # private module is gone, degrade to phase-only progress and say so:
        # a stale-looking bar is worse than an honest coarse one.
        original_tqdm = getattr(_HF_TQDM_MODULE, "tqdm", None)
        if original_tqdm is None:
            logger.warning(
                "[Model] huggingface_hub tqdm internals unavailable; download "
                "progress will show phases only, no byte counts."
            )
        else:
            _HF_TQDM_MODULE.tqdm = _JobDownloadTqdm
        try:
            yield _JobOuterBarTqdm
        finally:
            if original_tqdm is not None:
                _HF_TQDM_MODULE.tqdm = original_tqdm
            with JOB_PROGRESS_LOCK:
                JOB_PROGRESS["_dl_key"] = None
                JOB_PROGRESS["_dl_epoch"] = None
    finally:
        _DOWNLOAD_IN_FLIGHT = False
        clear_model_disk_bytes_cache()
        _MODEL_DOWNLOAD_LOCK.release()


_EXPECTED_BYTES_LOCK = threading.Lock()
_EXPECTED_BYTES_LIVE: dict[str, int] = {}
_EXPECTED_BYTES_LAST_ATTEMPT: float = 0.0
_EXPECTED_BYTES_RETRY_S = 60.0


def expected_model_bytes(repo_id: str, fallback: int = 0) -> int:
    """Returns the live remote download size for `repo_id`, or `fallback` if unknown."""
    with _EXPECTED_BYTES_LOCK:
        return _EXPECTED_BYTES_LIVE.get(repo_id, fallback)


def refresh_expected_sizes() -> None:
    """
    Fetches the real remote download size of every model repo in the
    background so `/api/status` can report accurate figures instead of
    relying solely on the bundled `expected_bytes` constants.
    """
    global _EXPECTED_BYTES_LAST_ATTEMPT
    if offline_mode_enabled():
        return
    with _EXPECTED_BYTES_LOCK:
        _EXPECTED_BYTES_LAST_ATTEMPT = time.monotonic()
    api = HfApi()
    for repo_id in MODELS.values():
        try:
            info = api.model_info(repo_id, files_metadata=True)
            total = int(sum(f.size or 0 for f in (info.siblings or [])))
        except Exception:
            continue
        if total > 0:
            with _EXPECTED_BYTES_LOCK:
                _EXPECTED_BYTES_LIVE[repo_id] = total


def maybe_refresh_expected_sizes() -> None:
    """
    Triggers a background `refresh_expected_sizes` if live sizes are still
    empty and at least `_EXPECTED_BYTES_RETRY_S` has elapsed since the last
    attempt (e.g. when the machine started offline and came online later).
    """
    global _EXPECTED_BYTES_LAST_ATTEMPT
    if offline_mode_enabled():
        return
    now = time.monotonic()
    with _EXPECTED_BYTES_LOCK:
        if _EXPECTED_BYTES_LIVE or (now - _EXPECTED_BYTES_LAST_ATTEMPT) < _EXPECTED_BYTES_RETRY_S:
            return
        _EXPECTED_BYTES_LAST_ATTEMPT = now
    threading.Thread(target=refresh_expected_sizes, daemon=True).start()


def compact_model_cache_fp16(repo_id: str) -> int:
    """
    Compacts any FP32 `model.safetensors` checkpoint in the local HF cache (such as
    `BiRefNet-matting` at 844 MB) down to FP16 (~424 MB) in-place on disk.
    Returns the number of bytes saved, or 0 if already FP16.
    """
    try:
        from safetensors import safe_open
        from safetensors.torch import save_file

        cached_path = try_to_load_from_cache(repo_id, "model.safetensors")
        if not isinstance(cached_path, str) or not os.path.exists(cached_path):
            return 0
        blob_path = Path(os.path.realpath(cached_path))
        if not blob_path.is_file():
            return 0

        with safe_open(str(blob_path), framework="pt", device="cpu") as f:
            metadata = f.metadata() or {}
            # get_slice reads only the JSON header metadata, so checking every
            # key is sub-millisecond and catches mixed-dtype checkpoints past key 8.
            needs_fp16 = any(f.get_slice(k).get_dtype() == "F32" for k in f.keys())
        if not needs_fp16:
            return 0

        old_size = blob_path.stat().st_size
        # Convert per-tensor through safe_open so peak RAM stays near the FP16
        # output size (~424 MB) instead of holding the full FP32 checkpoint
        # plus its FP16 copy (~1.3 GB) at once.
        fp16_tensors: dict[str, torch.Tensor] = {}
        with safe_open(str(blob_path), framework="pt", device="cpu") as f:
            for k in f.keys():
                t = f.get_tensor(k)
                if t.is_floating_point() and t.dtype == torch.float32:
                    t = t.half()
                fp16_tensors[k] = t
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
        clear_model_disk_bytes_cache()
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
        cached_path = try_to_load_from_cache(repo_id, "model.safetensors")
        return isinstance(cached_path, str) and os.path.exists(cached_path)
    except Exception:
        return False


def import_model_from_dir(repo_id: str, source_dir: Path | str) -> int:
    """
    Copies a user-supplied checkpoint folder into the HF Hub cache as a
    synthetic `manual` snapshot and points `refs/main` at it, so
    `local_files_only` lookups resolve the files exactly like a
    `snapshot_download` result. Lets users provision weights while the app
    never touches the network. Returns the number of bytes copied.
    """
    src = Path(source_dir).expanduser()
    if not src.is_dir():
        raise FileNotFoundError(f"Model folder does not exist: {src}")
    files = [
        p
        for p in src.rglob("*")
        if p.is_file() and not p.name.startswith(".") and ".git" not in p.relative_to(src).parts
    ]
    seen_names: dict[str, Path] = {}
    for file_path in files:
        if file_path.name in seen_names:
            raise ValueError(
                f"Model folder {src} contains duplicate file name '{file_path.name}' "
                f"({seen_names[file_path.name]} and {file_path})."
            )
        seen_names[file_path.name] = file_path
    names = set(seen_names.keys())
    missing = {"model.safetensors", "config.json"} - names
    if missing:
        raise ValueError(
            f"{src} does not look like a {repo_id} checkpoint "
            f"(missing {', '.join(sorted(missing))})."
        )
    repo_cache = get_model_cache_dir(repo_id)
    snapshot_dir = repo_cache / "snapshots" / "manual"
    if snapshot_dir.exists():
        shutil.rmtree(snapshot_dir, ignore_errors=True)
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    copied_bytes = 0
    for file_path in files:
        # HF model repos are flat; nested sources (e.g. an unzipped repo
        # folder) are flattened to basenames inside the snapshot.
        dest = snapshot_dir / file_path.name
        shutil.copy2(file_path, dest)
        copied_bytes += dest.stat().st_size
    refs_dir = repo_cache / "refs"
    refs_dir.mkdir(exist_ok=True)
    (refs_dir / "main").write_text("manual", encoding="utf-8")
    logger.info(
        "[Model] Imported %s from %s (%.1f MB).",
        repo_id,
        src,
        copied_bytes / 1024**2,
    )
    clear_model_disk_bytes_cache()
    return copied_bytes


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

    def unload(self, *, wait: bool = True) -> bool:
        """
        Explicitly unloads the active model and flushes device memory.
        With `wait=False`, returns False immediately when a load (which holds
        the model lock for the whole download) or another unload is in
        progress, instead of blocking behind it.
        """
        if not self._lock.acquire(blocking=wait):
            return False
        try:
            if self.model is not None:
                del self.model
                self.model = None
                self.active_model_key = None
            self.flush_device_memory()
        finally:
            self._lock.release()
        return True

    def get_or_load(self, model_key: str) -> torch.nn.Module:
        """
        Returns the requested model instance, loading it into device memory if
        it is not currently active.

        Attempts an offline cache load (`local_files_only=True`) first so that
        zero external network calls are made once weights are cached locally.

        Concurrency & cancellation contract:
        - Holds `self._lock` for the full eviction + download + device-transfer
          sequence so two threads never race to allocate weights or interleave
          downloads. Callers that cannot wait behind a first-run download must
          use `unload(wait=False)` or call `request_cancel()` first.
        - Snapshots `cancel_epoch` on entry: if `request_cancel()` fires during
          a download or checkpoint load, `_JobDownloadTqdm.update` or the post-
          load checkpoint raises `InterruptedError` before moving weights to
          `DEVICE`, leaving `self.model` clean (`None`).
        """
        if model_key not in MODELS:
            raise ValueError(f"Unsupported model key: {model_key}")

        load_epoch = self.cancel_epoch
        with self._lock:
            self.check_cancelled(load_epoch)
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
            # Only own the phase when no foreign inference is in flight: a
            # concurrent warmup load must not clobber an active job's
            # "inference" phase or reset it on exit.
            with JOB_PROGRESS_LOCK:
                owns_phase = JOB_PROGRESS["phase"] != "inference"
            loaded_model: Any = None
            try:
                if owns_phase:
                    set_job_phase("load", model_key)
                try:
                    loaded_model = AutoModelForImageSegmentation.from_pretrained(
                        repo_id,
                        trust_remote_code=True,
                        local_files_only=True,
                    )
                    logger.info("[Model] Loaded %s from local offline cache.", repo_id)
                except Exception as cache_exc:
                    if offline_mode_enabled():
                        raise FileNotFoundError(
                            f"{repo_id} could not be loaded from the local "
                            "cache and internet access "
                            "is blocked (offline mode). Import the checkpoint "
                            "folder under Settings > Models, or disable offline "
                            "mode and retry."
                        ) from cache_exc
                    logger.info(
                        "[Model] %s not found in local cache. "
                        "Downloading weights from Hugging Face Hub (one-time)...",
                        repo_id,
                    )
                    with track_model_download(model_key) as dl_tqdm:
                        try:
                            snapshot_download(repo_id=repo_id, tqdm_class=dl_tqdm)
                        except InterruptedError:
                            # User cancellation must not silently retry via the
                            # transformers downloader.
                            raise
                        except Exception:
                            self.check_cancelled(load_epoch)
                            # Fall back to transformers' own downloader (no byte
                            # progress) so unusual repo layouts still work.
                            logger.warning(
                                "[Model] Snapshot download failed for %s; "
                                "falling back to the transformers downloader.",
                                repo_id,
                            )
                            loaded_model = AutoModelForImageSegmentation.from_pretrained(
                                repo_id,
                                trust_remote_code=True,
                                local_files_only=False,
                            )
                        else:
                            self.check_cancelled(load_epoch)
                            loaded_model = AutoModelForImageSegmentation.from_pretrained(
                                repo_id,
                                trust_remote_code=True,
                                local_files_only=True,
                            )
                    logger.info("[Model] Download complete for %s.", repo_id)
                    if owns_phase:
                        set_job_phase("load", model_key)
                    compact_model_cache_fp16(repo_id)

                self.check_cancelled(load_epoch)
                loaded_model.to(device=DEVICE, dtype=DTYPE)
                loaded_model.eval()

                self.model = loaded_model
                self.active_model_key = model_key
            except BaseException:
                if loaded_model is not None and self.model is not loaded_model:
                    del loaded_model
                    self.flush_device_memory()
                raise
            finally:
                # This function owns the `download`/`load` phases it set;
                # callers like the startup preload or Quick Action have no
                # reset of their own, so clear here or /api/progress would
                # report "loading" forever and uninstall would stay 409.
                if owns_phase:
                    set_job_phase("idle")
            return self.model


MANAGER = ModelManager()
