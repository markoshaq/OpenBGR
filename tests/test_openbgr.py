"""
Automated test suite for OpenBGR backend endpoints, image refinement pipeline,
FP16 cache compaction, icon rendering, and frontend ES module / DOM integrity.

Run with:
    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import io
import re
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import numpy as np
import torch
from fastapi import HTTPException, UploadFile
from PIL import Image

import app as openbgr_app
import icon_render
from scripts import build_release

ROOT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT_DIR / "static"


class TestOpenBGR(unittest.TestCase):
    """End-to-end contract tests for the OpenBGR server, pipeline, and frontend modules."""

    def test_version_and_status_contract(self) -> None:
        """`/api/status` exposes version, disk/RAM fields, and all six model tiers."""
        status = openbgr_app.api_status()
        self.assertEqual(status["version"], "0.02")
        self.assertIn("total_cache_bytes", status)
        self.assertIn("app_size_bytes", status)
        self.assertIn("total_disk_bytes", status)
        self.assertGreater(status["app_size_bytes"], 0)
        self.assertEqual(
            status["total_disk_bytes"],
            status["total_cache_bytes"] + status["app_size_bytes"],
        )
        self.assertIn("ram_gb", status)
        self.assertIn("ram_label", status)
        self.assertGreater(status["ram_gb"], 0)
        self.assertIn("cache_dir", status)
        for key in ("lite", "general", "hr", "portrait", "matting", "dynamic"):
            self.assertIn(key, status["tiers"])
            tier = status["tiers"][key]
            self.assertIn("cached", tier)
            self.assertIn("active", tier)
            self.assertIn("size_bytes", tier)
            self.assertIsInstance(tier["size_bytes"], int)
        # Legacy aliases resolve to canonical model keys
        self.assertEqual(openbgr_app.normalize_tier_key("low"), "lite")
        self.assertEqual(openbgr_app.normalize_tier_key("mid"), "general")
        self.assertEqual(openbgr_app.normalize_tier_key("high"), "hr")
        # Dynamic sizing preserves aspect ratio and rounds to multiples of 32
        dyn_h, dyn_w = openbgr_app.compute_dynamic_size(1920, 1080, 2048)
        self.assertEqual(dyn_w % 32, 0)
        self.assertEqual(dyn_h % 32, 0)
        self.assertGreater(dyn_w, dyn_h)

    def test_icon_squircle_geometry(self) -> None:
        """The rendered icon is RGBA with a transparent corner and opaque squircle center."""
        img = icon_render.render_icon(256)
        self.assertEqual(img.mode, "RGBA")
        self.assertEqual(img.size, (256, 256))
        # Outer corner pixel must be transparent outside the squircle mask; center must be opaque.
        self.assertEqual(img.getpixel((2, 2))[3], 0)
        self.assertEqual(img.getpixel((128, 128))[3], 255)

    def test_edge_refinement_pipeline(self) -> None:
        """Defringe, despill, and `compose_rgba` produce well-formed 32-bit RGBA output."""
        rgb = Image.fromarray(np.full((32, 32, 3), (40, 200, 60), dtype=np.uint8))
        alpha = np.zeros((32, 32), dtype=np.uint8)
        alpha[8:24, 8:24] = 255
        alpha[7, 8:24] = 128

        defringed = openbgr_app.decontaminate_edge_colors(
            np.array(rgb, dtype=np.uint8), alpha
        )
        self.assertEqual(defringed.shape, (32, 32, 3))
        self.assertEqual(defringed.dtype, np.uint8)

        mask_pil = Image.fromarray(alpha)
        despilled = openbgr_app.suppress_color_spill(
            defringed, mask_pil, alpha.astype(np.float32) / 255.0
        )
        self.assertEqual(despilled.shape, (32, 32, 3))
        self.assertEqual(despilled.dtype, np.uint8)

        # compose_rgba produces a full 32-bit RGBA cutout with and without filters
        composed = openbgr_app.compose_rgba(
            np.array(rgb, dtype=np.uint8), alpha, defringe=True, despill=True
        )
        self.assertEqual(composed.mode, "RGBA")
        self.assertEqual(composed.size, (32, 32))
        self.assertEqual(composed.getpixel((0, 0))[3], 0)
        self.assertEqual(composed.getpixel((16, 16))[3], 255)
        composed.close()

    def test_api_refine_endpoint(self) -> None:
        """`/api/refine` re-composes a cached job and rejects stale job ids with HTTP 409."""
        rgb = np.full((24, 24, 3), (30, 180, 90), dtype=np.uint8)
        alpha = np.zeros((24, 24), dtype=np.uint8)
        alpha[6:18, 6:18] = 255
        alpha[5, 6:18] = 140

        with openbgr_app._LAST_JOB_LOCK:
            openbgr_app._LAST_JOB.clear()
            openbgr_app._LAST_JOB.update({"id": 42, "rgb": rgb, "alpha": alpha})

        res = asyncio.run(
            openbgr_app.api_refine(job_id=42, defringe=True, despill=True)
        )
        self.assertEqual(res.media_type, "image/png")
        self.assertEqual(res.headers["X-Refine-Job-Id"], "42")
        out = Image.open(io.BytesIO(res.body))
        self.assertEqual(out.mode, "RGBA")
        self.assertEqual(out.size, (24, 24))
        out.close()

        # Stale job ids are rejected so an older tab can't refine a newer job
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                openbgr_app.api_refine(job_id=41, defringe=True, despill=True)
            )
        self.assertEqual(ctx.exception.status_code, 409)

    def test_api_save_sanitizes_and_renames_collisions(self) -> None:
        """`/api/save` strips path traversal and de-duplicates colliding filenames."""
        with tempfile.TemporaryDirectory() as tmp:
            up1 = UploadFile(filename="cutout.png", file=io.BytesIO(b"png-bytes-1"))
            res1 = asyncio.run(
                openbgr_app.api_save(
                    directory=tmp, filename="../../evil/cutout.png", file=up1
                )
            )
            self.assertTrue(res1["ok"])
            self.assertEqual(res1["name"], "cutout.png")
            self.assertEqual((Path(tmp) / "cutout.png").read_bytes(), b"png-bytes-1")

            up2 = UploadFile(filename="cutout.png", file=io.BytesIO(b"png-bytes-2"))
            res2 = asyncio.run(
                openbgr_app.api_save(directory=tmp, filename="cutout.png", file=up2)
            )
            self.assertEqual(res2["name"], "cutout-1.png")
            self.assertEqual((Path(tmp) / "cutout-1.png").read_bytes(), b"png-bytes-2")

    def test_api_uninstall_validation(self) -> None:
        """Install/uninstall endpoints reject unknown model targets with HTTP 400."""
        with self.assertRaises(HTTPException) as ctx:
            openbgr_app.api_uninstall_model(target="invalid-tier")
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx2:
            asyncio.run(openbgr_app.api_install_model(target="invalid-tier"))
        self.assertEqual(ctx2.exception.status_code, 400)

    def test_fp16_cache_compaction(self) -> None:
        """`compact_model_cache_fp16` rewrites FP32 safetensors to FP16 and is idempotent."""
        from safetensors import safe_open
        from safetensors.torch import save_file

        with tempfile.TemporaryDirectory() as tmp:
            sf_path = Path(tmp) / "model.safetensors"
            save_file(
                {"weight": torch.randn(128, 128, dtype=torch.float32)},
                str(sf_path),
                metadata={"format": "pt"},
            )
            size_before = sf_path.stat().st_size
            with patch.object(
                openbgr_app, "try_to_load_from_cache", return_value=str(sf_path)
            ):
                saved = openbgr_app.compact_model_cache_fp16("dummy/repo")
                self.assertGreater(saved, 0)
                self.assertLess(sf_path.stat().st_size, size_before)
                # Second call is a no-op once already FP16
                self.assertEqual(openbgr_app.compact_model_cache_fp16("dummy/repo"), 0)

            with safe_open(str(sf_path), framework="pt", device="cpu") as f:
                self.assertEqual(f.get_tensor("weight").dtype, torch.float16)

    def test_frontend_modules_and_dom_ids(self) -> None:
        """Every `getElementById` in the ES modules resolves to a real `id` in index.html."""
        expected_modules = [
            "state.js",
            "stage.js",
            "export.js",
            "preferences.js",
            "batch.js",
            "tabs.js",
            "app.js",
        ]
        html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
        html_ids = set(re.findall(r'\bid="([^"]+)"', html))

        for mod_name in expected_modules:
            mod_path = STATIC_DIR / mod_name
            self.assertTrue(mod_path.is_file(), f"Missing ES module: {mod_name}")
            src = mod_path.read_text(encoding="utf-8")
            for ref_id in re.findall(r'getElementById\("([^"$]+)"\)', src):
                self.assertIn(
                    ref_id,
                    html_ids,
                    f"#{ref_id} referenced in {mod_name} does not exist in index.html",
                )

    def test_release_archives_contain_all_modules(self) -> None:
        """Windows/Linux release archives ship every frontend module and launcher."""
        win_zip = build_release.build_windows_release()
        linux_tar = build_release.build_linux_release()

        required_entries = {
            "OpenBGR/app.py",
            "OpenBGR/icon_render.py",
            "OpenBGR/openbgr/__init__.py",
            "OpenBGR/openbgr/config.py",
            "OpenBGR/openbgr/models.py",
            "OpenBGR/openbgr/pipeline.py",
            "OpenBGR/openbgr/quick_action.py",
            "OpenBGR/openbgr/desktop.py",
            "OpenBGR/openbgr/api.py",
            "OpenBGR/start.sh",
            "OpenBGR/start.bat",
            "OpenBGR/scripts/make_dev_bundle.py",
            "OpenBGR/static/index.html",
            "OpenBGR/static/styles.css",
            "OpenBGR/static/app.js",
            "OpenBGR/static/state.js",
            "OpenBGR/static/stage.js",
            "OpenBGR/static/export.js",
            "OpenBGR/static/preferences.js",
            "OpenBGR/static/batch.js",
            "OpenBGR/static/tabs.js",
        }

        with zipfile.ZipFile(win_zip, "r") as zf:
            zip_names = {n.replace("\\", "/") for n in zf.namelist()}
            self.assertTrue(required_entries.issubset(zip_names))

        with tarfile.open(linux_tar, "r:gz") as tf:
            tar_names = set(tf.getnames())
            self.assertTrue(required_entries.issubset(tar_names))

    def test_quick_action_notification_and_config(self) -> None:
        """Quick Action notifications, config sanitization, and multi-format encoding behave as specified."""
        msg_single = openbgr_app.format_quick_action_notification(["image.png"], 0)
        self.assertEqual(msg_single, 'Background removed for "image.png"')
        self.assertNotIn("—", msg_single or "")

        msg_multi = openbgr_app.format_quick_action_notification(
            ["a.png", "b.png", "c.png"], 0
        )
        self.assertEqual(msg_multi, "Background removed for 3 images.")
        self.assertNotIn("—", msg_multi or "")

        clean = openbgr_app.sanitize_quick_action_config(
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
        fallback = openbgr_app.sanitize_quick_action_config(
            {"tier": "bogus", "save_mode": "somewhere", "format": "gif"}
        )
        self.assertEqual(fallback["tier"], "auto")
        self.assertEqual(fallback["save_mode"], "same_folder")
        self.assertEqual(fallback["format"], "png")

        # Numeric booleans in a hand-edited config must not fall back
        numeric = openbgr_app.sanitize_quick_action_config(
            {"edge_refine": 0, "copy_clipboard": 1, "notify": 0}
        )
        self.assertFalse(numeric["edge_refine"])
        self.assertTrue(numeric["copy_clipboard"])
        self.assertFalse(numeric["notify"])

    def test_output_path_and_dialog_escaping(self) -> None:
        """Output paths gain the correct extension, and dialog strings are shell-safe."""
        self.assertEqual(
            openbgr_app._with_output_suffix(Path("/tmp/out"), "png"),
            Path("/tmp/out.png"),
        )
        self.assertEqual(
            openbgr_app._with_output_suffix(Path("/tmp/out.webp"), "png"),
            Path("/tmp/out.webp"),
        )
        self.assertEqual(
            openbgr_app._osascript_quote('a"b\\c'), 'a\\"b\\\\c'
        )
        self.assertEqual(openbgr_app._powershell_quote("it's"), "it''s")

        # Verify all 4 Quick Action export formats encode cleanly
        rgba = Image.new("RGBA", (16, 16), (200, 50, 50, 128))
        try:
            for fmt, expected_mode in (
                ("png", "RGBA"),
                ("webp", "RGBA"),
                ("jpg", "RGB"),
                ("mask", "L"),
            ):
                raw = openbgr_app.encode_cutout_image(rgba, fmt=fmt)
                with Image.open(io.BytesIO(raw)) as decoded:
                    self.assertEqual(decoded.mode, expected_mode)
                    self.assertEqual(decoded.size, (16, 16))
        finally:
            rgba.close()

    def test_segment_foreground_and_api_remove_bg_with_mock_model(self) -> None:
        """Full `segment_foreground` and `/api/remove-bg` flow works with a mocked BiRefNet model."""

        class _DummyBiRefNet(torch.nn.Module):
            def forward(self, x: torch.Tensor) -> list[torch.Tensor]:
                b, _c, h, w = x.shape
                logits = torch.full((b, 1, h, w), -4.0, dtype=torch.float32)
                logits[:, :, h // 4 : 3 * h // 4, w // 4 : 3 * w // 4] = 4.0
                return [logits]

        dummy_model = _DummyBiRefNet()
        with patch.object(
            openbgr_app.MANAGER, "get_or_load", return_value=dummy_model
        ):
            src_img = Image.new("RGB", (64, 48), (30, 200, 50))
            try:
                out_img, elapsed_ms, tier_cfg, job_id = (
                    openbgr_app.segment_foreground(
                        src_img,
                        tier="dynamic",
                        defringe=True,
                        despill=True,
                    )
                )
                self.assertEqual(out_img.mode, "RGBA")
                self.assertEqual(out_img.size, (64, 48))
                self.assertGreaterEqual(elapsed_ms, 0.0)
                self.assertTrue(tier_cfg["sublabel"].startswith("Dynamic / "))
                self.assertGreater(job_id, 0)
                out_img.close()
            finally:
                src_img.close()

            # Cancelled epoch raises InterruptedError
            stale_epoch = openbgr_app.MANAGER.cancel_epoch - 1
            with self.assertRaises(InterruptedError):
                openbgr_app.segment_foreground(
                    Image.new("RGB", (16, 16)), job_epoch=stale_epoch
                )

            # End-to-end /api/remove-bg HTTP handler test
            buf = io.BytesIO()
            Image.new("RGB", (40, 30), (120, 80, 200)).save(buf, format="PNG")
            upload = UploadFile(
                filename="sample.png", file=io.BytesIO(buf.getvalue())
            )
            res = asyncio.run(
                openbgr_app.api_remove_bg(
                    file=upload,
                    tier="low",
                    defringe=True,
                    despill=True,
                    matting=False,
                )
            )
            self.assertEqual(res.media_type, "image/png")
            self.assertEqual(res.headers["X-Image-Width"], "40")
            self.assertEqual(res.headers["X-Image-Height"], "30")
            self.assertIn("Lite", res.headers["X-Tier-Used"])

            # Empty upload raises HTTP 400
            empty_up = UploadFile(filename="empty.png", file=io.BytesIO(b""))
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(openbgr_app.api_remove_bg(file=empty_up))
            self.assertEqual(ctx.exception.status_code, 400)

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
                patch.object(openbgr_app, "segment_foreground", side_effect=_fake_segment),
                patch.object(openbgr_app, "QUICK_ACTION_CONFIG_PATH", cfg_path),
                patch.object(openbgr_app, "send_openbgr_notification"),
            ):
                rc = openbgr_app.run_cli(
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

                openbgr_app.save_quick_action_config(
                    {"tier": "general", "save_mode": "same_folder", "format": "webp", "notify": False}
                )
                qa_res = openbgr_app.run_quick_action([str(src_path)])
                self.assertTrue(qa_res["ok"])
                self.assertEqual(qa_res["succeeded"], ["photo.png"])
                self.assertEqual(len(qa_res["outputs"]), 1)
                self.assertTrue(Path(qa_res["outputs"][0]).is_file())

        fake_rgba.close()

    def test_desktop_api_pending_files_and_bridge(self) -> None:
        """`DesktopApi` queues and drains pending files and enforces the 48 MB dialog cap."""
        bridge = openbgr_app.DesktopApi()
        with tempfile.TemporaryDirectory() as tmp:
            img_path = Path(tmp) / "test.png"
            img_path.write_bytes(b"fake-png-content")

            openbgr_app.queue_open_files([str(img_path)])
            drained = bridge.take_pending_files()
            self.assertEqual(len(drained["files"]), 1)
            self.assertEqual(drained["files"][0]["name"], "test.png")
            # Subsequent drain is empty
            self.assertEqual(bridge.take_pending_files(), {"files": []})


if __name__ == "__main__":
    unittest.main()
