"""
FastAPI application and HTTP endpoints for OpenBGR.
"""

from __future__ import annotations

import asyncio
import io
import platform
import shutil
import sys
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from huggingface_hub import snapshot_download
from huggingface_hub.constants import HF_HUB_CACHE
from PIL import Image

from . import desktop
from .config import (
    APP_CONFIG_DIR,
    APP_VERSION,
    DEVICE,
    DEVICE_LABEL,
    HOST_RAM_GB,
    LEGACY_MATTING_REPO,
    MODELS,
    PRECISION_LABEL,
    RECOMMENDED_TIER,
    STATIC_DIR,
    TIERS,
    ensure_app_icon,
    get_app_disk_bytes,
    normalize_tier_key,
    open_folder_in_file_manager,
)
from .models import (
    MANAGER,
    compact_model_cache_fp16,
    get_model_cache_dir,
    get_model_disk_bytes,
    is_model_cached_locally,
)
from .pipeline import (
    _LAST_JOB,
    _LAST_JOB_LOCK,
    compose_rgba,
    segment_foreground,
)
from .quick_action import (
    is_quick_action_installed,
    load_quick_action_config,
    run_quick_action,
    save_quick_action_config,
    set_quick_action_installed,
)


def _resolve_app_symbol(name: str, fallback: Any) -> Any:
    """Honors `unittest.mock.patch.object(app, name, ...)` when called via `app`."""
    app_mod = sys.modules.get("app")
    if app_mod is not None and hasattr(app_mod, name):
        return getattr(app_mod, name)
    return fallback


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """
    Application lifespan hook. Preloads the recommended default model if cached
    on disk, and ensures all device memory is flushed on server shutdown.
    """
    default_model_key = TIERS[RECOMMENDED_TIER]["model_key"]
    if is_model_cached_locally(MODELS[default_model_key]):
        threading.Thread(
            target=lambda: MANAGER.get_or_load(default_model_key),
            daemon=True,
        ).start()
    try:
        yield
    finally:
        MANAGER.unload()


app = FastAPI(
    title="OpenBGR — Local Background Removal Studio",
    description="Self-hosted, zero-telemetry dichotomous image segmentation powered by BiRefNet",
    lifespan=lifespan,
)


@app.post("/api/cancel")
def api_cancel() -> dict[str, Any]:
    """Signals any queued or active segmentation job to abort at its next checkpoint."""
    epoch = MANAGER.request_cancel()
    return {"cancelled": True, "epoch": epoch}


@app.get("/api/status")
def api_status() -> dict[str, Any]:
    """
    Returns detected compute hardware, floating-point precision mode, system RAM,
    recommended model, and local offline cache availability and disk usage for each model.
    """
    tiers_status = {}
    total_cache_bytes = 0
    for key, cfg in TIERS.items():
        size_bytes = get_model_disk_bytes(cfg["repo_id"])
        total_cache_bytes += size_bytes
        tiers_status[key] = {
            **cfg,
            "cached": is_model_cached_locally(cfg["repo_id"]),
            "active": MANAGER.active_model_key == cfg["model_key"],
            "size_bytes": size_bytes,
        }

    # Include any leftover legacy 1K matting cache in total disk usage so Uninstall All
    # accurately reflects and reclaims it if present.
    total_cache_bytes += get_model_disk_bytes(LEGACY_MATTING_REPO)
    app_size_bytes = get_app_disk_bytes()
    total_disk_bytes = total_cache_bytes + app_size_bytes

    cache_path = Path(HF_HUB_CACHE)
    try:
        cache_display = f"~/{cache_path.relative_to(Path.home())}"
    except ValueError:
        cache_display = str(cache_path)

    ram_gb_int = max(1, int(round(HOST_RAM_GB)))
    return {
        "device": DEVICE.type,
        "device_label": DEVICE_LABEL,
        "precision": PRECISION_LABEL,
        "ram_gb": ram_gb_int,
        "ram_label": f"{ram_gb_int} GB",
        "recommended_tier": RECOMMENDED_TIER,
        "active_model": MANAGER.active_model_key,
        "version": APP_VERSION,
        "total_cache_bytes": total_cache_bytes,
        "app_size_bytes": app_size_bytes,
        "total_disk_bytes": total_disk_bytes,
        "cache_dir": cache_display,
        "tiers": tiers_status,
        "matting": tiers_status["matting"],
        "open_files_received": desktop.get_open_files_received(),
        "open_files_pending": len(desktop._PENDING_OPEN_FILES),
        "quick_action": {
            **load_quick_action_config(),
            "installed": is_quick_action_installed(),
            "platform": platform.system(),
        },
    }


@app.get("/api/quick-action-config")
def api_get_quick_action_config() -> dict[str, Any]:
    """Returns the persisted Quick Action / context-menu configuration and install status."""
    return {
        **load_quick_action_config(),
        "installed": is_quick_action_installed(),
        "platform": platform.system(),
    }


@app.post("/api/quick-action-config")
async def api_save_quick_action_config(
    tier: str | None = Form(None),
    save_mode: str | None = Form(None),
    fmt: str | None = Form(None, alias="format"),
    edge_refine: bool | None = Form(None),
    copy_clipboard: bool | None = Form(None),
    notify: bool | None = Form(None),
) -> dict[str, Any]:
    """Updates and persists the Quick Action configuration to `~/.openbgr/quick_action.json`."""
    current = load_quick_action_config()
    updates: dict[str, Any] = {}
    if tier is not None:
        updates["tier"] = tier
    if save_mode is not None:
        updates["save_mode"] = save_mode
    if fmt is not None:
        updates["format"] = fmt
    if edge_refine is not None:
        updates["edge_refine"] = edge_refine
    if copy_clipboard is not None:
        updates["copy_clipboard"] = copy_clipboard
    if notify is not None:
        updates["notify"] = notify
    saved = save_quick_action_config({**current, **updates})
    return {
        **saved,
        "installed": is_quick_action_installed(),
        "platform": platform.system(),
    }


@app.post("/api/quick-action-install")
def api_quick_action_install(action: str = Form("install")) -> dict[str, Any]:
    """Installs or removes the OS right-click Quick Action / context menu integration."""
    do_install = action.strip().lower() not in (
        "remove",
        "uninstall",
        "false",
        "0",
    )
    install_fn = _resolve_app_symbol("set_quick_action_installed", set_quick_action_installed)
    ok, detail = install_fn(do_install)
    if not ok:
        raise HTTPException(status_code=500, detail=detail)
    return {
        "ok": True,
        "installed": is_quick_action_installed(),
        "detail": detail,
        "quick_action": {
            **load_quick_action_config(),
            "installed": is_quick_action_installed(),
            "platform": platform.system(),
        },
    }


@app.post("/api/quick-action")
async def api_run_quick_action(files: list[str] = Form(...)) -> dict[str, Any]:
    """
    Executes a Quick Action request (1 or more local image paths) inside the
    already-running server process so the warm GPU/MPS model is reused with
    zero cold-start overhead.
    """
    qa_fn = _resolve_app_symbol("run_quick_action", run_quick_action)
    result = await asyncio.to_thread(qa_fn, list(files))
    return result


@app.post("/api/open-cache-dir")
def api_open_cache_dir() -> dict[str, Any]:
    """Opens the Hugging Face Hub model cache directory in the system file manager."""
    cache_path = Path(HF_HUB_CACHE)
    open_fn = _resolve_app_symbol("open_folder_in_file_manager", open_folder_in_file_manager)
    opened = open_fn(cache_path)
    if not opened:
        raise HTTPException(
            status_code=500,
            detail="Could not open the cache folder in file manager.",
        )
    return {"ok": True, "path": str(cache_path)}


@app.post("/api/open-logs-dir")
def api_open_logs_dir() -> dict[str, Any]:
    """Opens `~/.openbgr/` (containing `openbgr.log`) in the system file manager."""
    logs_dir: Path = _resolve_app_symbol("APP_CONFIG_DIR", APP_CONFIG_DIR)
    open_fn = _resolve_app_symbol("open_folder_in_file_manager", open_folder_in_file_manager)
    opened = open_fn(logs_dir)
    if not opened:
        raise HTTPException(
            status_code=500,
            detail="Could not open the logs folder in file manager.",
        )
    return {"ok": True, "path": str(logs_dir)}


@app.post("/api/models/uninstall")
def api_uninstall_model(target: str = Form(...)) -> dict[str, Any]:
    """
    Deletes cached Hugging Face weights for the requested model (`lite`, `general`,
    `hr`, `portrait`, `matting`, `dynamic`, or `all`) and unloads it if active.
    """
    if MANAGER.inference_lock.locked():
        raise HTTPException(
            status_code=409,
            detail="Cannot uninstall model weights while processing is running.",
        )

    cleaned = target.strip().lower()
    if cleaned == "all":
        model_keys = list(MODELS.keys())
    else:
        norm = normalize_tier_key(cleaned)
        model_keys = [norm] if norm in MODELS else []

    if not model_keys:
        raise HTTPException(status_code=400, detail=f"Unknown model target '{target}'.")

    repos_to_remove: list[str] = []
    for m_key in model_keys:
        if MANAGER.active_model_key == m_key:
            MANAGER.unload()
        repos_to_remove.append(MODELS[m_key])
        if m_key == "matting":
            repos_to_remove.append(LEGACY_MATTING_REPO)

    freed_bytes = 0
    for repo_id in repos_to_remove:
        folder = get_model_cache_dir(repo_id)
        freed_bytes += get_model_disk_bytes(repo_id)
        if folder.exists():
            shutil.rmtree(folder, ignore_errors=True)
        lock_dir = Path(HF_HUB_CACHE) / ".locks" / folder.name
        if lock_dir.exists():
            shutil.rmtree(lock_dir, ignore_errors=True)

    return {
        "ok": True,
        "freed_bytes": freed_bytes,
        "status": api_status(),
    }


@app.post("/api/models/install")
async def api_install_model(target: str = Form(...)) -> dict[str, Any]:
    """
    Downloads and caches the requested Hugging Face model checkpoint (`lite`,
    `general`, `hr`, `portrait`, `matting`, or `dynamic`) in the background and
    compacts any FP32 weights to FP16 on disk.
    """
    norm = normalize_tier_key(target)
    if norm not in MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown model target '{target}'.")

    repo_id = MODELS[norm]
    dl_fn = _resolve_app_symbol("snapshot_download", snapshot_download)
    compact_fn = _resolve_app_symbol("compact_model_cache_fp16", compact_model_cache_fp16)

    def _download() -> None:
        """Blocking download + FP16 compaction, run in a worker thread."""
        dl_fn(repo_id=repo_id)
        compact_fn(repo_id)

    try:
        await asyncio.to_thread(_download)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to download {repo_id}: {exc}") from exc

    return {
        "ok": True,
        "status": api_status(),
    }


@app.post("/api/save")
async def api_save(
    directory: str = Form(...),
    filename: str = Form(...),
    file: UploadFile = File(...),
) -> dict[str, Any]:
    """
    Writes a processed image into a user-chosen output directory (batch mode).
    The filename is sanitized to a plain basename and name collisions are
    auto-renamed (`name.png` -> `name-1.png`, `name-2.png`, ...).
    """
    dest_dir = Path(directory).expanduser()
    if not dest_dir.is_dir():
        raise HTTPException(status_code=400, detail="Output folder does not exist.")
    safe_name = Path(filename).name.strip()
    if not safe_name or safe_name in (".", ".."):
        raise HTTPException(status_code=400, detail="Invalid filename.")

    target = dest_dir / safe_name
    if target.exists():
        stem, suffix = target.stem, target.suffix
        counter = 1
        while (dest_dir / f"{stem}-{counter}{suffix}").exists():
            counter += 1
        target = dest_dir / f"{stem}-{counter}{suffix}"

    data = await file.read()
    target.write_bytes(data)
    return {"ok": True, "path": str(target), "name": target.name}


@app.post("/api/remove-bg")
async def api_remove_bg(
    file: UploadFile = File(...),
    tier: str = Form("general"),
    defringe: bool = Form(True),
    despill: bool = Form(True),
    matting: bool = Form(False),
) -> Response:
    """
    Accepts an uploaded image file and returns a full-resolution, lossless
    32-bit RGBA PNG along with performance telemetry HTTP headers.
    """
    norm_tier = "matting" if matting else normalize_tier_key(tier)
    if norm_tier not in TIERS:
        raise HTTPException(status_code=400, detail=f"Invalid model preset '{tier}'.")

    job_epoch = MANAGER.cancel_epoch
    raw_bytes = await file.read()
    await file.close()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="Uploaded image file is empty.")

    pil_img: Image.Image | None = None
    try:
        pil_img = Image.open(io.BytesIO(raw_bytes))
        pil_img.load()
    except Exception as exc:
        if pil_img is not None:
            pil_img.close()
        raise HTTPException(status_code=400, detail=f"Unable to decode image file: {exc}") from exc
    finally:
        del raw_bytes

    seg_fn = _resolve_app_symbol("segment_foreground", segment_foreground)
    result_img: Image.Image | None = None
    try:
        result_img, elapsed_ms, tier_cfg, job_id = await asyncio.to_thread(
            seg_fn,
            pil_img,
            tier,
            defringe,
            despill,
            matting,
            job_epoch,
        )
    except InterruptedError as exc:
        raise HTTPException(status_code=499, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Segmentation pipeline failed: {exc}") from exc
    finally:
        pil_img.close()

    output_buffer = io.BytesIO()
    try:
        result_img.save(output_buffer, format="PNG", compress_level=1)
        png_bytes = output_buffer.getvalue()
        img_w, img_h = result_img.width, result_img.height
    finally:
        output_buffer.close()
        if result_img is not None:
            result_img.close()

    telemetry_headers = {
        "X-Inference-Time-Ms": f"{elapsed_ms:.1f}",
        "X-Tier-Used": f"{tier_cfg['label']} ({tier_cfg['sublabel']})",
        "X-Device": f"{DEVICE_LABEL} / {PRECISION_LABEL}",
        "X-Image-Width": str(img_w),
        "X-Image-Height": str(img_h),
        "X-Refine-Job-Id": str(job_id),
        "Access-Control-Expose-Headers": (
            "X-Inference-Time-Ms, X-Tier-Used, X-Device, X-Image-Width, "
            "X-Image-Height, X-Refine-Job-Id"
        ),
    }
    safe_headers = {
        k: v.encode("latin-1", errors="ignore").decode("latin-1")
        for k, v in telemetry_headers.items()
    }
    return Response(
        content=png_bytes,
        media_type="image/png",
        headers=safe_headers,
    )


@app.post("/api/refine")
async def api_refine(
    job_id: int = Form(...),
    defringe: bool = Form(True),
    despill: bool = Form(True),
) -> Response:
    """
    Re-applies the edge-refinement filters (defringe/despill) onto the cached
    raw RGB + alpha of the last completed segmentation job — a pure
    post-processing pass that skips re-running the neural network entirely.
    Returns HTTP 409 when the referenced job is no longer the latest one.
    """

    def _render() -> tuple[bytes, int, int]:
        """Re-composes the cached job's RGBA under a lock; raises LookupError if stale."""
        with _LAST_JOB_LOCK:
            job = dict(_LAST_JOB)
        if job.get("id") != job_id:
            raise LookupError
        result_img = compose_rgba(job["rgb"], job["alpha"], defringe, despill)
        buf = io.BytesIO()
        try:
            result_img.save(buf, format="PNG", compress_level=1)
            return buf.getvalue(), result_img.width, result_img.height
        finally:
            buf.close()
            result_img.close()

    try:
        png_bytes, img_w, img_h = await asyncio.to_thread(_render)
    except LookupError as exc:
        raise HTTPException(
            status_code=409,
            detail=(
                "This cutout is no longer the latest processed job — "
                "click PROCESS IMAGE to re-apply edge filters."
            ),
        ) from exc

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={
            "X-Refine-Job-Id": str(job_id),
            "X-Image-Width": str(img_w),
            "X-Image-Height": str(img_h),
            "Access-Control-Expose-Headers": ("X-Refine-Job-Id, X-Image-Width, X-Image-Height"),
        },
    )


@app.middleware("http")
async def no_cache_static(request, call_next):
    """Forces revalidation on the page shell so fresh edits reach the WebView."""
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/")
def serve_index() -> FileResponse:
    """Serves the single-page studio interface."""
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/favicon.ico")
def serve_favicon() -> Response:
    """Serves the OpenBGR squircle icon for browser tabs."""
    icon_path = ensure_app_icon()
    if icon_path and Path(icon_path).is_file():
        return FileResponse(icon_path, media_type="image/png")
    return Response(status_code=204)


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
