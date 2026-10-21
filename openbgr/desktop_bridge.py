"""
JavaScript-to-Python bridge (`DesktopApi`) exposed as `window.pywebview.api`,
plus the pending open-files queue fed by OS 'open with' events.
"""

from __future__ import annotations

import base64
import io
import os
import platform
import secrets
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any

from huggingface_hub.constants import HF_HUB_CACHE
from PIL import Image

from .config import APP_CONFIG_DIR, logger, open_folder_in_file_manager
from .models import MANAGER
from .quick_action_native import copy_png_bytes_to_clipboard

# File types accepted from OS open-file events and clipboard path drops.
_IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"})

# Common image-data UTI types on the macOS pasteboard. Anything outside this
# set falls back to NSImage.canInitWithPasteboard_ for fringe formats.
_PASTEBOARD_IMAGE_UTIS = frozenset(
    {
        "public.png",
        "public.tiff",
        "public.jpeg",
        "public.webp",
        "public.heic",
        "public.heif",
        "com.compuserve.gif",
        "com.microsoft.bmp",
    }
)
_PASTEBOARD_FILE_TYPES = frozenset({"NSFilenamesPboardType", "public.file-url"})

# Image paths handed to the app by the OS (argv / macOS 'odoc' AppleEvent) that
# the frontend should ingest into tabs once the window is ready.
_PENDING_OPEN_LOCK = threading.Lock()
_PENDING_OPEN_FILES: list[str] = []
_DESKTOP_API: DesktopApi | None = None
_OPEN_FILES_RECEIVED = 0


def set_desktop_api(bridge: DesktopApi | None) -> None:
    """Registers the active `DesktopApi` bridge instance for OS-delivered file events."""
    global _DESKTOP_API
    _DESKTOP_API = bridge


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
        if Path(str(p)).is_file() and Path(str(p)).suffix.lower() in _IMAGE_EXTENSIONS
    ]
    if not file_list:
        return
    with _PENDING_OPEN_LOCK:
        _PENDING_OPEN_FILES.extend(file_list)
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


class DesktopApi:
    """
    JavaScript-to-Python bridge exposed as `window.pywebview.api` when running
    inside the native pywebview desktop window. Provides native OS file dialogs
    (Open / Save As), native OS clipboard image copy/paste, window fullscreen
    and theme synchronization, external browser links, and clean Quit.
    """

    # Safety cap for the base64 bridge payload used by clipboard image reads.
    # File picks use file_id grants streamed over HTTP, so they are uncapped.
    OPEN_DIALOG_MAX_BYTES = 48 * 1024 * 1024

    def __init__(self) -> None:
        """The pywebview window handle is attached after `create_window`."""
        self.window: Any = None
        # (sequence, has_image) of the last clipboard probe. Each OS exposes a
        # cheap change counter so per-focus probes can skip the expensive
        # content decode while the clipboard is unchanged.
        self._clip_seq: Any = None
        self._clip_has_image: bool | None = None

    def take_pending_files(self) -> dict[str, Any]:
        """Drains OS-delivered open-file requests (argv / macOS 'odoc') for ingestion."""
        return take_pending_files()

    @staticmethod
    def _macos_clipboard_paths() -> list[str]:
        """Returns file paths on the macOS pasteboard (Finder copies), or []."""
        try:
            import AppKit

            pb = AppKit.NSPasteboard.generalPasteboard()
            paths = [str(p) for p in (pb.propertyListForType_("NSFilenamesPboardType") or [])]
            if not paths:
                url_str = pb.stringForType_("public.file-url")
                if url_str:
                    from urllib.parse import unquote, urlparse

                    paths = [unquote(urlparse(url_str).path)]
            return paths
        except Exception:
            return []

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
            import webview

            dest = self.window.create_file_dialog(
                self._dialog_mode(webview, "SAVE"),
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
            return {"cancelled": False, "path": str(path)}
        except Exception as exc:
            return {"cancelled": True, "error": str(exc)}

    def copy_image(self, data_base64: str) -> dict[str, Any]:
        """
        Writes a base64-encoded 32-bit RGBA PNG directly to the native OS clipboard
        across macOS (NSPasteboard), Windows (.NET Clipboard), and Linux (wl-copy/xclip).
        """
        try:
            raw_bytes = base64.b64decode(data_base64)
            return copy_png_bytes_to_clipboard(raw_bytes)
        except Exception as exc:
            return {"copied": False, "error": str(exc)}

    def has_clipboard_image(self) -> dict[str, Any]:
        """
        Probes whether the native OS clipboard currently holds an image or an
        image file path, without triggering browser clipboard permission prompts.
        On macOS the pasteboard's change counter and UTI list answer in
        microseconds, while PIL's ImageGrab would spawn an osascript subprocess
        and decode the data on every call (this runs on every window focus);
        on Windows the clipboard sequence number gates the same PIL probe so
        an unchanged clipboard costs nothing.
        """
        sys_name = platform.system()

        if sys_name == "Darwin":
            try:
                import AppKit

                pb = AppKit.NSPasteboard.generalPasteboard()
                seq: Any = pb.changeCount()
                if seq == self._clip_seq:
                    return {"has_image": self._clip_has_image}
                types = set(pb.types() or [])
                if types & _PASTEBOARD_IMAGE_UTIS:
                    has_image: bool | None = True
                elif types & _PASTEBOARD_FILE_TYPES:
                    has_image = any(
                        Path(str(p)).is_file() and Path(str(p)).suffix.lower() in _IMAGE_EXTENSIONS
                        for p in self._macos_clipboard_paths()
                    )
                else:
                    # Fringe image UTIs (Photoshop, camera RAW, ...) that
                    # NSImage/PNGf translation can still serve.
                    has_image = bool(AppKit.NSImage.canInitWithPasteboard_(pb))
                self._clip_seq, self._clip_has_image = seq, has_image
                return {"has_image": has_image}
            except Exception:
                pass

        seq = None
        if sys_name == "Windows":
            try:
                import ctypes

                windll = getattr(ctypes, "windll", None)
                seq = windll.user32.GetClipboardSequenceNumber() if windll is not None else None
                if seq is not None and seq == self._clip_seq:
                    return {"has_image": self._clip_has_image}
            except Exception:
                seq = None

        try:
            from PIL import ImageGrab

            grabbed = ImageGrab.grabclipboard()
            if isinstance(grabbed, Image.Image):
                grabbed.close()
                has_result: bool | None = True
            elif isinstance(grabbed, (list, tuple)):
                has_result = any(
                    Path(str(item)).is_file()
                    and Path(str(item)).suffix.lower() in _IMAGE_EXTENSIONS
                    for item in grabbed
                )
            elif sys_name in ("Darwin", "Windows"):
                has_result = False
            else:
                has_result = None
            if has_result is not None:
                if seq is not None:
                    self._clip_seq, self._clip_has_image = seq, has_result
                return {"has_image": has_result}
        except Exception:
            pass

        if platform.system() == "Linux":
            for cmd in (
                ["wl-paste", "--list-types"],
                ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"],
            ):
                if shutil.which(cmd[0]):
                    try:
                        proc = subprocess.run(
                            cmd,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL,
                            text=True,
                            timeout=2,
                        )
                        if proc.returncode == 0 and proc.stdout:
                            return {"has_image": "image/png" in proc.stdout.lower()}
                    except Exception:
                        pass

        return {"has_image": None}

    def read_clipboard_image(self) -> dict[str, Any]:
        """
        Reads an image (or an image file copied in Finder / File Explorer) from
        the native OS clipboard and returns it as base64 PNG bytes.
        """
        try:
            from PIL import ImageGrab

            grabbed = ImageGrab.grabclipboard()
            if isinstance(grabbed, Image.Image):
                buf = io.BytesIO()
                try:
                    grabbed.save(buf, format="PNG")
                    return {
                        "has_image": True,
                        "name": "CLIPBOARD.PNG",
                        "data_b64": base64.b64encode(buf.getvalue()).decode("ascii"),
                    }
                finally:
                    buf.close()
                    grabbed.close()

            if isinstance(grabbed, (list, tuple)):
                for item in grabbed:
                    p = Path(str(item))
                    if p.is_file() and p.suffix.lower() in _IMAGE_EXTENSIONS:
                        data = p.read_bytes()
                        if len(data) <= self.OPEN_DIALOG_MAX_BYTES:
                            return {
                                "has_image": True,
                                "name": p.name,
                                "data_b64": base64.b64encode(data).decode("ascii"),
                            }
        except Exception:
            pass

        # PIL's macOS grabclipboard only yields PNG data; a file copied in
        # Finder shows up as NSFilenamesPboardType paths on the pasteboard.
        if platform.system() == "Darwin":
            for item in self._macos_clipboard_paths():
                p = Path(str(item))
                if p.is_file() and p.suffix.lower() in _IMAGE_EXTENSIONS:
                    data = p.read_bytes()
                    if len(data) <= self.OPEN_DIALOG_MAX_BYTES:
                        return {
                            "has_image": True,
                            "name": p.name,
                            "data_b64": base64.b64encode(data).decode("ascii"),
                        }

        # Linux fallback via wl-paste or xclip
        if platform.system() == "Linux":
            for cmd in (
                ["wl-paste", "--type", "image/png"],
                ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
            ):
                if shutil.which(cmd[0]):
                    try:
                        proc = subprocess.run(
                            cmd,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL,
                            timeout=3,
                        )
                        if proc.returncode == 0 and proc.stdout:
                            return {
                                "has_image": True,
                                "name": "CLIPBOARD.PNG",
                                "data_b64": base64.b64encode(proc.stdout).decode("ascii"),
                            }
                    except Exception:
                        pass

        return {"has_image": False}

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
