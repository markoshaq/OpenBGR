"""
JavaScript-to-Python bridge (`DesktopApi`) exposed as `window.pywebview.api`,
plus the pending open-files queue fed by OS 'open with' events.
"""

from __future__ import annotations

import json
import os
import platform
import secrets
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any

from huggingface_hub.constants import HF_HUB_CACHE

from .config import (
    APP_CONFIG_DIR,
    logger,
    open_folder_in_file_manager,
    reveal_in_file_manager,
)
from .desktop_clipboard import ClipboardMixin
from .models import MANAGER
from .settings import IMAGE_EXTENSIONS

# Image paths handed to the app by the OS (argv / macOS 'odoc' AppleEvent) that
# the frontend should ingest into tabs once the window is ready.
_PENDING_OPEN_LOCK = threading.Lock()
_PENDING_OPEN_FILES: list[str] = []
_MAX_PENDING_OPEN_FILES = 128
_DESKTOP_API: DesktopApi | None = None
_OPEN_FILES_RECEIVED = 0


def set_desktop_api(bridge: DesktopApi | None) -> None:
    """Registers the active `DesktopApi` bridge instance for OS-delivered file events."""
    global _DESKTOP_API
    _DESKTOP_API = bridge


def get_desktop_api() -> DesktopApi | None:
    """Returns the registered `DesktopApi` bridge instance, or None in headless mode."""
    return _DESKTOP_API


def get_open_files_received() -> int:
    """Returns the monotonic count of OS-delivered open-file events."""
    return _OPEN_FILES_RECEIVED


def get_pending_open_files_count() -> int:
    """Returns how many OS-delivered open-file requests await ingestion."""
    with _PENDING_OPEN_LOCK:
        return len(_PENDING_OPEN_FILES)


# One-shot registry mapping opaque ids to local paths the user explicitly
# handed to the app (native dialog picks, OS 'open with' events). Bytes are
# served over `GET /api/local-file` instead of base64 through the JS bridge,
# which removes the old 48 MB payload cap and the JSON encode/decode pass.
_LOCAL_FILE_LOCK = threading.Lock()
_LOCAL_FILES: dict[str, tuple[Path, float]] = {}
_LOCAL_FILE_TTL_S = 600.0

# Session-scoped registry of output folders the user picked through the
# native folder dialog. `/api/save` refuses any directory outside this set,
# so a page holding the session token cannot write into paths the user never
# chose. Unlike one-shot file reads, dir grants stay valid all session: the
# same picked folder serves every export and batch item.
_OUTPUT_DIRS_LOCK = threading.Lock()
_OUTPUT_DIRS: set[Path] = set()


def grant_output_dir(path: Path) -> Path:
    """Marks a native folder-dialog pick as a trusted export destination."""
    resolved = path.expanduser().resolve()
    with _OUTPUT_DIRS_LOCK:
        _OUTPUT_DIRS.add(resolved)
    return resolved


def is_output_dir_granted(path: Path) -> bool:
    """True when `path` resolves to a folder the user picked via the native dialog."""
    try:
        resolved = path.expanduser().resolve()
    except Exception:
        return False
    with _OUTPUT_DIRS_LOCK:
        return resolved in _OUTPUT_DIRS


# Recently opened image paths, persisted across restarts for File > Open Recent.
_RECENT_FILES_LOCK = threading.Lock()
_MAX_RECENT_FILES = 12


def _recent_files_path() -> Path:
    """Location of the persisted Open Recent list."""
    return APP_CONFIG_DIR / "recent_files.json"


def _load_recent_files() -> list[str]:
    """Reads the persisted path list; malformed or missing files yield []."""
    try:
        data = json.loads(_recent_files_path().read_text(encoding="utf-8"))
        if isinstance(data, list):
            return [str(p) for p in data if isinstance(p, str)]
    except Exception:
        pass
    return []


def _save_recent_files(paths: list[str]) -> None:
    """Writes the recent-files list; persistence failures are non-fatal."""
    try:
        APP_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        _recent_files_path().write_text(json.dumps(paths, indent=2), encoding="utf-8")
    except Exception:
        pass


def add_recent_files(paths: Any) -> None:
    """Prepends image paths to the persisted Open Recent list (newest first)."""
    files = [
        str(Path(str(p)).resolve())
        for p in paths
        if Path(str(p)).is_file() and Path(str(p)).suffix.lower() in IMAGE_EXTENSIONS
    ]
    if not files:
        return
    with _RECENT_FILES_LOCK:
        merged = files + [p for p in _load_recent_files() if p not in files]
        _save_recent_files(merged[:_MAX_RECENT_FILES])


def list_recent_files() -> list[dict[str, str]]:
    """Returns the persisted Open Recent list, pruned to files that still exist."""
    with _RECENT_FILES_LOCK:
        recent = _load_recent_files()
        existing = [p for p in recent if Path(p).is_file()]
        if existing != recent:
            _save_recent_files(existing)
    entries = []
    for p in existing:
        path = Path(p)
        try:
            display = f"~/{path.relative_to(Path.home()).as_posix()}"
        except ValueError:
            display = p
        entries.append({"name": path.name, "path": p, "display": display})
    return entries


def _purge_expired_local_files() -> None:
    """Drops stale file grants (caller must hold `_LOCAL_FILE_LOCK`)."""
    now = time.monotonic()
    stale = [k for k, (_, at) in _LOCAL_FILES.items() if now - at > _LOCAL_FILE_TTL_S]
    for k in stale:
        _LOCAL_FILES.pop(k, None)


def register_local_files(paths: list[Path]) -> list[dict[str, Any]]:
    """Grants one-time HTTP read access to user-picked files; returns {name, file_id, size} entries."""
    granted: list[dict[str, Any]] = []
    with _LOCAL_FILE_LOCK:
        _purge_expired_local_files()
        for file_path in paths:
            try:
                if not file_path.is_file():
                    continue
                size = file_path.stat().st_size
            except OSError:
                continue
            file_id = secrets.token_urlsafe(16)
            _LOCAL_FILES[file_id] = (file_path, time.monotonic())
            granted.append({"name": file_path.name, "file_id": file_id, "size": size})
    return granted


def pop_local_file(file_id: str) -> Path | None:
    """Returns the granted path for `file_id` once, or None when unknown or expired."""
    with _LOCAL_FILE_LOCK:
        _purge_expired_local_files()
        entry = _LOCAL_FILES.pop(file_id, None)
    return entry[0] if entry else None


def take_pending_files() -> dict[str, Any]:
    """Drains OS-delivered open-file requests (argv / macOS 'odoc') for ingestion."""
    with _PENDING_OPEN_LOCK:
        paths = list(dict.fromkeys(_PENDING_OPEN_FILES))
        _PENDING_OPEN_FILES.clear()
    if not paths:
        return {"files": []}
    return {"files": register_local_files([Path(p) for p in paths])}


def queue_open_files(paths: Any) -> None:
    """Queues OS-delivered image paths for ingestion and nudges a live window."""
    global _OPEN_FILES_RECEIVED
    if not paths:
        return
    # Launching a bundle binary as `MyApp.app/.../MyApp script.py` makes
    # LaunchServices report argv[1:] as documents to open ('odoc'), which would
    # otherwise load the entrypoint script itself as an image tab.
    file_list = [
        str(p)
        for p in paths
        if Path(str(p)).is_file() and Path(str(p)).suffix.lower() in IMAGE_EXTENSIONS
    ]
    if not file_list:
        return
    add_recent_files(file_list)
    with _PENDING_OPEN_LOCK:
        _PENDING_OPEN_FILES.extend(file_list)
        if len(_PENDING_OPEN_FILES) > _MAX_PENDING_OPEN_FILES:
            del _PENDING_OPEN_FILES[:-_MAX_PENDING_OPEN_FILES]
        _OPEN_FILES_RECEIVED += len(file_list)
    bridge = _DESKTOP_API
    if bridge is not None and bridge.window is not None:
        # evaluate_js blocks on a semaphore until JS runs; calling it directly
        # from the main thread (odoc/delegate callbacks) would deadlock the run
        # loop, so the push happens on a daemon thread. The frontend's poll
        # covers the case where this races the page load.
        def _push() -> None:
            try:
                bridge.window.evaluate_js(
                    "window.openBGR && window.openBGR.pullPendingFiles "
                    "&& window.openBGR.pullPendingFiles()"
                )
            except Exception:
                pass

        threading.Thread(target=_push, daemon=True).start()


class DesktopApi(ClipboardMixin):
    """
    JavaScript-to-Python bridge exposed as `window.pywebview.api` when running
    inside the native pywebview desktop window. Provides native OS file dialogs
    (Open / Save As), native OS clipboard image copy/paste (via `ClipboardMixin`),
    window fullscreen and theme synchronization, external browser links, and
    clean Quit.
    """

    def __init__(self) -> None:
        """The pywebview window handle is attached after `create_window`."""
        self.window: Any = None
        self.native_menus: bool = False
        # (sequence, has_image) of the last clipboard probe. Each OS exposes a
        # cheap change counter so per-focus probes can skip the expensive
        # content decode while the clipboard is unchanged.
        self._clip_seq: Any = None
        self._clip_has_image: bool | None = None

    def __dir__(self) -> list[str]:
        """
        Hides `window` and `native_menus` from `dir(self)` so pywebview's
        `inject_pywebview` never recurses into `webview.window.Window` (whose
        `@_loaded_event` properties block on `events.loaded.wait()`, deadlocking
        the JS bridge injection thread before `window.pywebview.api` is built).
        """
        return [name for name in super().__dir__() if name not in ("window", "native_menus")]

    def native_menus_enabled(self) -> dict[str, Any]:
        """Reports whether a native OS menu bar is attached to the desktop window."""
        return {"enabled": bool(self.native_menus)}

    def take_pending_files(self) -> dict[str, Any]:
        """Drains OS-delivered open-file requests (argv / macOS 'odoc') for ingestion."""
        return take_pending_files()

    def get_recent_files(self) -> dict[str, Any]:
        """Returns the persisted Open Recent list (files that still exist)."""
        return {"files": list_recent_files()}

    def open_recent_file(self, path: str) -> dict[str, Any]:
        """Grants one-shot read access to an entry of the Open Recent list."""
        resolved = str(Path(str(path)).resolve()) if path else ""
        known = {entry["path"] for entry in list_recent_files()}
        if resolved and resolved in known:
            return {"files": register_local_files([Path(resolved)])}
        return {"files": [], "error": "File is no longer available."}

    def clear_recent_files(self) -> dict[str, Any]:
        """Empties the persisted Open Recent list."""
        with _RECENT_FILES_LOCK:
            _save_recent_files([])
        return {"cleared": True}

    def reveal_path(self, path: str) -> dict[str, Any]:
        """Opens the OS file manager with a saved file selected (or its folder)."""
        try:
            return {"revealed": reveal_in_file_manager(Path(str(path)))}
        except Exception as exc:
            return {"revealed": False, "error": str(exc)}

    @staticmethod
    def _dialog_mode(webview_mod: Any, kind: str) -> Any:
        """Resolves the open/save dialog constant across pywebview API versions."""
        file_dialog = getattr(webview_mod, "FileDialog", None)
        if file_dialog is not None and hasattr(file_dialog, kind):
            return getattr(file_dialog, kind)
        return getattr(webview_mod, f"{kind}_DIALOG")

    def open_image_dialog(self) -> dict[str, Any]:
        """Opens the native Open File dialog and returns one-shot file grants for the picks."""
        if self.window is None:
            return {"cancelled": True}
        try:
            import webview

            result = self.window.create_file_dialog(
                self._dialog_mode(webview, "OPEN"),
                allow_multiple=True,
                file_types=(
                    "Image Files (*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif;*.tif;*.tiff)",
                    "All files (*.*)",
                ),
            )
            if not result:
                return {"cancelled": True}

            paths = list(result) if isinstance(result, (list, tuple)) else [str(result)]
            add_recent_files(paths)
            files = register_local_files([Path(p_str) for p_str in paths])
            if not files:
                return {"cancelled": True}
            return {"files": files}
        except Exception as exc:
            return {"cancelled": True, "error": str(exc)}

    def save_file(self, data_base64: str, default_filename: str) -> dict[str, Any]:
        """Opens a native OS Save dialog and writes the base64-encoded image to disk."""
        if self.window is None:
            return {
                "saved": False,
                "error": "Desktop window is not initialized.",
            }
        try:
            raw_bytes = self._decode_bounded_base64(data_base64)
            import webview

            dest = self.window.create_file_dialog(
                self._dialog_mode(webview, "SAVE"),
                save_filename=default_filename,
            )
            if not dest:
                return {"saved": False, "cancelled": True}

            target_path = dest[0] if isinstance(dest, (list, tuple)) else str(dest)
            Path(target_path).write_bytes(raw_bytes)
            return {"saved": True, "path": target_path}
        except Exception as exc:
            return {"saved": False, "error": str(exc)}

    def restart_app(self) -> dict[str, Any]:
        """Restarts the app by replacing or re-spawning this process with the same argv."""

        def _do() -> None:
            # No unload(): it can block for an entire in-flight model download,
            # and os.execv/os._exit reclaims device memory on its own.
            MANAGER.request_cancel()
            os.environ["OPENBGR_RESTARTING"] = "1"
            if platform.system() == "Windows":
                # Spawn the replacement first (it inherits OPENBGR_RESTARTING
                # and waits for our port), then exit before webview.start()
                # can return and os._exit(0) on the main thread.
                subprocess.Popen([sys.executable, *sys.argv], close_fds=True)
                os._exit(0)
            # No window.destroy() or delay: destroy() makes webview.start()
            # return on the main thread, whose os._exit(0) kills us before
            # execv runs. execv alone replaces this process, the window dies
            # with it, and the O_CLOEXEC server sockets free the port.
            os.execv(sys.executable, [sys.executable, *sys.argv])

        logger.info("[Desktop] Restart requested.")
        threading.Thread(target=_do, daemon=True).start()
        return {"restarting": True}

    def choose_output_dir(self) -> dict[str, Any]:
        """Opens a native OS folder picker for direct-to-folder exports."""
        if self.window is None:
            return {"cancelled": True}
        try:
            import webview

            result = self.window.create_file_dialog(self._dialog_mode(webview, "FOLDER"))
            if not result:
                return {"cancelled": True}
            path = result[0] if isinstance(result, (list, tuple)) else str(result)
            grant_output_dir(Path(path))
            return {"cancelled": False, "path": str(path)}
        except Exception as exc:
            return {"cancelled": True, "error": str(exc)}

    def toggle_fullscreen(self) -> dict[str, Any]:
        """Toggles native OS fullscreen mode on the desktop window."""
        try:
            if self.window is not None:
                self.window.toggle_fullscreen()
                return {"toggled": True}
        except Exception as exc:
            return {"toggled": False, "error": str(exc)}
        return {"toggled": False}

    def open_external(self, url: str) -> dict[str, Any]:
        """Opens an external HTTP(S) link in the user's default system browser."""
        if isinstance(url, str) and url.startswith(("https://", "http://")):
            webbrowser.open(url)
            return {"opened": True}
        return {"opened": False}

    def open_cache_dir(self) -> dict[str, Any]:
        """Opens the Hugging Face model cache directory in the system file manager."""
        cache_path = Path(HF_HUB_CACHE)
        return {
            "opened": open_folder_in_file_manager(cache_path),
            "path": str(cache_path),
        }

    def open_logs_dir(self) -> dict[str, Any]:
        """Opens `~/.openbgr/` (containing `openbgr.log`) in the system file manager."""
        return {
            "opened": open_folder_in_file_manager(APP_CONFIG_DIR),
            "path": str(APP_CONFIG_DIR),
        }

    def set_window_theme(self, theme: str) -> dict[str, Any]:
        """Synchronizes the native OS window frame appearance with Dark or Light mode."""
        sys_name = platform.system()
        if sys_name == "Darwin" and self.window is not None:
            try:
                import AppKit  # type: ignore
                from PyObjCTools import AppHelper  # type: ignore

                def _apply() -> None:
                    """Applies the NSAppearance on the AppKit main thread."""
                    try:
                        ns_win = getattr(self.window, "native", None)
                        if ns_win is None:
                            return
                        appearance_name = (
                            AppKit.NSAppearanceNameAqua
                            if theme == "light"
                            else AppKit.NSAppearanceNameDarkAqua
                        )
                        appearance = AppKit.NSAppearance.appearanceNamed_(appearance_name)
                        if appearance is not None:
                            ns_win.setAppearance_(appearance)
                    except Exception:
                        pass

                AppHelper.callAfter(_apply)
                return {"updated": True}
            except Exception:
                pass
        elif sys_name == "Windows" and self.window is not None:
            try:
                import ctypes

                native = getattr(self.window, "native", None)
                handle_obj: Any = getattr(native, "Handle", None)
                to_int64 = getattr(handle_obj, "ToInt64", None)
                hwnd = int(to_int64()) if callable(to_int64) else int(handle_obj or 0)
                if hwnd:
                    dark_flag = ctypes.c_int(0 if theme == "light" else 1)
                    ctypes.windll.dwmapi.DwmSetWindowAttribute(  # type: ignore[attr-defined]
                        ctypes.c_void_p(hwnd),
                        ctypes.c_uint(20),  # DWMWA_USE_IMMERSIVE_DARK_MODE
                        ctypes.byref(dark_flag),
                        ctypes.sizeof(dark_flag),
                    )
                    return {"updated": True}
            except Exception:
                pass
        return {"updated": False}

    def quit(self) -> dict[str, Any]:
        """
        Cancels any active inference job, unloads GPU memory, and destroys the
        native window so `webview.start()` exits cleanly.
        """
        MANAGER.request_cancel()
        try:
            if self.window is not None:
                self.window.destroy()
        except Exception:
            pass
        return {"quit": True}
