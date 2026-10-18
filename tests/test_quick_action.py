"""
Quick Action tests: config sanitization, notification formatting, dialog
string escaping, cutout encoding, CLI/Quick Action execution, and the macOS
notifier bundle.

Run with:
    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import io
import plistlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

import openbgr.quick_action as qa_mod
import openbgr.quick_action_config as qa_config_mod
import openbgr.quick_action_native as qa_native_mod


class TestQuickAction(unittest.TestCase):
    """Covers the Quick Action config, native bridges, and headless runner."""

    def test_quick_action_notification_and_config(self) -> None:
        """Quick Action notifications, config sanitization, and multi-format encoding behave as specified."""
        msg_single = qa_native_mod.format_quick_action_notification(["image.png"], 0)
        self.assertEqual(msg_single, 'Background removed for "image.png"')
        self.assertNotIn("—", msg_single or "")

        msg_multi = qa_native_mod.format_quick_action_notification(["a.png", "b.png", "c.png"], 0)
        self.assertEqual(msg_multi, "Background removed for 3 images.")
        self.assertNotIn("—", msg_multi or "")

        clean = qa_config_mod.sanitize_quick_action_config(
            {
                "tier": "portrait",
                "save_mode": "ask",
                "format": "webp",
                "edge_refine": "false",
                "copy_clipboard": "true",
                "notify": "true",
            }
        )
        self.assertEqual(
            clean,
            {
                "tier": "portrait",
                "save_mode": "ask",
                "format": "webp",
                "edge_refine": False,
                "copy_clipboard": True,
                "notify": True,
            },
        )

        # Fallback on invalid values
        fallback = qa_config_mod.sanitize_quick_action_config(
            {"tier": "bogus", "save_mode": "somewhere", "format": "gif"}
        )
        self.assertEqual(fallback["tier"], "general")
        self.assertEqual(fallback["save_mode"], "same_folder")
        self.assertEqual(fallback["format"], "png")

        # Numeric booleans in a hand-edited config must not fall back
        numeric = qa_config_mod.sanitize_quick_action_config(
            {"edge_refine": 0, "copy_clipboard": 1, "notify": 0}
        )
        self.assertFalse(numeric["edge_refine"])
        self.assertTrue(numeric["copy_clipboard"])
        self.assertFalse(numeric["notify"])

    def test_output_path_and_dialog_escaping(self) -> None:
        """Output paths gain the correct extension, and dialog strings are shell-safe."""
        self.assertEqual(
            qa_mod._with_output_suffix(Path("/tmp/out"), "png"),
            Path("/tmp/out.png"),
        )
        self.assertEqual(
            qa_mod._with_output_suffix(Path("/tmp/out.webp"), "png"),
            Path("/tmp/out.webp"),
        )
        self.assertEqual(qa_native_mod._osascript_quote('a"b\\c'), 'a\\"b\\\\c')
        self.assertEqual(qa_native_mod._powershell_quote("it's"), "it''s")

        # Verify all 4 Quick Action export formats encode cleanly
        rgba = Image.new("RGBA", (16, 16), (200, 50, 50, 128))
        try:
            for fmt, expected_mode in (
                ("png", "RGBA"),
                ("webp", "RGBA"),
                ("jpg", "RGB"),
                ("mask", "L"),
            ):
                raw = qa_mod.encode_cutout_image(rgba, fmt=fmt)
                with Image.open(io.BytesIO(raw)) as decoded:
                    self.assertEqual(decoded.mode, expected_mode)
                    self.assertEqual(decoded.size, (16, 16))
        finally:
            rgba.close()

    def test_cli_and_quick_action_execution(self) -> None:
        """`run_cli` and `run_quick_action` write cutouts to disk when given a mocked pipeline."""
        fake_rgba = Image.new("RGBA", (20, 20), (255, 100, 50, 255))

        def _fake_segment(img, *args, **kwargs):
            return fake_rgba.copy(), 12.5, {"label": "General", "sublabel": "1K"}, 99

        with tempfile.TemporaryDirectory() as tmp:
            src_path = Path(tmp) / "photo.png"
            Image.new("RGB", (20, 20), (10, 20, 30)).save(src_path, format="PNG")
            cfg_path = Path(tmp) / "quick_action.json"

            with (
                patch.object(qa_mod, "segment_foreground", side_effect=_fake_segment),
                patch.object(qa_config_mod, "QUICK_ACTION_CONFIG_PATH", cfg_path),
                patch.object(qa_mod, "send_openbgr_notification"),
            ):
                rc = qa_mod.run_cli(
                    [str(src_path)],
                    output=None,
                    tier="general",
                    defringe=True,
                    despill=True,
                    matting=False,
                    fmt="png",
                )
                self.assertEqual(rc, 0)
                cutout_1 = Path(tmp) / "photo-cutout.png"
                self.assertTrue(cutout_1.is_file())

                qa_config_mod.save_quick_action_config(
                    {
                        "tier": "general",
                        "save_mode": "same_folder",
                        "format": "webp",
                        "notify": False,
                    }
                )
                qa_res = qa_mod.run_quick_action([str(src_path)])
                self.assertTrue(qa_res["ok"])
                self.assertEqual(qa_res["succeeded"], ["photo.png"])
                self.assertEqual(len(qa_res["outputs"]), 1)
                self.assertTrue(Path(qa_res["outputs"][0]).is_file())

        fake_rgba.close()

    def test_macos_notifier_strips_asset_catalog_icon(self) -> None:
        """`ensure_macos_notifier_app` removes `CFBundleIconName` and `Assets.car` so `.icns` wins."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            notifier_app = tmp_dir / "OpenBGRNotifier.app"
            notifier_icns = tmp_dir / "OpenBGR.icns"
            notifier_icns.write_bytes(b"fake-icns-bytes")

            def _fake_run(cmd: list[str], **_kwargs: object) -> object:
                if cmd and cmd[0] == "osacompile":
                    macos_dir = notifier_app / "Contents" / "MacOS"
                    res_dir = notifier_app / "Contents" / "Resources"
                    macos_dir.mkdir(parents=True, exist_ok=True)
                    res_dir.mkdir(parents=True, exist_ok=True)
                    (macos_dir / "droplet").write_bytes(b"droplet-bin")
                    (res_dir / "Assets.car").write_bytes(b"script-editor-scroll")
                    with open(notifier_app / "Contents" / "Info.plist", "wb") as fh:
                        plistlib.dump(
                            {
                                "CFBundleIconFile": "applet",
                                "CFBundleIconName": "applet",
                            },
                            fh,
                        )
                return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()

            with (
                patch.object(qa_native_mod.platform, "system", return_value="Darwin"),
                patch.object(qa_native_mod, "APP_CONFIG_DIR", tmp_dir),
                patch.object(qa_native_mod, "NOTIFIER_APP_PATH", notifier_app),
                patch.object(qa_native_mod, "NOTIFIER_ICNS_PATH", notifier_icns),
                patch.object(qa_native_mod.subprocess, "run", side_effect=_fake_run),
            ):
                built = qa_native_mod.ensure_macos_notifier_app()
                self.assertEqual(built, notifier_app)
                self.assertFalse((notifier_app / "Contents" / "Resources" / "Assets.car").exists())
                self.assertTrue((notifier_app / "Contents" / "Resources" / "applet.icns").is_file())
                with open(notifier_app / "Contents" / "Info.plist", "rb") as fh:
                    plist = plistlib.load(fh)
                self.assertNotIn("CFBundleIconName", plist)
                self.assertEqual(plist["CFBundleIconFile"], "applet")
                self.assertTrue(plist["LSUIElement"])


if __name__ == "__main__":
    unittest.main()
