"""
OpenBGR runtime configuration, hardware auto-detection, model tier registry,
and shared filesystem paths.
"""

from __future__ import annotations

import logging
import os
import platform
import shutil
import subprocess
import sys
import threading
import time
import warnings
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import TYPE_CHECKING, Any

# Deliberate re-exports (`as` form) so callers can pull shared settings
# symbols from `openbgr.config` without knowing they live in `settings`.
from .settings import (
    API_TOKEN as API_TOKEN,
    API_TOKEN_HEADER as API_TOKEN_HEADER,
    API_TOKEN_PATH as API_TOKEN_PATH,
    APP_CONFIG_DIR as APP_CONFIG_DIR,
    APP_VERSION as APP_VERSION,
    BASE_DIR as BASE_DIR,
    TIER_ALIASES as TIER_ALIASES,
    TIER_KEYS as TIER_KEYS,
    WEB_API_TOKEN as WEB_API_TOKEN,
    normalize_tier_key as normalize_tier_key,
    persist_api_token as persist_api_token,
    read_api_token as read_api_token,
)

if TYPE_CHECKING:
    import torch

# Must be set before importing PyTorch so any non-native Apple Silicon MPS operator
# transparently falls back to CPU execution without raising a runtime error.
os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
warnings.filterwarnings(
    "ignore",
    category=FutureWarning,
    module=r"^(transformers|timm|kornia|torch)(\.|$)",
)

# ---------------------------------------------------------------------------
# Path & Runtime Configuration
# ---------------------------------------------------------------------------

STATIC_DIR = BASE_DIR / "static"

# Per-user desktop preferences dir; survives app updates and keeps the repo clean.
WINDOW_STATE_PATH = APP_CONFIG_DIR / "window.json"
APP_ICON_PATH = APP_CONFIG_DIR / "icon.png"
APP_ICON_ICO_PATH = APP_CONFIG_DIR / "icon.ico"
QUICK_ACTION_CONFIG_PATH = APP_CONFIG_DIR / "quick_action.json"
NOTIFIER_APP_PATH = APP_CONFIG_DIR / "OpenBGRNotifier.app"
NOTIFIER_ICNS_PATH = APP_CONFIG_DIR / "OpenBGR.icns"
LOG_FILE_PATH = APP_CONFIG_DIR / "openbgr.log"


def _stderr_is_log_file() -> bool:
    """Returns True when stderr has already been redirected to `LOG_FILE_PATH` (e.g. `.app` stub)."""
    try:
        if not LOG_FILE_PATH.exists():
            return False
        st_err = os.fstat(sys.stderr.fileno())
        st_log = LOG_FILE_PATH.stat()
        return st_err.st_ino == st_log.st_ino and st_err.st_dev == st_log.st_dev
    except Exception:
        return False


def _configure_logger() -> logging.Logger:
    """
    Configures a shared logger that echoes `info`/`warning` lines to stderr (so
    CLI output stays identical) and also appends to `~/.openbgr/openbgr.log`
    (rotating at 2 MB) so headless Quick Action and desktop failures are never
    lost when no terminal is attached.
    """
    log = logging.getLogger("openbgr")
    if log.handlers:
        return log
    log.setLevel(logging.INFO)
    log.propagate = False

    # Warnings and errors from third-party loggers (uvicorn, torch, hf_hub)
    # are also captured so headless failures stay diagnosable. The openbgr
    # logger does not propagate, so its records are never written twice.
    root = logging.getLogger()
    root.setLevel(logging.WARNING)
    try:
        APP_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        fh = RotatingFileHandler(
            LOG_FILE_PATH, maxBytes=2 * 1024 * 1024, backupCount=1, encoding="utf-8"
        )
        fh.setFormatter(
            logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", "%Y-%m-%d %H:%M:%S")
        )
        log.addHandler(fh)
        root.addHandler(fh)
    except OSError:
        pass
    if not _stderr_is_log_file():
        stream = logging.StreamHandler(sys.stderr)
        stream.setFormatter(logging.Formatter("%(message)s"))
        log.addHandler(stream)
        root.addHandler(stream)
    return log


logger = _configure_logger()

DEFAULT_QUICK_ACTION_CONFIG: dict[str, Any] = {
    "tier": "general",
    "save_mode": "same_folder",
    "format": "png",
    "edge_refine": True,
    "copy_clipboard": False,
    "notify": True,
}

# ImageNet normalization constants required by BiRefNet Swin-T / Swin-L backbones.
IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]


def get_host_ram_gb() -> float:
    """Detects total physical system RAM in GiB across macOS, Linux, and Windows."""
    sys_name = platform.system()
    if sys_name == "Darwin":
        try:
            mem_bytes = int(
                subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True).strip()
            )
            return mem_bytes / (1024**3)
        except Exception:
            pass
    elif sys_name == "Windows":
        try:
            import ctypes

            class _MEMORYSTATUSEX(ctypes.Structure):
                """Win32 MEMORYSTATUSEX layout for `GlobalMemoryStatusEx` (total RAM field)."""

                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = _MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(_MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):  # type: ignore[attr-defined]
                return stat.ullTotalPhys / (1024**3)
        except Exception:
            pass
    try:
        page_size = os.sysconf("SC_PAGE_SIZE")  # type: ignore[attr-defined]
        page_count = os.sysconf("SC_PHYS_PAGES")  # type: ignore[attr-defined]
        if page_size > 0 and page_count > 0:
            return (page_size * page_count) / (1024**3)
    except Exception:
        pass
    return 16.0


HOST_RAM_GB: float = get_host_ram_gb()


def get_system_memory_gb() -> float:
    """Estimates total GPU or system memory in GiB to prevent swap thrashing on 2K tensors."""
    import torch

    if torch.cuda.is_available():
        try:
            return torch.cuda.get_device_properties(0).total_memory / (1024**3)
        except Exception:
            pass
    return get_host_ram_gb()


# ---------------------------------------------------------------------------
# Model Registry
# ---------------------------------------------------------------------------

# Supported Hugging Face model repositories. Each key maps to a distinct official
# BiRefNet checkpoint from ZhengPeng7.
MODELS: dict[str, str] = {
    "lite": "ZhengPeng7/BiRefNet_lite",  # Swin-T @ 1024x1024 (~170 MB -> ~85 MB FP16)
    "general": "ZhengPeng7/BiRefNet",  # Swin-L @ 1024x1024 (~424 MB FP16)
    "hr": "ZhengPeng7/BiRefNet_HR",  # Swin-L @ 2048x2048 (~424 MB FP16)
    "portrait": "ZhengPeng7/BiRefNet-portrait",  # Swin-L @ 1024x1024 (~844 MB -> ~424 MB FP16)
    "matting": "ZhengPeng7/BiRefNet_HR-matting",  # Swin-L @ 2048x2048 (~424 MB FP16)
    "dynamic": "ZhengPeng7/BiRefNet_dynamic",  # Swin-L @ dynamic native aspect ratio (~424 MB FP16)
}

LEGACY_MATTING_REPO = "ZhengPeng7/BiRefNet-matting"


def _build_tiers(hr_resolution: int) -> dict[str, dict[str, Any]]:
    """
    Builds the selectable BiRefNet model registry exposed in the UI and
    `/api/status`. The 2K tiers take `hr_resolution` so the table can be built
    before torch is importable and corrected once real device memory is known.
    """
    return {
        "lite": {
            "label": "Lite",
            "tech_name": "BiRefNet_lite",
            "sublabel": "1K Fast",
            "model_key": "lite",
            "repo_id": MODELS["lite"],
            "expected_bytes": 177742341,
            "resolution": 1024,
            "dynamic": False,
            "description": (
                "BiRefNet_lite (Swin-T @ 1024px). Fast general cutouts for quick batches, "
                "CPUs, and integrated graphics."
            ),
        },
        "general": {
            "label": "General",
            "tech_name": "BiRefNet",
            "sublabel": "1K Studio",
            "model_key": "general",
            "repo_id": MODELS["general"],
            "expected_bytes": 444584498,
            "resolution": 1024,
            "dynamic": False,
            "description": (
                "BiRefNet (Swin-L @ 1024px). All-round flagship for products, objects, "
                "animals, and everyday photography."
            ),
        },
        "hr": {
            "label": "Ultra HR",
            "tech_name": "BiRefNet_HR",
            "sublabel": f"2K {hr_resolution}px",
            "model_key": "hr",
            "repo_id": MODELS["hr"],
            "expected_bytes": 444583809,
            "resolution": hr_resolution,
            "dynamic": False,
            "description": (
                f"BiRefNet_HR (Swin-L @ {hr_resolution}px). Native 2K inference for 4K/8K "
                "photography and intricate micro-edge detail."
            ),
        },
        "portrait": {
            "label": "Portrait",
            "tech_name": "BiRefNet-portrait",
            "sublabel": "1K People",
            "model_key": "portrait",
            "repo_id": MODELS["portrait"],
            "expected_bytes": 884984566,
            "resolution": 1024,
            "dynamic": False,
            "description": (
                "BiRefNet-portrait (Swin-L @ 1024px). Fine-tuned for human subjects, "
                "headshots, flyaway hair strands, eyelashes, and clothing."
            ),
        },
        "matting": {
            "label": "Matting",
            "tech_name": "BiRefNet_HR-matting",
            "sublabel": "2K Alpha",
            "model_key": "matting",
            "repo_id": MODELS["matting"],
            "expected_bytes": 444584399,
            "resolution": hr_resolution,
            "dynamic": False,
            "description": (
                f"BiRefNet_HR-matting (Swin-L @ {hr_resolution}px). High-resolution soft alpha "
                "matting for glass, smoke, veils, sheer fabric, and fine hair."
            ),
        },
        "dynamic": {
            "label": "Dynamic",
            "tech_name": "BiRefNet_dynamic",
            "sublabel": "Native Ratio",
            "model_key": "dynamic",
            "repo_id": MODELS["dynamic"],
            "expected_bytes": 444584549,
            "resolution": hr_resolution,
            "dynamic": True,
            "description": (
                "BiRefNet_dynamic (Swin-L). Preserves native aspect ratio up to 2K without "
                "square distortion, ideal for panoramas and vertical banners."
            ),
        },
    }


# Evaluating BiRefNet_HR at 2048x2048 allocates >6 GB of intermediate attention feature
# pyramids; on 8 GB systems, 1536x1536 (2.25x pixel density of 1024x1024) prevents swap
# thrashing. Built eagerly from host RAM (torch-free); `ensure_runtime` corrects the
# 2K tiers once the CUDA-aware device-memory value is known.
_HOST_HR_RESOLUTION: int = 2048 if HOST_RAM_GB >= 14.0 else 1536

TIERS: dict[str, dict[str, Any]] = _build_tiers(_HOST_HR_RESOLUTION)


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
    import torch

    if torch.cuda.is_available():
        return torch.device("cuda")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def format_device_label(device: torch.device) -> str:
    """Returns an ASCII-safe hardware identifier for UI telemetry and HTTP headers."""
    import torch

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


def select_recommended_tier(device: torch.device, system_memory_gb: float) -> str:
    """
    Heuristically chooses the default model at startup:
    - CPU hosts and machines with < 10 GB of unified/system RAM default to
      'lite' (1024x1024 BiRefNet_lite) to avoid unified-memory pressure.
    - Dedicated CUDA GPUs with >= 16 GB VRAM default to 'hr' (2048x2048 BiRefNet_HR).
    - All other GPU/MPS accelerators default to 'general' (1024x1024 BiRefNet Swin-L).
    """
    if device.type == "cpu" or system_memory_gb < 10.0:
        return "lite"
    if device.type == "cuda":
        try:
            import torch

            vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024**3)
            if vram_gb >= 16.0:
                return "hr"
        except Exception:
            pass
    return "general"


# ---------------------------------------------------------------------------
# Deferred Hardware Runtime
# ---------------------------------------------------------------------------
# `torch` and every value derived from it (device, precision, recommended tier,
# the 2K tier resolutions) load lazily via `ensure_runtime`, so importing
# `openbgr.config` stays cheap for the server bind path: the desktop window
# opens while a background thread materializes the runtime. First access to
# any attribute below (including `from .config import DEVICE`) triggers the
# same one-time initialization.

_RUNTIME_ATTRS = frozenset(
    {
        "DEVICE",
        "DEVICE_LABEL",
        "DTYPE",
        "PRECISION_LABEL",
        "RECOMMENDED_TIER",
        "SYSTEM_MEMORY_GB",
        "HR_RESOLUTION",
    }
)
_runtime_lock = threading.Lock()
_runtime_ready = False


def ensure_runtime() -> None:
    """
    Imports torch once, sizes intra-op CPU parallelism, detects the compute
    device, and materializes `DEVICE`, `DEVICE_LABEL`, `DTYPE`,
    `PRECISION_LABEL`, `RECOMMENDED_TIER`, `SYSTEM_MEMORY_GB`, and
    `HR_RESOLUTION` as module globals. Idempotent and thread-safe.
    """
    global _runtime_ready
    with _runtime_lock:
        if _runtime_ready:
            return
        import torch

        _cpu_count = os.cpu_count()
        if _cpu_count:
            torch.set_num_threads(min(8, _cpu_count))

        device = detect_compute_device()
        system_memory_gb = get_system_memory_gb()
        hr_resolution = 2048 if system_memory_gb >= 14.0 else 1536
        dtype = torch.float16 if device.type in ("mps", "cuda") else torch.float32
        globals().update(
            DEVICE=device,
            DEVICE_LABEL=format_device_label(device),
            DTYPE=dtype,
            PRECISION_LABEL="FP16" if dtype == torch.float16 else "FP32",
            RECOMMENDED_TIER=select_recommended_tier(device, system_memory_gb),
            SYSTEM_MEMORY_GB=system_memory_gb,
            HR_RESOLUTION=hr_resolution,
        )
        if hr_resolution != _HOST_HR_RESOLUTION:
            # The eager TIERS table guessed from host RAM alone; a small-VRAM
            # CUDA host needs the lower 2K resolution. update() keeps the dict
            # object identity, so every `from .config import TIERS` consumer
            # (and any sub-dict read at call time) sees the corrected values.
            TIERS.update(_build_tiers(hr_resolution))
        _runtime_ready = True


def __getattr__(name: str) -> Any:
    """Materializes the torch-derived runtime values on first access."""
    if name in _RUNTIME_ATTRS:
        ensure_runtime()
        return globals()[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# ---------------------------------------------------------------------------
# Disk Telemetry & File Manager Helpers
# ---------------------------------------------------------------------------

_APP_DISK_CACHE: tuple[float, int] = (0.0, 0)
_APP_DISK_LOCK = threading.Lock()
# Heavyweight runtime trees (`.venv`, `node_modules`) hold tens of thousands of
# files; they are sized once on a background thread and merged into the total.
_APP_VENV_BYTES: int | None = None
_APP_VENV_STARTED = False


def _dir_tree_bytes(root: Path, skip_top_dirs: set[str] | None = None) -> int:
    """Recursively sums regular file sizes under `root` using fast `os.scandir`."""
    total = 0
    stack: list[tuple[Path, bool]] = [(root, True)]
    while stack:
        current, is_top = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        if entry.is_symlink():
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            if is_top and skip_top_dirs and entry.name in skip_top_dirs:
                                continue
                            stack.append((Path(entry.path), False))
                        elif entry.is_file(follow_symlinks=False):
                            total += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total


def _refresh_app_venv_bytes() -> None:
    """Sizes `.venv` and `node_modules` off the request path for `get_app_disk_bytes`."""
    global _APP_VENV_BYTES, _APP_DISK_CACHE
    total = 0
    for name in (".venv", "node_modules"):
        sub = BASE_DIR / name
        if sub.is_dir():
            total += _dir_tree_bytes(sub)
    _APP_VENV_BYTES = total
    # The first `get_app_disk_bytes` call may have cached a total without these
    # trees; drop it so the next poll reports the complete size.
    with _APP_DISK_LOCK:
        _APP_DISK_CACHE = (0.0, 0)


def get_app_disk_bytes() -> int:
    """
    Returns total disk usage of the OpenBGR application and its Python runtime
    environment (`BASE_DIR` plus `~/.openbgr`). Cached for 60 seconds so
    `/api/status` remains sub-millisecond. `.venv` and `node_modules` are
    summed once on a background thread and merged in when ready.
    """
    global _APP_DISK_CACHE, _APP_VENV_STARTED
    now = time.monotonic()
    with _APP_DISK_LOCK:
        cached_at, cached_val = _APP_DISK_CACHE
        if cached_val > 0 and (now - cached_at) < 60.0:
            return cached_val

    total = _dir_tree_bytes(BASE_DIR, skip_top_dirs={".git", "dist", ".venv", "node_modules"})
    if _APP_VENV_BYTES is not None:
        total += _APP_VENV_BYTES
    else:
        with _APP_DISK_LOCK:
            if not _APP_VENV_STARTED:
                _APP_VENV_STARTED = True
                threading.Thread(target=_refresh_app_venv_bytes, daemon=True).start()
    cfg_dir = APP_CONFIG_DIR
    if cfg_dir.exists():
        total += _dir_tree_bytes(cfg_dir)

    with _APP_DISK_LOCK:
        _APP_DISK_CACHE = (now, total)
    return total


def open_folder_in_file_manager(folder: Path) -> bool:
    """Opens `folder` in the native OS file manager (Finder / Explorer / xdg-open)."""
    try:
        folder.mkdir(parents=True, exist_ok=True)
        resolved = str(folder.resolve())
        sys_name = platform.system()
        if sys_name == "Darwin":
            subprocess.Popen(["open", resolved])
            return True
        if sys_name == "Windows":
            if hasattr(os, "startfile"):
                os.startfile(resolved)  # type: ignore[attr-defined]
            else:
                subprocess.Popen(["explorer", resolved])
            return True
        for cmd in ("xdg-open", "gio"):
            if shutil.which(cmd):
                args = [cmd, "open", resolved] if cmd == "gio" else [cmd, resolved]
                subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return True
    except Exception as exc:
        logger.warning("[Config] Failed to open folder %s: %s", folder, exc)
        return False
    return False


def reveal_in_file_manager(path: Path) -> bool:
    """
    Opens the OS file manager with `path` selected where the platform supports
    it (Finder `open -R`, Explorer `/select,`); otherwise opens the parent
    folder (Linux has no reliable select-a-file API).
    """
    try:
        target = path.expanduser().resolve()
        if target.is_dir():
            return open_folder_in_file_manager(target)
        sys_name = platform.system()
        if sys_name == "Darwin" and target.is_file():
            subprocess.Popen(["open", "-R", str(target)])
            return True
        if sys_name == "Windows" and target.is_file():
            subprocess.Popen(["explorer", "/select,", str(target)])
            return True
        return open_folder_in_file_manager(target.parent)
    except Exception as exc:
        logger.warning("[Config] Failed to reveal %s: %s", path, exc)
        return False


def ensure_app_icon(fmt: str = "png") -> str | None:
    """
    Generates the OpenBGR icon under `~/.openbgr` so the native window, Dock,
    task switcher, notifications, and favicon display the OpenBGR mark.
    `fmt="ico"` writes a multi-size `icon.ico` instead: pywebview's WinForms
    backend loads the window icon via `System.Drawing.Icon`, which only
    accepts `.ico` files and crashes on PNG.
    Regenerates when the on-disk file predates the squircle design.
    """
    try:
        path = APP_ICON_ICO_PATH if fmt == "ico" else APP_ICON_PATH
        icon_src = Path(__file__).resolve().parent / "icon_render.py"
        if path.exists() and icon_src.exists() and path.stat().st_mtime < icon_src.stat().st_mtime:
            path.unlink()  # stale icon from an older design
        if not path.exists():
            from . import icon_render

            APP_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            img = icon_render.render_icon(256 if fmt == "ico" else 512)
            if fmt == "ico":
                img.save(
                    path,
                    format="ICO",
                    sizes=[
                        (16, 16),
                        (24, 24),
                        (32, 32),
                        (48, 48),
                        (64, 64),
                        (128, 128),
                        (256, 256),
                    ],
                )
            else:
                img.save(path, format="PNG")
            img.close()
        return str(path)
    except Exception as exc:
        logger.warning("[Config] Failed to generate app icon: %s", exc)
        return None
