"""
Native OS menu bar construction for macOS and Linux (pywebview `Menu`/`MenuAction`).
"""

from __future__ import annotations

import platform
import webbrowser
from typing import Any

from .models import MANAGER


def build_native_menus(window: Any) -> list[Any]:
    """
    Builds the native OS menu bar for macOS and Linux.

    On macOS, `Menu("__app__", ...)` injects items directly into the primary
    "OpenBGR" application menu (between About and Services), while setting
    `webview.settings["SHOW_DEFAULT_MENUS"] = False` prevents pywebview from
    adding duplicate Edit and View menus.

    Note: MenuAction titles intentionally use Unicode ellipsis (`…`) instead of
    ASCII periods, because Linux GTK's `Gio.SimpleAction` detailed-action parser
    treats `.` and `(...)` as GVariant action parameters and disables items that
    contain them.
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
        MenuSeparator(),
        MenuAction("Restart OpenBGR", call("restartApp()")),
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
            MenuAction("Keyboard Shortcuts…", call("openSettings('shortcuts')")),
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
