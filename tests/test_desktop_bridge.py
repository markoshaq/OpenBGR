"""
Coverage for `DesktopApi` bridge methods not exercised by `test_api.py`:
native dialogs (open/save/folder), clipboard copy/read, fullscreen, external
links, window theme, quit, and the evaluate_js push for queued open files.

Run with:
    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import base64
import ctypes
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from PIL import Image, ImageGrab

import openbgr.desktop_bridge as bridge_mod


def _reset_module_state() -> None:
    """Clears module-level registries so tests never leak into each other."""
    with bridge_mod._PENDING_OPEN_LOCK:
        bridge_mod._PENDING_OPEN_FILES.clear()
    with bridge_mod._LOCAL_FILE_LOCK:
        bridge_mod._LOCAL_FILES.clear()
    with bridge_mod._OUTPUT_DIRS_LOCK:
        bridge_mod._OUTPUT_DIRS.clear()
    bridge_mod._OPEN_FILES_RECEIVED = 0
    bridge_mod.set_desktop_api(None)


class TestDesktopApi(unittest.TestCase):
    """`DesktopApi` method contracts under a fake (or absent) pywebview window."""

    def setUp(self) -> None:
        _reset_module_state()
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)

    def test_dialog_mode_resolves_enum_and_legacy_constant(self) -> None:
        """`_dialog_mode` prefers `FileDialog.<KIND>`, then falls back to `<KIND>_DIALOG`."""
        modern = MagicMock()
        modern.FileDialog.OPEN = "enum-open"
        self.assertEqual(bridge_mod.DesktopApi._dialog_mode(modern, "OPEN"), "enum-open")

        legacy = MagicMock(spec=[])  # no FileDialog attribute
        legacy.OPEN_DIALOG = "legacy-open"
        self.assertEqual(bridge_mod.DesktopApi._dialog_mode(legacy, "OPEN"), "legacy-open")

    def test_open_image_dialog_grants_picked_files(self) -> None:
        """Native Open dialog picks become one-shot file grants; cancel yields cancelled."""
        bridge = bridge_mod.DesktopApi()
        self.assertEqual(bridge.open_image_dialog(), {"cancelled": True})

        img = self.tmp / "pick.png"
        img.write_bytes(b"png-data")
        bridge.window = MagicMock()
        bridge.window.create_file_dialog.return_value = [str(img)]

        with patch.object(
            bridge_mod, "_recent_files_path", return_value=self.tmp / "recent_files.json"
        ):
            res = bridge.open_image_dialog()
        self.assertEqual(len(res["files"]), 1)
        self.assertEqual(res["files"][0]["name"], "pick.png")
        self.assertEqual(bridge_mod.pop_local_file(res["files"][0]["file_id"]), img)

        bridge.window.create_file_dialog.return_value = None
        self.assertEqual(bridge.open_image_dialog(), {"cancelled": True})

    def test_save_file_writes_bytes_to_dialog_target(self) -> None:
        """Save dialog writes decoded base64 to the chosen path; cancel propagates."""
        bridge = bridge_mod.DesktopApi()
        res = bridge.save_file("", "out.png")
        self.assertFalse(res["saved"])

        dest = self.tmp / "saved.png"
        bridge.window = MagicMock()
        bridge.window.create_file_dialog.return_value = str(dest)
        payload = base64.b64encode(b"image-bytes").decode("ascii")
        res = bridge.save_file(payload, "saved.png")
        self.assertEqual(res, {"saved": True, "path": str(dest)})
        self.assertEqual(dest.read_bytes(), b"image-bytes")

        bridge.window.create_file_dialog.return_value = None
        res = bridge.save_file(payload, "saved.png")
        self.assertFalse(res["saved"])
        self.assertTrue(res["cancelled"])

    def test_choose_output_dir_grants_picked_folder(self) -> None:
        """Folder picks grant the directory for `/api/save`; cancel yields cancelled."""
        bridge = bridge_mod.DesktopApi()
        self.assertEqual(bridge.choose_output_dir(), {"cancelled": True})

        bridge.window = MagicMock()
        bridge.window.create_file_dialog.return_value = str(self.tmp)
        res = bridge.choose_output_dir()
        self.assertFalse(res["cancelled"])
        self.assertEqual(res["path"], str(self.tmp))
        self.assertTrue(bridge_mod.is_output_dir_granted(self.tmp))

    def test_copy_image_decodes_and_delegates(self) -> None:
        """`copy_image` decodes base64 and hands bytes to the platform clipboard writer."""
        bridge = bridge_mod.DesktopApi()
        with patch.object(
            bridge_mod, "copy_png_bytes_to_clipboard", return_value={"copied": True}
        ) as mock_copy:
            payload = base64.b64encode(b"png-bytes").decode("ascii")
            self.assertEqual(bridge.copy_image(payload), {"copied": True})
            mock_copy.assert_called_once_with(b"png-bytes")

        res = bridge.copy_image("!!!not-base64!!!")
        self.assertFalse(res["copied"])
        self.assertIn("error", res)

    def test_read_clipboard_image_pil_image(self) -> None:
        """A PIL image on the clipboard is re-encoded as base64 PNG."""
        bridge = bridge_mod.DesktopApi()
        fake_clip = Image.new("RGBA", (4, 4), (0, 255, 0, 255))
        with patch.object(ImageGrab, "grabclipboard", return_value=fake_clip):
            res = bridge.read_clipboard_image()
        self.assertTrue(res["has_image"])
        self.assertEqual(res["name"], "CLIPBOARD.PNG")
        self.assertTrue(base64.b64decode(res["data_b64"]).startswith(b"\x89PNG"))

    def test_read_clipboard_image_file_path(self) -> None:
        """A copied image file (Finder/Explorer) is read straight from disk."""
        bridge = bridge_mod.DesktopApi()
        img = self.tmp / "finder.png"
        img.write_bytes(b"file-bytes")
        with (
            patch.object(bridge_mod.platform, "system", return_value="Windows"),
            patch.object(ImageGrab, "grabclipboard", return_value=[str(img)]),
        ):
            res = bridge.read_clipboard_image()
        self.assertTrue(res["has_image"])
        self.assertEqual(res["name"], "finder.png")
        self.assertEqual(base64.b64decode(res["data_b64"]), b"file-bytes")

    def test_read_clipboard_image_empty(self) -> None:
        """An empty clipboard with no Linux helpers reports has_image False."""
        bridge = bridge_mod.DesktopApi()
        with (
            patch.object(bridge_mod.platform, "system", return_value="Linux"),
            patch.object(ImageGrab, "grabclipboard", return_value=None),
            patch.object(bridge_mod.shutil, "which", return_value=None),
        ):
            self.assertEqual(bridge.read_clipboard_image(), {"has_image": False})

    def test_has_clipboard_image_windows_sequence_cache(self) -> None:
        """The Windows clipboard sequence number gates repeated PIL probes."""
        bridge = bridge_mod.DesktopApi()
        windll = MagicMock()
        windll.user32.GetClipboardSequenceNumber.return_value = 42

        fake_clip = Image.new("RGBA", (4, 4))
        with (
            patch.object(bridge_mod.platform, "system", return_value="Windows"),
            patch.object(ctypes, "windll", windll, create=True),
            patch.object(ImageGrab, "grabclipboard", return_value=fake_clip),
        ):
            self.assertEqual(bridge.has_clipboard_image(), {"has_image": True})
            # Same sequence: cached answer, PIL is never consulted.
            with patch.object(ImageGrab, "grabclipboard", side_effect=AssertionError("uncached")):
                self.assertEqual(bridge.has_clipboard_image(), {"has_image": True})

    def test_has_clipboard_image_linux_no_tools(self) -> None:
        """Linux without wl-paste/xclip reports has_image None (unknown)."""
        bridge = bridge_mod.DesktopApi()
        with (
            patch.object(bridge_mod.platform, "system", return_value="Linux"),
            patch.object(ImageGrab, "grabclipboard", return_value=None),
            patch.object(bridge_mod.shutil, "which", return_value=None),
        ):
            self.assertEqual(bridge.has_clipboard_image(), {"has_image": None})

    def test_toggle_fullscreen(self) -> None:
        """Fullscreen toggles only when a window exists."""
        bridge = bridge_mod.DesktopApi()
        self.assertEqual(bridge.toggle_fullscreen(), {"toggled": False})
        bridge.window = MagicMock()
        self.assertEqual(bridge.toggle_fullscreen(), {"toggled": True})
        bridge.window.toggle_fullscreen.assert_called_once_with()

    def test_open_external_accepts_only_http(self) -> None:
        """Only http(s) URLs reach the system browser."""
        bridge = bridge_mod.DesktopApi()
        with patch.object(bridge_mod.webbrowser, "open") as mock_open:
            self.assertEqual(bridge.open_external("https://example.com"), {"opened": True})
            mock_open.assert_called_once_with("https://example.com")
            self.assertEqual(bridge.open_external("file:///etc/passwd"), {"opened": False})
            self.assertEqual(bridge.open_external("javascript:alert(1)"), {"opened": False})
            mock_open.assert_called_once()

    def test_open_cache_and_logs_dirs(self) -> None:
        """Cache and logs folder actions delegate to the platform file-manager opener."""
        bridge = bridge_mod.DesktopApi()
        with patch.object(
            bridge_mod, "open_folder_in_file_manager", return_value=True
        ) as mock_open:
            res = bridge.open_cache_dir()
            self.assertTrue(res["opened"])
            self.assertIn("path", res)
            res = bridge.open_logs_dir()
            self.assertTrue(res["opened"])
            self.assertEqual(mock_open.call_count, 2)

    def test_set_window_theme_off_native_platforms(self) -> None:
        """Theme sync is a no-op on Linux and without a window on macOS."""
        bridge = bridge_mod.DesktopApi()
        with patch.object(bridge_mod.platform, "system", return_value="Linux"):
            self.assertEqual(bridge.set_window_theme("dark"), {"updated": False})
        with patch.object(bridge_mod.platform, "system", return_value="Darwin"):
            self.assertEqual(bridge.set_window_theme("light"), {"updated": False})

    def test_quit_cancels_jobs_and_destroys_window(self) -> None:
        """Quit cancels inference and destroys the native window."""
        bridge = bridge_mod.DesktopApi()
        bridge.window = MagicMock()
        with patch.object(bridge_mod.MANAGER, "request_cancel") as mock_cancel:
            self.assertEqual(bridge.quit(), {"quit": True})
            mock_cancel.assert_called_once_with()
        bridge.window.destroy.assert_called_once_with()

    def test_queue_open_files_pushes_evaluate_js(self) -> None:
        """OS-delivered files nudge the live window via evaluate_js pullPendingFiles."""
        bridge = bridge_mod.DesktopApi()
        bridge.window = MagicMock()
        bridge_mod.set_desktop_api(bridge)

        img = self.tmp / "opened.png"
        img.write_bytes(b"png")
        with patch.object(
            bridge_mod, "_recent_files_path", return_value=self.tmp / "recent_files.json"
        ):
            bridge_mod.queue_open_files([str(img)])

        # The push runs on a daemon thread; poll briefly for it.
        deadline = time.monotonic() + 5.0
        while not bridge.window.evaluate_js.called and time.monotonic() < deadline:
            time.sleep(0.05)
        bridge.window.evaluate_js.assert_called_once()
        self.assertIn("pullPendingFiles", bridge.window.evaluate_js.call_args[0][0])
        self.assertEqual(bridge_mod.get_open_files_received(), 1)
        self.assertEqual(bridge_mod.get_pending_open_files_count(), 1)


if __name__ == "__main__":
    unittest.main()
