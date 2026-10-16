"""
Native pywebview desktop bridge (`DesktopApi`), window geometry persistence,
macOS Cocoa NSMenu/NSWindow/AppleEvent customization, and chromeless browser fallback.
"""

from __future__ import annotations

import base64
import io
import json
import os
import platform
import shutil
import socket
import subprocess
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any

from huggingface_hub.constants import HF_HUB_CACHE
from PIL import Image

from .config import (
    APP_CONFIG_DIR,
    APP_VERSION,
    WINDOW_STATE_PATH,
    logger,
    open_folder_in_file_manager,
)
from .models import MANAGER
from .quick_action import copy_png_bytes_to_clipboard

# File types accepted from OS open-file events and clipboard path drops.
_IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"})

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
        # evaluate_js blocks on a semaphore until JS runs — calling it directly
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

    # Safety cap for the base64 bridge payload when reading picked images (~64 MP photos are fine).
    OPEN_DIALOG_MAX_BYTES = 48 * 1024 * 1024

    def __init__(self) -> None:
        """The pywebview window handle is attached after `create_window`."""
        self.window: Any = None

    def _payload_for_paths(self, paths: list[Path]) -> dict[str, Any]:
        """Reads image files from disk into the {name, data_b64} dialog payload shape."""
        files_out: list[dict[str, str]] = []
        for file_path in paths:
            if not file_path.is_file():
                continue
            try:
                data = file_path.read_bytes()
            except OSError:
                continue
            if len(data) > self.OPEN_DIALOG_MAX_BYTES:
                return {
                    "cancelled": True,
                    "error": f"'{file_path.name}' exceeds the 48 MB native-dialog limit.",
                }
            files_out.append(
                {
                    "name": file_path.name,
                    "data_b64": base64.b64encode(data).decode("ascii"),
                }
            )
        if not files_out:
            return {"files": []}
        return {"files": files_out}

    def take_pending_files(self) -> dict[str, Any]:
        """Drains OS-delivered open-file requests (argv / macOS 'odoc') for ingestion."""
        with _PENDING_OPEN_LOCK:
            paths = list(dict.fromkeys(_PENDING_OPEN_FILES))
            _PENDING_OPEN_FILES.clear()
        if not paths:
            return {"files": []}
        payload = self._payload_for_paths([Path(p) for p in paths])
        if not payload.get("files") and "error" not in payload:
            return {"files": []}
        return payload

    @staticmethod
    def _dialog_mode(webview_mod: Any, kind: str) -> Any:
        """Resolves the open/save dialog constant across pywebview API versions."""
        file_dialog = getattr(webview_mod, "FileDialog", None)
        if file_dialog is not None and hasattr(file_dialog, kind):
            return getattr(file_dialog, kind)
        return getattr(webview_mod, f"{kind}_DIALOG")

    def open_image_dialog(self) -> dict[str, Any]:
        """Opens the native Open File dialog and returns selected images as base64."""
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
            payload = self._payload_for_paths([Path(p_str) for p_str in paths])
            if not payload.get("files") and "error" not in payload:
                return {"cancelled": True}
            return payload
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
        if platform.system() == "Darwin" and self.window is not None:
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


# ---------------------------------------------------------------------------
# Native Window State Persistence & Menu Bar
# ---------------------------------------------------------------------------


def load_window_state() -> dict[str, int]:
    """Returns the last saved native window geometry (x, y, width, height)."""
    try:
        data = json.loads(WINDOW_STATE_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return {
                k: int(data[k])
                for k in ("x", "y", "width", "height")
                if isinstance(data.get(k), (int, float))
            }
    except Exception:
        pass
    return {}


def attach_window_state_persistence(window: Any) -> None:
    """
    Saves the window's position and size to `~/.openbgr/window.json` whenever it
    is moved or resized (debounced), so the app restores its frame on next launch.
    """
    debounce_timer: list[threading.Timer | None] = [None]

    def _persist() -> None:
        """Writes the current window frame to disk, ignoring IO failures."""
        try:
            APP_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            WINDOW_STATE_PATH.write_text(
                json.dumps(
                    {
                        "x": int(window.x),
                        "y": int(window.y),
                        "width": int(window.width),
                        "height": int(window.height),
                    }
                ),
                encoding="utf-8",
            )
        except Exception:
            pass

    def _schedule() -> None:
        """Debounces move/resize events so rapid drags collapse into one write."""
        if debounce_timer[0] is not None:
            debounce_timer[0].cancel()
        timer = threading.Timer(0.4, _persist)
        timer.daemon = True
        timer.start()
        debounce_timer[0] = timer

    try:
        window.events.resized += lambda *a, **k: _schedule()
        window.events.moved += lambda *a, **k: _schedule()
    except Exception:
        pass


def ensure_window_on_screen(window: Any) -> None:
    """
    Moves the window back to the primary screen if its restored geometry lands
    fully outside every connected display (e.g. a monitor was unplugged after
    the position was saved).
    """

    def _clamp() -> None:
        """Re-centers the window on the primary screen when fully off-screen."""
        try:
            import webview

            wx, wy = int(window.x), int(window.y)
            ww, wh = int(window.width), int(window.height)
            screens = getattr(webview, "screens", [])
            on_screen = any(
                wx < s.x + s.width and wx + ww > s.x and wy < s.y + s.height and wy + wh > s.y
                for s in screens
            )
            if not on_screen and screens:
                primary = screens[0]
                window.move(
                    primary.x + max(0, (primary.width - ww) // 2),
                    primary.y + max(0, (primary.height - wh) // 2),
                )
        except Exception:
            pass

    try:
        window.events.shown += lambda *a, **k: _clamp()
    except Exception:
        pass


def set_macos_app_name(name: str) -> None:
    """
    Renames the macOS menu-bar application name from "Python" to `name` and
    updates the bundle metadata before NSApplication finishes launching.
    """
    if platform.system() != "Darwin":
        return
    try:
        import Foundation  # type: ignore

        Foundation.NSProcessInfo.processInfo().setProcessName_(name)
        bundle = Foundation.NSBundle.mainBundle()
        for info_dict in (
            bundle.infoDictionary(),
            bundle.localizedInfoDictionary(),
        ):
            if info_dict is not None:
                info_dict["CFBundleName"] = name
                info_dict["CFBundleDisplayName"] = name
                info_dict["CFBundleShortVersionString"] = APP_VERSION
                info_dict["CFBundleVersion"] = APP_VERSION
                info_dict["CFBundleGetInfoString"] = f"{name} {APP_VERSION}"
                info_dict["NSHumanReadableCopyright"] = (
                    f"{name} — Local AI Background Removal Studio"
                )
    except Exception:
        pass


def build_native_menus(window: Any) -> list[Any]:
    """
    Builds the native OS menu bar for macOS and Linux.

    On macOS, `Menu("__app__", ...)` injects items directly into the primary
    "OpenBGR" application menu (between About and Services), while setting
    `webview.settings["SHOW_DEFAULT_MENUS"] = False` prevents pywebview from
    adding duplicate Edit and View menus.

    Note: MenuAction titles intentionally use Unicode ellipsis (`…`) and em-dashes
    (`—`) instead of ASCII periods (`.`) or parentheses (`()`), because Linux GTK's
    `Gio.SimpleAction` detailed-action parser treats `.` and `(...)` as GVariant
    action parameters and disables items that contain them.
    """
    from webview.menu import Menu, MenuAction, MenuSeparator

    def call(fn: str):
        """Wraps a `window.openBGR.*` JS invocation in a native-menu-safe closure."""

        def _run() -> None:
            """Menu-action thunk: evaluates the JS handler, ignoring bridge failures."""
            try:
                window.evaluate_js(f"window.openBGR && window.openBGR.{fn}")
            except Exception:
                pass

        return _run

    def toggle_fs() -> None:
        """Toggles the native window between windowed and full-screen mode."""
        try:
            window.toggle_fullscreen()
        except Exception:
            pass

    def quit_app() -> None:
        """Cancels any in-flight job before tearing the window down."""
        MANAGER.request_cancel()
        try:
            window.destroy()
        except Exception:
            pass

    app_menu = Menu(
        "__app__",
        [
            MenuAction("Preferences…", call("openSettings('preferences')")),
        ],
    )

    file_items: list[Any] = [
        MenuAction("New Tab", call("newTab()")),
        MenuAction("Open Image…", call("openImage()")),
        MenuAction("Batch Process Images…", call("startBatch()")),
        MenuSeparator(),
        MenuAction("Export Image…", call("exportImage()")),
        MenuSeparator(),
        MenuAction("Close Tab", call("closeActiveTab()")),
    ]
    if platform.system() != "Darwin":
        file_items.extend(
            [
                MenuSeparator(),
                MenuAction("Preferences…", call("openSettings('preferences')")),
                MenuSeparator(),
                MenuAction("Quit OpenBGR", quit_app),
            ]
        )
    file_menu = Menu("File", file_items)

    edit_menu = Menu(
        "Edit",
        [
            MenuAction("Copy Cutout", call("copyImage()")),
            MenuAction("Paste Image", call("pasteImage()")),
            MenuSeparator(),
            MenuAction("Cancel Processing", call("cancelProcessing()")),
        ],
    )

    view_menu = Menu(
        "View",
        [
            MenuAction("Split Comparison", call("setView('split')")),
            MenuAction("Cutout Only", call("setView('cutout')")),
            MenuAction("Original Only", call("setView('original')")),
            MenuSeparator(),
            MenuAction("Zoom In", call("zoomIn()")),
            MenuAction("Zoom Out", call("zoomOut()")),
            MenuAction("Actual Size", call("zoomReset()")),
            MenuSeparator(),
            MenuAction("Toggle 4x Loupe", call("toggleLoupe()")),
            MenuSeparator(),
            MenuAction("Light Mode", call("toggleTheme()")),
            MenuAction("Toggle Full Screen", toggle_fs),
        ],
    )

    model_menu = Menu(
        "Model",
        [
            MenuAction("Lite - 1K Fast", call("selectPreset('lite')")),
            MenuAction("General - 1K Studio", call("selectPreset('general')")),
            MenuAction("Ultra HR - 2K Detail", call("selectPreset('hr')")),
            MenuAction("Portrait - 1K People", call("selectPreset('portrait')")),
            MenuAction("Matting - 2K Soft Alpha", call("selectPreset('matting')")),
            MenuAction("Dynamic - Native Ratio", call("selectPreset('dynamic')")),
            MenuSeparator(),
            MenuAction("Defringe Edges", call("toggleDefringe()")),
            MenuAction("Suppress Color Spill", call("toggleDespill()")),
            MenuSeparator(),
            MenuAction("Re-Run Segmentation", call("rerunSegmentation()")),
            MenuSeparator(),
            MenuAction("Manage Model Storage…", call("openSettings('models')")),
        ],
    )

    help_menu = Menu(
        "Help",
        [
            MenuAction("Preferences…", call("openSettings('preferences')")),
            MenuAction("About OpenBGR…", call("openSettings('about')")),
            MenuSeparator(),
            MenuAction(
                "OpenBGR on GitHub",
                lambda: webbrowser.open("https://github.com/markoshaq/OpenBGR"),
            ),
        ],
    )

    return [app_menu, file_menu, edit_menu, view_menu, model_menu, help_menu]


def configure_macos_native_window_and_menus(window: Any) -> None:
    """
    Enhances the macOS Cocoa NSMenu and NSWindow once the window is shown:
    1. Attaches native Cocoa keyboard shortcuts (`keyEquivalent`) to menu items
      so macOS displays `⌘O`, `⌘E`, `⌘W`, `⌘,`, `⌘1`/`⌘2`/`⌘3`, `⌘+`/`⌘-`/`⌘0`,
       and `⌃⌘F` in the menu bar — and intercepts `⌘W` to close the active tab
       instead of closing the entire window.
    2. Wires the top "About OpenBGR" item in the macOS application menu to open
       the in-app About / System Info dialog.
    3. Sets the NSWindow appearance to DarkAqua by default.
    """
    if platform.system() != "Darwin":
        return

    def _enhance() -> None:
        """Deferred post-show enhancement; imports Cocoa lazily and fails soft."""
        try:
            import AppKit  # type: ignore
            import webview.platforms.cocoa as cocoa_mod  # type: ignore
            from PyObjCTools import AppHelper  # type: ignore

            def _on_main() -> None:
                """Applies dark appearance, gesture config, and menu shortcuts on the main run loop."""
                try:
                    ns_win = getattr(window, "native", None)
                    if ns_win is not None:
                        dark = AppKit.NSAppearance.appearanceNamed_(AppKit.NSAppearanceNameDarkAqua)
                        if dark is not None:
                            ns_win.setAppearance_(dark)

                        # Keep trackpad pinch available to JS GestureEvents by
                        # disabling WKWebView's page-level magnification.
                        def _find_wkwebview(view: Any) -> Any:
                            """Depth-first search for the WKWebView inside the window's view tree."""
                            if view is None:
                                return None
                            try:
                                if str(view.className()) == "WKWebView":
                                    return view
                                for sub in view.subviews():
                                    found = _find_wkwebview(sub)
                                    if found is not None:
                                        return found
                            except Exception:
                                return None
                            return None

                        wk_view = _find_wkwebview(ns_win.contentView())
                        if wk_view is not None:
                            try:
                                wk_view.setAllowsMagnification_(False)
                                wk_view.setMagnification_(1.0)
                            except Exception:
                                pass

                    main_menu = AppKit.NSApplication.sharedApplication().mainMenu()
                    if main_menu is None:
                        return

                    cmd_mask = AppKit.NSEventModifierFlagCommand
                    shift_cmd = cmd_mask | AppKit.NSEventModifierFlagShift
                    ctrl_cmd = cmd_mask | AppKit.NSEventModifierFlagControl

                    shortcuts: dict[str, tuple[str, int]] = {
                        "Preferences…": (",", cmd_mask),
                        "New Tab": ("t", cmd_mask),
                        "Open Image…": ("o", cmd_mask),
                        "Batch Process Images…": ("b", cmd_mask),
                        "Export Image…": ("e", cmd_mask),
                        "Close Tab": ("w", cmd_mask),
                        "Copy Cutout": ("c", shift_cmd),
                        "Paste Image": ("v", cmd_mask),
                        "Split Comparison": ("1", cmd_mask),
                        "Cutout Only": ("2", cmd_mask),
                        "Original Only": ("3", cmd_mask),
                        "Zoom In": ("+", cmd_mask),
                        "Zoom Out": ("-", cmd_mask),
                        "Actual Size": ("0", cmd_mask),
                        "Re-Run Segmentation": ("r", cmd_mask),
                        "Toggle Full Screen": ("f", ctrl_cmd),
                    }

                    # Wire "About OpenBGR" in the app menu (index 0) to our in-app About modal
                    app_menu_item = main_menu.itemAtIndex_(0)
                    if app_menu_item and app_menu_item.submenu():
                        app_sub = app_menu_item.submenu()
                        if app_sub.numberOfItems() > 0:
                            about_item = app_sub.itemAtIndex_(0)
                            about_id = "openbgr.about"
                            cocoa_mod.menu_handler.register_action(
                                about_id,
                                lambda: window.evaluate_js(
                                    "window.openBGR && window.openBGR.openSettings('about')"
                                ),
                            )
                            about_item.setTitle_("About OpenBGR")
                            about_item.setAction_("handleMenuAction:")
                            about_item.setTarget_(cocoa_mod.menu_handler)
                            about_item.setRepresentedObject_(about_id)

                    for i in range(main_menu.numberOfItems()):
                        top_item = main_menu.itemAtIndex_(i)
                        sub = top_item.submenu() if top_item else None
                        if sub is None:
                            continue
                        for j in range(sub.numberOfItems()):
                            mi = sub.itemAtIndex_(j)
                            if mi is None:
                                continue
                            title = str(mi.title() or "")
                            if title in shortcuts:
                                key_eq, mask = shortcuts[title]
                                mi.setKeyEquivalent_(key_eq)
                                mi.setKeyEquivalentModifierMask_(mask)
                except Exception:
                    pass

            AppHelper.callAfter(_on_main)
        except Exception:
            pass

    try:
        window.events.shown += lambda *a, **k: _enhance()
    except Exception:
        pass


def install_macos_open_documents_handler() -> None:
    """
    Registers a Cocoa AppleEvent handler so `open -a OpenBGR file.png`, Finder's
    "Open With", and drops onto the Dock icon deliver image paths to the app.
    macOS routes these through the 'odoc' AppleEvent rather than argv.
    """
    if platform.system() != "Darwin":
        return
    try:
        import Foundation  # type: ignore

        kae_open_docs = int.from_bytes(b"odoc", "big")
        kae_core_class = int.from_bytes(b"aevt", "big")
        key_direct_object = int.from_bytes(b"----", "big")
        type_file_url = int.from_bytes(b"furl", "big")

        def _desc_to_path(desc: Any) -> str | None:
            """Extracts a filesystem path from an odoc descriptor (alias/furl/URL)."""
            if desc is None:
                return None
            candidates = [desc]
            if desc.descriptorType() != type_file_url:
                try:
                    coerced = desc.coerceToDescriptorType_(type_file_url)
                    if coerced is not None:
                        candidates.insert(0, coerced)
                except Exception:
                    pass
            for cand in candidates:
                try:
                    url = cand.fileURLValue()
                    if url is not None and url.path():
                        return str(url.path())
                except Exception:
                    pass
                try:
                    url = Foundation.NSURL.URLWithString_(cand.stringValue())
                    if url is not None and url.path():
                        return str(url.path())
                except Exception:
                    pass
            return None

        class _OpenDocsHandler(Foundation.NSObject):  # type: ignore
            def handleOpenDocuments_withReplyEvent_(self, event, reply):
                paths: list[str] = []
                logger.info("[Desktop] odoc AppleEvent received")
                try:
                    direct = event.paramDescriptorForKeyword_(key_direct_object)
                    count = int(direct.numberOfItems()) if direct is not None else 0
                    for i in range(1, count + 1):
                        p = _desc_to_path(direct.descriptorAtIndex_(i))
                        if p:
                            paths.append(p)
                except Exception as exc:
                    logger.warning("[Desktop] odoc parse failed (%s)", exc)
                if paths:
                    logger.info("[Desktop] odoc paths: %s", paths)
                    queue_open_files(paths)

        mgr = Foundation.NSAppleEventManager.sharedAppleEventManager()
        retained: list[Any] = []
        install_macos_open_documents_handler._retained = retained  # type: ignore[attr-defined]

        def _register() -> None:
            handler = _OpenDocsHandler.alloc().init()
            mgr.setEventHandler_andSelector_forEventClass_andEventID_(
                handler,
                b"handleOpenDocuments:withReplyEvent:",
                kae_core_class,
                kae_open_docs,
            )
            retained.append(handler)

        _register()

        # AppKit installs its own 'odoc' handler while NSApplication finishes
        # launching (it forwards to the app delegate, which pywebview does not
        # implement for openFiles:) — re-register ours once that happens so the
        # event dispatches to us, both at launch and for "Open With" while running.
        class _LaunchObserver(Foundation.NSObject):  # type: ignore
            def didFinishLaunching_(self, _notif):
                _register()

        observer = _LaunchObserver.alloc().init()
        retained.append(observer)
        Foundation.NSNotificationCenter.defaultCenter().addObserver_selector_name_object_(
            observer,
            b"didFinishLaunching:",
            "NSApplicationDidFinishLaunchingNotification",
            None,
        )
        logger.info("[Desktop] Open-Documents handler installed.")
    except Exception as exc:
        logger.warning("[Desktop] Open-Documents handler unavailable (%s).", exc)


def install_macos_open_files_delegate() -> None:
    """
    Subclasses pywebview's Cocoa `AppDelegate` before `webview.create_window`
    instantiates it, adding `application:openFiles:` / `openFile:` / `openURLs:`.
    AppKit forwards 'odoc' AppleEvents (Finder "Open With", Dock drops,
    `open -a App file`) to these delegate methods — including the launch-time
    event that the AppleEvent-manager path alone can miss.
    """
    if platform.system() != "Darwin":
        return
    try:
        import webview.platforms.cocoa as cocoa_mod  # type: ignore

        base_delegate = cocoa_mod.BrowserView.AppDelegate

        class _OpenFilesDelegate(base_delegate):  # type: ignore
            def application_openFiles_(self, _app, filenames):
                queue_open_files([str(f) for f in filenames])

            def application_openFile_(self, _app, filename):
                queue_open_files([str(filename)])
                return True

            def application_openURLs_(self, _app, urls):
                paths = [str(u.path()) for u in urls if getattr(u, "path", None)]
                if paths:
                    queue_open_files(paths)

        cocoa_mod.BrowserView.AppDelegate = _OpenFilesDelegate  # type: ignore[misc]
        logger.info("[Desktop] Open-Files delegate installed.")
    except Exception as exc:
        logger.warning("[Desktop] Open-Files delegate unavailable (%s).", exc)


def wait_for_server(host: str, port: int, timeout_s: float = 15.0) -> bool:
    """Polls until the local Uvicorn TCP socket is accepting connections."""
    deadline = time.perf_counter() + timeout_s
    while time.perf_counter() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.25):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def is_openbgr_server(url: str) -> bool:
    """
    Verifies that whatever is listening on the port is actually OpenBGR's API —
    guards against opening a foreign service when the port is already in use.
    """
    try:
        import urllib.request

        with urllib.request.urlopen(f"{url}/api/status", timeout=2) as res:
            payload = json.loads(res.read().decode("utf-8"))
            return isinstance(payload, dict) and "tiers" in payload
    except Exception:
        return False


def open_fallback_app_window(url: str) -> None:
    """
    Fallback if pywebview is unavailable (e.g. Linux without GTK WebKit).
    Attempts to open a chromeless standalone `--app` window via Chrome, Edge,
    or Brave before falling back to the default system web browser.
    """
    candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "google-chrome",
        "chromium",
        "chromium-browser",
        "brave-browser",
        "microsoft-edge",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    ]
    for binary in candidates:
        resolved = binary if os.path.exists(binary) else shutil.which(binary)
        if resolved:
            try:
                subprocess.Popen(
                    [resolved, f"--app={url}", "--window-size=1380,860"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                return
            except Exception:
                continue
    webbrowser.open(url)
