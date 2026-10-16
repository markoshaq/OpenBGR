"""
OpenBGR runtime configuration, hardware auto-detection, model tier registry,
and shared filesystem paths.
"""

from __future__ import annotations

import logging
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
import warnings
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

# Must be set before importing PyTorch so any non-native Apple Silicon MPS operator
# transparently falls back to CPU execution without raising a runtime error.
os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
warnings.filterwarnings("ignore", category=FutureWarning)

import torch

# ---------------------------------------------------------------------------
# Path & Runtime Configuration
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
STATIC_DIR.mkdir(exist_ok=True)


def _read_project_version() -> str:
    """Reads `version` from `pyproject.toml` so the version is defined in one place."""
    try:
        text = (BASE_DIR / "pyproject.toml").read_text(encoding="utf-8")
        m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
        if m:
            return m.group(1)
    except OSError:
        pass
    return "0.10.1"


APP_VERSION = _read_project_version()

# Per-user desktop preferences dir; survives app updates and keeps the repo clean.
APP_CONFIG_DIR = Path.home() / ".openbgr"
WINDOW_STATE_PATH = APP_CONFIG_DIR / "window.json"
APP_ICON_PATH = APP_CONFIG_DIR / "icon.png"
QUICK_ACTION_CONFIG_PATH = APP_CONFIG_DIR / "quick_action.json"
NOTIFIER_APP_PATH = APP_CONFIG_DIR / "OpenBGRNotifier.app"
NOTIFIER_ICNS_PATH = APP_CONFIG_DIR / "OpenBGR.icns"
LOG_FILE_PATH = APP_CONFIG_DIR / "openbgr.log"


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
    stream = logging.StreamHandler(sys.stderr)
    stream.setFormatter(logging.Formatter("%(message)s"))
    log.addHandler(stream)
    try:
        APP_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        fh = RotatingFileHandler(
            LOG_FILE_PATH, maxBytes=2 * 1024 * 1024, backupCount=1, encoding="utf-8"
        )
        fh.setFormatter(
            logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", "%Y-%m-%d %H:%M:%S")
        )
        log.addHandler(fh)
    except OSError:
        pass
    return log


logger = _configure_logger()

DEFAULT_QUICK_ACTION_CONFIG: dict[str, Any] = {
    "tier": "auto",
    "save_mode": "same_folder",
    "format": "png",
    "edge_refine": True,
    "copy_clipboard": False,
    "notify": True,
}

# Scale intra-op CPU parallelism for machines running without a GPU accelerator.
_cpu_count = os.cpu_count()
if _cpu_count:
    torch.set_num_threads(min(8, _cpu_count))

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
        page_size = os.sysconf("SC_PAGE_SIZE")
        page_count = os.sysconf("SC_PHYS_PAGES")
        if page_size > 0 and page_count > 0:
            return (page_size * page_count) / (1024**3)
    except Exception:
        pass
    return 16.0


def get_system_memory_gb() -> float:
    """Estimates total GPU or system memory in GiB to prevent swap thrashing on 2K tensors."""
    if torch.cuda.is_available():
        try:
            return torch.cuda.get_device_properties(0).total_memory / (1024**3)
        except Exception:
            pass
    return get_host_ram_gb()


HOST_RAM_GB: float = get_host_ram_gb()
SYSTEM_MEMORY_GB: float = get_system_memory_gb()
# Evaluating BiRefNet_HR at 2048x2048 allocates >6 GB of intermediate attention feature
# pyramids; on 8 GB systems, 1536x1536 (2.25x pixel density of 1024x1024) prevents swap thrashing.
HR_RESOLUTION: int = 2048 if SYSTEM_MEMORY_GB >= 14.0 else 1536

# Supported Hugging Face model repositories — each key maps to a distinct official
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

TIER_ALIASES: dict[str, str] = {
    "low": "lite",
    "mid": "general",
    "full": "general",
    "high": "hr",
}


def normalize_tier_key(tier: str) -> str:
    """Resolves legacy preset names (`low`, `mid`, `high`) to canonical model keys."""
    cleaned = (tier or "").strip().lower()
    return TIER_ALIASES.get(cleaned, cleaned)


# Selectable BiRefNet models exposed in the UI and `/api/status`.
TIERS: dict[str, dict[str, Any]] = {
    "lite": {
        "key": "lite",
        "label": "Lite",
        "tech_name": "BiRefNet_lite",
        "sublabel": "1K · Fast",
        "model_key": "lite",
        "repo_id": MODELS["lite"],
        "expected_bytes": 177_669_592,
        "resolution": 1024,
        "dynamic": False,
        "description": (
            "BiRefNet_lite (Swin-T @ 1024px). Fast general cutouts for quick batches, "
            "CPUs, and integrated graphics."
        ),
    },
    "general": {
        "key": "general",
        "label": "General",
        "tech_name": "BiRefNet",
        "sublabel": "1K · Studio",
        "model_key": "general",
        "repo_id": MODELS["general"],
        "expected_bytes": 444_566_476,
        "resolution": 1024,
        "dynamic": False,
        "description": (
            "BiRefNet (Swin-L @ 1024px). All-round flagship for products, objects, "
            "animals, and everyday photography."
        ),
    },
    "hr": {
        "key": "hr",
        "label": "Ultra HR",
        "tech_name": "BiRefNet_HR",
        "sublabel": f"2K · {HR_RESOLUTION}px",
        "model_key": "hr",
        "repo_id": MODELS["hr"],
        "expected_bytes": 444_566_476,
        "resolution": HR_RESOLUTION,
        "dynamic": False,
        "description": (
            f"BiRefNet_HR (Swin-L @ {HR_RESOLUTION}px). Native 2K inference for 4K/8K "
            "photography and intricate micro-edge detail."
        ),
    },
    "portrait": {
        "key": "portrait",
        "label": "Portrait",
        "tech_name": "BiRefNet-portrait",
        "sublabel": "1K · People",
        "model_key": "portrait",
        "repo_id": MODELS["portrait"],
        "expected_bytes": 444_566_476,
        "resolution": 1024,
        "dynamic": False,
        "description": (
            "BiRefNet-portrait (Swin-L @ 1024px). Fine-tuned for human subjects, "
            "headshots, flyaway hair strands, eyelashes, and clothing."
        ),
    },
    "matting": {
        "key": "matting",
        "label": "Matting",
        "tech_name": "BiRefNet_HR-matting",
        "sublabel": "2K · Alpha",
        "model_key": "matting",
        "repo_id": MODELS["matting"],
        "expected_bytes": 444_566_476,
        "resolution": HR_RESOLUTION,
        "dynamic": False,
        "description": (
            f"BiRefNet_HR-matting (Swin-L @ {HR_RESOLUTION}px). High-resolution soft alpha "
            "matting for glass, smoke, veils, sheer fabric, and fine hair."
        ),
    },
    "dynamic": {
        "key": "dynamic",
        "label": "Dynamic",
        "tech_name": "BiRefNet_dynamic",
        "sublabel": "Native Ratio",
        "model_key": "dynamic",
        "repo_id": MODELS["dynamic"],
        "expected_bytes": 444_566_476,
        "resolution": HR_RESOLUTION,
        "dynamic": True,
        "description": (
            "BiRefNet_dynamic (Swin-L). Preserves native aspect ratio up to 2K without "
            "square distortion — ideal for panoramas and vertical banners."
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
    Heuristically chooses the default model at startup:
    - CPU hosts default to 'lite' (1024x1024 BiRefNet_lite) for responsive latency.
    - Dedicated CUDA GPUs with >= 16 GB VRAM default to 'hr' (2048x2048 BiRefNet_HR).
    - All other GPU/MPS accelerators default to 'general' (1024x1024 BiRefNet Swin-L).
    """
    if device.type == "cpu":
        return "lite"
    if device.type == "cuda":
        try:
            vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024**3)
            if vram_gb >= 16.0:
                return "hr"
        except Exception:
            pass
    return "general"


DEVICE: torch.device = detect_compute_device()
DEVICE_LABEL: str = format_device_label(DEVICE)

# Use FP16 half-precision on GPU accelerators (CUDA / MPS) to halve memory usage
# and maximize tensor throughput; retain FP32 on CPU for numerical compatibility.
DTYPE: torch.dtype = torch.float16 if DEVICE.type in ("mps", "cuda") else torch.float32
PRECISION_LABEL: str = "FP16" if DTYPE == torch.float16 else "FP32"
RECOMMENDED_TIER: str = select_recommended_tier(DEVICE)


# ---------------------------------------------------------------------------
# Disk Telemetry & File Manager Helpers
# ---------------------------------------------------------------------------

_APP_DISK_CACHE: tuple[float, int] = (0.0, 0)
_APP_DISK_LOCK = threading.Lock()


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


def get_app_disk_bytes() -> int:
    """
    Returns total disk usage of the OpenBGR application and its Python runtime
    environment (`BASE_DIR` including `.venv`, plus `~/.openbgr`). Cached for
    60 seconds so `/api/status` remains sub-millisecond.
    """
    global _APP_DISK_CACHE
    now = time.monotonic()
    with _APP_DISK_LOCK:
        cached_at, cached_val = _APP_DISK_CACHE
        if cached_val > 0 and (now - cached_at) < 60.0:
            return cached_val

    total = _dir_tree_bytes(BASE_DIR, skip_top_dirs={".git", "dist"})
    cfg_dir = Path.home() / ".openbgr"
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


def ensure_app_icon() -> str | None:
    """
    Generates the macOS-squircle OpenBGR icon in `~/.openbgr/icon.png`
    so the native window, Dock, and task switcher display the OpenBGR mark.
    Regenerates when the on-disk file predates the squircle design.
    """
    try:
        icon_src = BASE_DIR / "icon_render.py"
        if (
            APP_ICON_PATH.exists()
            and icon_src.exists()
            and APP_ICON_PATH.stat().st_mtime < icon_src.stat().st_mtime
        ):
            APP_ICON_PATH.unlink()  # stale icon from an older design
        if not APP_ICON_PATH.exists():
            sys.path.insert(0, str(BASE_DIR))
            import icon_render

            APP_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            img = icon_render.render_icon(512)
            img.save(APP_ICON_PATH, format="PNG")
            img.close()
        return str(APP_ICON_PATH)
    except Exception as exc:
        logger.warning("[Config] Failed to generate app icon: %s", exc)
        return None
