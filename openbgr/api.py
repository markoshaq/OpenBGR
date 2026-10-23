"""
FastAPI application and HTTP endpoints for OpenBGR.
"""

from __future__ import annotations

import asyncio
import io
import platform
import secrets
import shutil
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from huggingface_hub import snapshot_download
from huggingface_hub.constants import HF_HUB_CACHE
from PIL import Image

from . import desktop_bridge as desktop
from .config import (
    API_TOKEN,
    API_TOKEN_HEADER,
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
    WEB_API_TOKEN,
    ensure_app_icon,
    get_app_disk_bytes,
    logger,
    normalize_tier_key,
    open_folder_in_file_manager,
    persist_api_token,
)
from .models import (
    JOB_PROGRESS,
    JOB_PROGRESS_LOCK,
    MANAGER,
    clear_model_disk_bytes_cache,
    compact_model_cache_fp16,
    expected_model_bytes,
    get_model_cache_dir,
    get_model_disk_bytes,
    import_model_from_dir,
    is_model_cached_locally,
    maybe_refresh_expected_sizes,
    model_download_active,
    model_download_guard,
    refresh_expected_sizes,
    set_job_phase,
    track_model_download,
)
from .pipeline import (
    compose_rgba,
    get_last_job,
    segment_foreground,
)
from .quick_action import run_quick_action
from .quick_action_config import (
    is_quick_action_installed,
    load_quick_action_config,
    save_quick_action_config,
    set_quick_action_installed,
)
from .quick_action_native import choose_output_folder_native
from .settings import env_forces_offline, offline_mode_enabled, set_offline_mode


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """
    Application lifespan hook. Preloads the recommended default model if cached
    on disk, and ensures all device memory is flushed on server shutdown.
    """
    timer: threading.Timer | None = None
    STATIC_DIR.mkdir(exist_ok=True)
    persist_api_token()
    default_model_key = TIERS[RECOMMENDED_TIER]["model_key"]
    if is_model_cached_locally(MODELS[default_model_key]):
        timer = threading.Timer(0.5, lambda: MANAGER.get_or_load(default_model_key))
        timer.daemon = True
        timer.start()
    if not offline_mode_enabled():
        threading.Thread(target=refresh_expected_sizes, daemon=True).start()
    try:
        yield
    finally:
        if timer is not None:
            timer.cancel()
        MANAGER.request_cancel()
        MANAGER.unload()


app = FastAPI(
    title="OpenBGR - Local Background Removal Studio",
    description="Self-hosted, zero-telemetry dichotomous image segmentation powered by BiRefNet",
    lifespan=lifespan,
)


def _quick_action_status(config: dict[str, Any] | None = None) -> dict[str, Any]:
    """Builds the Quick Action status payload: persisted config + install/platform state."""
    return {
        **(load_quick_action_config() if config is None else config),
        "installed": is_quick_action_installed(),
        "platform": platform.system(),
    }


@app.post("/api/cancel")
def api_cancel() -> dict[str, Any]:
    """Signals any queued or active segmentation job to abort at its next checkpoint."""
    epoch = MANAGER.request_cancel()
    logger.info("[API] Cancellation requested (epoch %d).", epoch)
    return {"cancelled": True, "epoch": epoch}


@app.get("/api/status")
def api_status() -> dict[str, Any]:
    """
    Returns detected compute hardware, floating-point precision mode, system RAM,
    recommended model, and local offline cache availability and disk usage for each model.
    """
    maybe_refresh_expected_sizes()
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
            "expected_bytes": expected_model_bytes(
                cfg["repo_id"], int(cfg.get("expected_bytes", 0))
            ),
        }

    # Include any leftover legacy 1K matting cache in total disk usage so Uninstall All
    # accurately reflects and reclaims it if present.
    total_cache_bytes += get_model_disk_bytes(LEGACY_MATTING_REPO)
    app_size_bytes = get_app_disk_bytes()
    total_disk_bytes = total_cache_bytes + app_size_bytes

    cache_path = Path(HF_HUB_CACHE)
    try:
        cache_display = f"~/{cache_path.relative_to(Path.home()).as_posix()}"
    except ValueError:
        cache_display = str(cache_path)

    ram_gb_int = max(1, int(round(HOST_RAM_GB)))
    return {
        "app": "openbgr",
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
        "offline_mode": offline_mode_enabled(),
        "offline_forced": env_forces_offline(),
        "tiers": tiers_status,
        "quick_action": _quick_action_status(),
    }


@app.get("/api/settings")
def api_get_settings() -> dict[str, Any]:
    """Returns persisted app settings: the offline-mode switch and env-forced state."""
    return {
        "offline_mode": offline_mode_enabled(),
        "offline_forced": env_forces_offline(),
    }


@app.post("/api/settings")
def api_save_settings(offline_mode: bool | None = Form(None)) -> dict[str, Any]:
    """Updates persisted app settings; currently only the offline-mode switch."""
    if offline_mode is not None:
        set_offline_mode(offline_mode)
    return api_get_settings()


@app.get("/api/quick-action-config")
def api_get_quick_action_config() -> dict[str, Any]:
    """Returns the persisted Quick Action / context-menu configuration and install status."""
    return _quick_action_status()


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
    return _quick_action_status(saved)


@app.post("/api/quick-action-install")
def api_quick_action_install(action: str = Form("install")) -> dict[str, Any]:
    """Installs or removes the OS right-click Quick Action / context menu integration."""
    do_install = action.strip().lower() not in (
        "remove",
        "uninstall",
        "false",
        "0",
    )
    ok, detail = set_quick_action_installed(do_install)
    if not ok:
        raise HTTPException(status_code=500, detail=detail)
    return {
        "ok": True,
        "installed": is_quick_action_installed(),
        "detail": detail,
        "quick_action": _quick_action_status(),
    }


@app.post("/api/quick-action")
async def api_run_quick_action(files: list[str] = Form(...)) -> dict[str, Any]:
    """
    Executes a Quick Action request (1 or more local image paths) inside the
    already-running server process so the warm GPU/MPS model is reused with
    zero cold-start overhead.
    """
    return await asyncio.to_thread(run_quick_action, list(files))


@app.post("/api/open-files")
def api_open_files(files: list[str] = Form(...)) -> dict[str, Any]:
    """
    Queues one or more local image paths into the running workspace so 'Open With'
    on Windows/Linux/CLI opens tabs in the active window.
    """
    desktop.queue_open_files(list(files))
    return {
        "ok": True,
        "pending": desktop.get_pending_open_files_count(),
        "received": desktop.get_open_files_received(),
    }


@app.post("/api/pending-files")
def api_take_pending_files() -> dict[str, Any]:
    """Drains OS-delivered open-file requests over HTTP (for browser/reused-server mode)."""
    return desktop.take_pending_files()


@app.get("/api/local-file")
def api_local_file(file_id: str) -> Response:
    """
    Streams the bytes of a local file the user explicitly granted to the app
    (native dialog pick or OS 'open with' event). The unguessable one-shot
    `file_id` is the capability; no arbitrary path is accepted, so a web page
    cannot use this endpoint to read the filesystem.
    """
    path = desktop.pop_local_file(file_id)
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="File grant is unknown or expired.")
    return FileResponse(path)


@app.post("/api/open-cache-dir")
def api_open_cache_dir() -> dict[str, Any]:
    """Opens the Hugging Face Hub model cache directory in the system file manager."""
    cache_path = Path(HF_HUB_CACHE)
    opened = open_folder_in_file_manager(cache_path)
    if not opened:
        raise HTTPException(
            status_code=500,
            detail="Could not open the cache folder in file manager.",
        )
    return {"ok": True, "path": str(cache_path)}


@app.post("/api/open-logs-dir")
def api_open_logs_dir() -> dict[str, Any]:
    """Opens `~/.openbgr/` (containing `openbgr.log`) in the system file manager."""
    opened = open_folder_in_file_manager(APP_CONFIG_DIR)
    if not opened:
        raise HTTPException(
            status_code=500,
            detail="Could not open the logs folder in file manager.",
        )
    return {"ok": True, "path": str(APP_CONFIG_DIR)}


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
    with JOB_PROGRESS_LOCK:
        job_phase = JOB_PROGRESS["phase"]
    if model_download_active() or job_phase in ("download", "load"):
        raise HTTPException(
            status_code=409,
            detail="A model is still downloading or loading. Wait for it to finish before uninstalling.",
        )

    cleaned = target.strip().lower()
    if cleaned == "all":
        model_keys = list(MODELS.keys())
    else:
        norm = normalize_tier_key(cleaned)
        model_keys = [norm] if norm in MODELS else []

    if not model_keys:
        raise HTTPException(status_code=400, detail=f"Unknown model target '{target}'.")

    # Unload BEFORE taking the download lock: unload() acquires the manager's
    # model lock internally, and a load in progress holds that lock while it
    # acquires the download lock, so nesting the load lock inside the download
    # lock here would deadlock. wait=False converts the check→unload race (a
    # job starting in the gap) into a prompt 409 instead of blocking the
    # request for a whole first-run download.
    for m_key in model_keys:
        if MANAGER.active_model_key == m_key and not MANAGER.unload(wait=False):
            raise HTTPException(
                status_code=409,
                detail="A model is still downloading or loading. Wait for it to finish before uninstalling.",
            )

    # Hold both locks for the whole deletion so a download or job cannot
    # start between the fast-fail checks above and the rmtree calls below.
    # Non-blocking acquires convert the residual race into a fast 409
    # rather than hanging on a whole download/inference.
    if not MANAGER.inference_lock.acquire(blocking=False):
        raise HTTPException(
            status_code=409,
            detail="Cannot uninstall model weights while processing is running.",
        )
    try:
        with model_download_guard(blocking=False):
            repos_to_remove: list[str] = []
            for m_key in model_keys:
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
    except BlockingIOError:
        raise HTTPException(
            status_code=409,
            detail="A model is still downloading or loading. Wait for it to finish before uninstalling.",
        ) from None
    finally:
        MANAGER.inference_lock.release()

    clear_model_disk_bytes_cache()
    logger.info(
        "[API] Uninstalled %s (freed %.1f MB).",
        ", ".join(model_keys),
        freed_bytes / 1024**2,
    )
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
    if model_download_active():
        raise HTTPException(
            status_code=409,
            detail="Another model is already downloading. Wait for it to finish first.",
        )

    repo_id = MODELS[norm]
    if offline_mode_enabled():
        raise HTTPException(
            status_code=409,
            detail=(
                "Internet access is blocked (offline mode). Download "
                f"{repo_id} yourself and import the folder under "
                "Settings > Models, or disable offline mode."
            ),
        )

    def _download() -> None:
        """Blocking download + FP16 compaction, run in a worker thread."""
        with track_model_download(norm) as dl_tqdm:
            snapshot_download(repo_id=repo_id, tqdm_class=dl_tqdm)
        set_job_phase("load", norm)
        compact_model_cache_fp16(repo_id)

    try:
        await asyncio.to_thread(_download)
    except InterruptedError as exc:
        set_job_phase("idle")
        raise HTTPException(status_code=499, detail=str(exc)) from exc
    except Exception as exc:
        set_job_phase("idle")
        logger.exception("[API] Failed to download %s.", repo_id)
        raise HTTPException(status_code=500, detail=f"Failed to download {repo_id}: {exc}") from exc

    logger.info("[API] Model installed: %s.", repo_id)
    set_job_phase("idle")
    return {
        "ok": True,
        "status": api_status(),
    }


@app.post("/api/choose-folder")
async def api_choose_folder() -> dict[str, Any]:
    """
    Opens the native OS folder dialog from the server process and grants the
    picked folder via `desktop_bridge.grant_output_dir`. Used as the browser-
    mode fallback when `window.pywebview.api.choose_output_dir` is unavailable.
    """
    chosen = await asyncio.to_thread(choose_output_folder_native, Path.home(), 1)
    if chosen is None:
        return {"cancelled": True}
    desktop.grant_output_dir(chosen)
    return {"cancelled": False, "path": str(chosen)}


@app.post("/api/models/import")
async def api_import_model(target: str = Form(...), path: str = Form(...)) -> dict[str, Any]:
    """
    Copies a user-provided checkpoint folder into the Hugging Face cache as a
    synthetic snapshot, so a model can be provisioned with zero network
    access (files fetched through a browser, another machine, or `hf download`).
    The folder must have been granted via the native folder dialog (see
    `desktop_bridge.grant_output_dir`).
    """
    norm = normalize_tier_key(target)
    if norm not in MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown model target '{target}'.")
    src_dir = Path(path).expanduser()
    if not desktop.is_output_dir_granted(src_dir):
        raise HTTPException(
            status_code=403,
            detail=(
                "Model folder was not picked through the app's folder dialog. "
                "Choose it with BROWSE before importing."
            ),
        )
    repo_id = MODELS[norm]

    def _import() -> int:
        # Serializes the cache write against in-flight downloads/uninstalls.
        with model_download_guard(blocking=False):
            return import_model_from_dir(repo_id, src_dir)

    try:
        copied_bytes = await asyncio.to_thread(_import)
    except BlockingIOError:
        raise HTTPException(
            status_code=409,
            detail="A model is still downloading or loading. Wait for it to finish before importing.",
        ) from None
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("[API] Failed to import %s from %s.", repo_id, path)
        raise HTTPException(status_code=500, detail=f"Failed to import {repo_id}: {exc}") from exc

    compact_model_cache_fp16(repo_id)
    logger.info(
        "[API] Imported %s from %s (%.1f MB).",
        repo_id,
        path,
        copied_bytes / 1024**2,
    )
    return {
        "ok": True,
        "status": api_status(),
    }


@app.get("/api/progress")
def api_job_progress() -> dict[str, Any]:
    """
    Returns the current pipeline phase (`idle`, `download`, `load`, `inference`)
    plus live model-download byte counts, for the frontend busy overlay.
    """
    with JOB_PROGRESS_LOCK:
        snap = dict(JOB_PROGRESS)
        dl_key = snap.pop("_dl_key", None)
        snap.pop("_dl_epoch", None)
    # The download phase is a fact (the serialization lock is held), not a
    # label: a concurrent load/idle/inference phase write from another
    # operation must not hide an active download's progress.
    if model_download_active():
        snap["phase"] = "download"
        if dl_key is not None:
            snap["model_key"] = dl_key
    return snap


@app.post("/api/save")
async def api_save(
    directory: str = Form(...),
    filename: str = Form(...),
    file: UploadFile = File(...),
) -> dict[str, Any]:
    """
    Writes a processed image into a user-chosen output directory (batch mode).
    The directory must have been granted by a native folder-dialog pick (see
    `desktop_bridge.grant_output_dir`), the filename is sanitized to a plain
    basename, and name collisions are auto-renamed (`name.png` -> `name-1.png`).
    """
    dest_dir = Path(directory).expanduser()
    if not desktop.is_output_dir_granted(dest_dir):
        raise HTTPException(
            status_code=403,
            detail=(
                "Output folder was not picked through the app's folder dialog. "
                "Choose it again before exporting."
            ),
        )
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

    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail="File exceeds the 256 MB upload limit.",
        )
    # Keep large writes off the event loop so batch saves don't stall the
    # 250ms progress polls.
    await asyncio.to_thread(target.write_bytes, data)
    return {"ok": True, "path": str(target), "name": target.name}


@app.post("/api/remove-bg")
async def api_remove_bg(
    file: UploadFile = File(...),
    tier: str = Form("general"),
    defringe: bool = Form(True),
    despill: bool = Form(True),
    matting: bool = Form(False),
    edge_shift: int = Form(0),
    edge_feather: int = Form(0),
) -> Response:
    """
    Accepts an uploaded image file and returns a full-resolution, lossless
    32-bit RGBA PNG along with performance telemetry HTTP headers.
    """
    norm_tier = "matting" if matting else normalize_tier_key(tier)
    if norm_tier not in TIERS:
        raise HTTPException(status_code=400, detail=f"Invalid model preset '{tier}'.")

    job_epoch = MANAGER.cancel_epoch
    raw_bytes = await file.read(MAX_UPLOAD_BYTES + 1)
    await file.close()
    if len(raw_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Image exceeds the 256 MB upload limit.",
        )
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

    result_img: Image.Image | None = None
    try:
        result_img, elapsed_ms, tier_cfg, job_id = await asyncio.to_thread(
            segment_foreground,
            pil_img,
            tier,
            defringe,
            despill,
            matting,
            job_epoch,
            max(-32, min(32, edge_shift)),
            max(0, min(64, edge_feather)),
        )
    except InterruptedError as exc:
        raise HTTPException(status_code=499, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("[API] Segmentation pipeline failed.")
        raise HTTPException(status_code=500, detail=f"Segmentation pipeline failed: {exc}") from exc
    finally:
        set_job_phase("idle")
        pil_img.close()

    # All except paths above raise, so reaching here means the job succeeded.
    if result_img is None:
        raise HTTPException(status_code=500, detail="Pipeline returned no image.")
    output_buffer = io.BytesIO()
    try:
        result_img.save(output_buffer, format="PNG", compress_level=1)
        png_bytes = output_buffer.getvalue()
        img_w, img_h = result_img.width, result_img.height
    finally:
        output_buffer.close()
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
    logger.info(
        "[API] Processed %s (%dx%d) in %.0f ms via %s.",
        file.filename or "image",
        img_w,
        img_h,
        elapsed_ms,
        tier_cfg["sublabel"],
    )
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
    edge_shift: int = Form(0),
    edge_feather: int = Form(0),
) -> Response:
    """
    Re-applies the edge-refinement filters (defringe/despill/edge geometry)
    onto the cached raw RGB + alpha of the last completed segmentation job:
    a pure post-processing pass that skips re-running the neural network
    entirely. Returns HTTP 409 when the referenced job is no longer the
    latest one.
    """

    def _render() -> tuple[bytes, int, int]:
        """Re-composes the cached job's RGBA; raises LookupError if stale."""
        job = get_last_job(job_id)
        if job is None:
            raise LookupError
        result_img = compose_rgba(
            job["rgb"],
            job["alpha"],
            defringe,
            despill,
            max(-32, min(32, edge_shift)),
            max(0, min(64, edge_feather)),
        )
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
                "This cutout is no longer the latest processed job. "
                "Click PROCESS IMAGE to re-apply edge filters."
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


_MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
# Fetch-metadata values a same-origin page never sends on its own API calls.
# The token check alone already blocks drive-by POSTs; rejecting explicitly
# cross-site fetch metadata is a second layer in case the token ever leaks.
_CROSS_SITE_FETCH = {"cross-site", "same-site"}
# Raw-path IPC endpoints used only by local OS clients (Quick Action delegation
# and Open With forwarding). They require `API_TOKEN` from `0600 ~/.openbgr/session_token`
# and refuse the browser `WEB_API_TOKEN` injected into `GET /`, so a web page
# cannot turn arbitrary paths into readable file grants or write beside them.
_LOCAL_ONLY_PATHS = {"/api/open-files", "/api/quick-action"}

# Uploads are buffered whole before decode/write, so request bodies are
# hard-capped to keep a bad client from pinning gigabytes of RAM. Generous
# for real photography: a 100 MP JPEG is ~40 MB.
MAX_UPLOAD_BYTES = 256 * 1024 * 1024
# Slack on top of the file cap so the multipart envelope itself (boundaries,
# form fields) cannot false-positive a borderline upload.
_MULTIPART_OVERHEAD_BYTES = 64 * 1024


@app.middleware("http")
async def api_token_guard(request, call_next):
    """
    Requires a per-session token on mutating `/api/*` calls so arbitrary
    websites cannot trigger file writes, model deletions, or job control via
    cross-origin form posts (drive-by localhost CSRF). Browser-facing endpoints
    accept either `WEB_API_TOKEN` (injected into `GET /`) or `API_TOKEN`
    (`0600 ~/.openbgr/session_token`); raw-path IPC endpoints (`/api/open-files`,
    `/api/quick-action`) require `API_TOKEN` so a browser page cannot supply
    ungranted filesystem paths.
    """
    if request.method in _MUTATING_METHODS and request.url.path.startswith("/api/"):
        if request.headers.get("sec-fetch-site") in _CROSS_SITE_FETCH:
            return JSONResponse({"detail": "Forbidden"}, status_code=403)
        token = request.headers.get(API_TOKEN_HEADER, "")
        is_local = secrets.compare_digest(token, API_TOKEN)
        is_web = secrets.compare_digest(token, WEB_API_TOKEN)
        if request.url.path in _LOCAL_ONLY_PATHS:
            if not is_local:
                return JSONResponse({"detail": "Forbidden"}, status_code=403)
        elif not (is_local or is_web):
            return JSONResponse({"detail": "Forbidden"}, status_code=403)
    return await call_next(request)


@app.middleware("http")
async def request_size_guard(request, call_next):
    """
    Rejects over-sized API uploads by Content-Length before the body is
    consumed. Uploads lacking a length (chunked) are still capped when the
    handlers read the file with a `MAX_UPLOAD_BYTES` bound.
    """
    if request.method in _MUTATING_METHODS and request.url.path.startswith("/api/"):
        length = request.headers.get("content-length")
        if (
            length is not None
            and length.isdigit()
            and int(length) > MAX_UPLOAD_BYTES + _MULTIPART_OVERHEAD_BYTES
        ):
            return JSONResponse({"detail": "Upload exceeds the 256 MB limit."}, status_code=413)
    return await call_next(request)


# Host allowlisting closes the rebinding hole: the session token is injected
# into `/` for anyone who can reach the port, so a page loaded from a domain
# that rebinds to 127.0.0.1 could otherwise read the token same-origin and
# call mutating endpoints that pass both checks above. Only loopback names
# may serve the app (the server binds 127.0.0.1, so no other Host is valid).
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["127.0.0.1", "localhost", "*.localhost"],
    www_redirect=False,
)


_INDEX_CSP = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' blob: data:; "
    "connect-src 'self'"
)


@app.get("/")
def serve_index() -> Response:
    """Serves the studio interface with the browser-scoped session token injected."""
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    token_meta = f'<meta name="openbgr-api-token" content="{WEB_API_TOKEN}" />'
    if "</head>" in html:
        html = html.replace("</head>", f"  {token_meta}\n</head>", 1)
    else:
        html = token_meta + html
    return HTMLResponse(html, headers={"Content-Security-Policy": _INDEX_CSP})


@app.get("/favicon.ico")
def serve_favicon() -> Response:
    """Serves the OpenBGR squircle icon for browser tabs."""
    icon_path = ensure_app_icon()
    if icon_path and Path(icon_path).is_file():
        return FileResponse(icon_path, media_type="image/png")
    return Response(status_code=204)


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
