"""
Native window management: geometry persistence, off-screen recovery, and the
chromeless browser fallback used when pywebview is unavailable.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import webbrowser
from typing import Any

from .config import APP_CONFIG_DIR, WINDOW_STATE_PATH


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
