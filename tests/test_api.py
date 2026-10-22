"""
HTTP-level and unit coverage of the FastAPI surface: status/progress contracts,
save/refine/uninstall validation, open-file queueing, and pending-file draining.

Run with:
    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from fastapi import HTTPException, UploadFile
from PIL import Image

import openbgr.api as api_mod
import openbgr.config as config_mod
import openbgr.desktop_bridge as bridge_mod
import openbgr.models as models_mod
import openbgr.pipeline as pipeline_mod


class TestApiContracts(unittest.TestCase):
    """Direct-call contract tests for the OpenBGR server endpoints."""

    def test_version_and_status_contract(self) -> None:
        """`/api/status` exposes version, disk/RAM fields, and all six model tiers."""
        status = api_mod.api_status()
        self.assertEqual(status["version"], config_mod.APP_VERSION)
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
        self.assertEqual(config_mod.normalize_tier_key("low"), "lite")
        self.assertEqual(config_mod.normalize_tier_key("mid"), "general")
        self.assertEqual(config_mod.normalize_tier_key("high"), "hr")
        # Dynamic sizing preserves aspect ratio and rounds to multiples of 32
        dyn_h, dyn_w = models_mod.compute_dynamic_size(1920, 1080, 2048)
        self.assertEqual(dyn_w % 32, 0)
        self.assertEqual(dyn_h % 32, 0)
        self.assertGreater(dyn_w, dyn_h)

    def test_api_refine_endpoint(self) -> None:
        """`/api/refine` re-composes a cached job and rejects stale job ids with HTTP 409."""
        rgb = np.full((24, 24, 3), (30, 180, 90), dtype=np.uint8)
        alpha = np.zeros((24, 24), dtype=np.uint8)
        alpha[6:18, 6:18] = 255
        alpha[5, 6:18] = 140

        with pipeline_mod._LAST_JOB_LOCK:
            pipeline_mod._LAST_JOB.clear()
            pipeline_mod._LAST_JOB.update({"id": 42, "rgb": rgb, "alpha": alpha})

        res = asyncio.run(
            api_mod.api_refine(job_id=42, defringe=True, despill=True, edge_shift=0, edge_feather=0)
        )
        self.assertEqual(res.media_type, "image/png")
        self.assertEqual(res.headers["X-Refine-Job-Id"], "42")
        out = Image.open(io.BytesIO(res.body))
        self.assertEqual(out.mode, "RGBA")
        self.assertEqual(out.size, (24, 24))
        out.close()

        # Edge geometry fields re-compose from the raw cached alpha
        res_shift = asyncio.run(
            api_mod.api_refine(
                job_id=42, defringe=False, despill=False, edge_shift=-3, edge_feather=1
            )
        )
        out_shift = Image.open(io.BytesIO(res_shift.body))
        alpha_shift = out_shift.getchannel("A")
        self.assertEqual(alpha_shift.getpixel((0, 0)), 0)
        self.assertGreater(alpha_shift.getpixel((11, 11)), 200)
        self.assertLess(alpha_shift.getpixel((11, 11)), 255)
        alpha_shift.close()
        out_shift.close()

        # Stale job ids are rejected so an older tab can't refine a newer job
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                api_mod.api_refine(
                    job_id=41, defringe=True, despill=True, edge_shift=0, edge_feather=0
                )
            )
        self.assertEqual(ctx.exception.status_code, 409)

    def test_api_save_sanitizes_and_renames_collisions(self) -> None:
        """`/api/save` strips path traversal and de-duplicates colliding filenames."""
        with tempfile.TemporaryDirectory() as tmp:
            up1 = UploadFile(filename="cutout.png", file=io.BytesIO(b"png-bytes-1"))
            res1 = asyncio.run(
                api_mod.api_save(directory=tmp, filename="../../evil/cutout.png", file=up1)
            )
            self.assertTrue(res1["ok"])
            self.assertEqual(res1["name"], "cutout.png")
            self.assertEqual((Path(tmp) / "cutout.png").read_bytes(), b"png-bytes-1")

            up2 = UploadFile(filename="cutout.png", file=io.BytesIO(b"png-bytes-2"))
            res2 = asyncio.run(api_mod.api_save(directory=tmp, filename="cutout.png", file=up2))
            self.assertEqual(res2["name"], "cutout-1.png")
            self.assertEqual((Path(tmp) / "cutout-1.png").read_bytes(), b"png-bytes-2")

    def test_api_uninstall_validation(self) -> None:
        """Install/uninstall endpoints reject unknown model targets with HTTP 400."""
        with self.assertRaises(HTTPException) as ctx:
            api_mod.api_uninstall_model(target="invalid-tier")
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx2:
            asyncio.run(api_mod.api_install_model(target="invalid-tier"))
        self.assertEqual(ctx2.exception.status_code, 400)

    def test_desktop_api_pending_files_and_bridge(self) -> None:
        """`DesktopApi` queues and drains pending files as one-shot file_id grants."""
        bridge = bridge_mod.DesktopApi()
        with tempfile.TemporaryDirectory() as tmp:
            img_path = Path(tmp) / "test.png"
            img_path.write_bytes(b"fake-png-content")

            bridge_mod.queue_open_files([str(img_path)])
            drained = bridge.take_pending_files()
            self.assertEqual(len(drained["files"]), 1)
            self.assertEqual(drained["files"][0]["name"], "test.png")
            self.assertTrue(drained["files"][0]["file_id"])
            # Subsequent drain is empty
            self.assertEqual(bridge.take_pending_files(), {"files": []})

            # HTTP open-files / pending-files endpoints mirror the native bridge
            queued = api_mod.api_open_files(files=[str(img_path)])
            self.assertTrue(queued["ok"])
            self.assertEqual(queued["pending"], 1)
            http_drained = api_mod.api_take_pending_files()
            self.assertEqual(len(http_drained["files"]), 1)
            self.assertEqual(http_drained["files"][0]["name"], "test.png")
            self.assertEqual(api_mod.api_take_pending_files(), {"files": []})

            # Clipboard probe handles PIL Image, file list, and empty clipboard.
            # Pin the platform to Windows so the PIL path runs: on macOS the
            # fast pasteboard check answers before PIL is ever consulted.
            from PIL import ImageGrab

            fake_clip = Image.new("RGBA", (8, 8), (255, 0, 0, 255))
            with patch.object(bridge_mod.platform, "system", return_value="Windows"):
                with patch.object(ImageGrab, "grabclipboard", return_value=fake_clip):
                    self.assertEqual(bridge.has_clipboard_image(), {"has_image": True})
                with patch.object(ImageGrab, "grabclipboard", return_value=[str(img_path)]):
                    self.assertEqual(bridge.has_clipboard_image(), {"has_image": True})
                with patch.object(
                    ImageGrab, "grabclipboard", return_value=[str(Path(tmp) / "a.txt")]
                ):
                    self.assertEqual(bridge.has_clipboard_image(), {"has_image": False})

    def test_queue_open_files_rejects_non_images(self) -> None:
        """Launch-time 'odoc' events for the script itself (app.py) are filtered out."""
        bridge = bridge_mod.DesktopApi()
        with tempfile.TemporaryDirectory() as tmp:
            script_path = Path(tmp) / "app.py"
            script_path.write_text("print('not an image')")
            missing_img = Path(tmp) / "ghost.png"

            bridge_mod.queue_open_files([str(script_path), str(missing_img)])
            self.assertEqual(bridge.take_pending_files(), {"files": []})

    def test_api_open_logs_dir(self) -> None:
        """`/api/open-logs-dir` opens `APP_CONFIG_DIR` and returns HTTP 500 on failure."""
        with patch.object(api_mod, "open_folder_in_file_manager", return_value=True) as mock_fn:
            res = api_mod.api_open_logs_dir()
            self.assertTrue(res["ok"])
            mock_fn.assert_called_once_with(config_mod.APP_CONFIG_DIR)

        with (
            patch.object(api_mod, "open_folder_in_file_manager", return_value=False),
            self.assertRaises(HTTPException) as ctx,
        ):
            api_mod.api_open_logs_dir()
        self.assertEqual(ctx.exception.status_code, 500)

    def test_job_progress_phase_transitions(self) -> None:
        """`/api/progress` exposes a valid phase and resets byte counters off-download."""
        progress = api_mod.api_job_progress()
        self.assertIn(progress["phase"], {"idle", "download", "load", "inference"})
        self.assertIsInstance(progress["downloaded_bytes"], int)
        self.assertIsInstance(progress["total_bytes"], int)
        self.assertNotIn("_dl_epoch", progress)
        self.assertNotIn("_dl_key", progress)

        with models_mod.JOB_PROGRESS_LOCK:
            models_mod.JOB_PROGRESS["phase"] = "download"
            models_mod.JOB_PROGRESS["downloaded_bytes"] = 123
            models_mod.JOB_PROGRESS["total_bytes"] = 999
        models_mod.set_job_phase("inference", "general")
        self.assertEqual(models_mod.JOB_PROGRESS["phase"], "inference")
        self.assertEqual(models_mod.JOB_PROGRESS["downloaded_bytes"], 0)
        self.assertEqual(models_mod.JOB_PROGRESS["model_key"], "general")
        models_mod.set_job_phase("idle")


class TestApiEndpoints(unittest.TestCase):
    """HTTP-level coverage of the FastAPI surface: routing, form parsing, and status codes."""

    @classmethod
    def setUpClass(cls) -> None:
        from fastapi.testclient import TestClient

        cls.client = TestClient(api_mod.app)
        # Mutating endpoints require the per-session token header.
        cls.client.headers.update({config_mod.API_TOKEN_HEADER: config_mod.API_TOKEN})

    def setUp(self) -> None:
        with bridge_mod._PENDING_OPEN_LOCK:
            bridge_mod._PENDING_OPEN_FILES.clear()

    def test_mutating_endpoints_require_session_token(self) -> None:
        """Mutating `/api/*` calls without a valid token or cross-site are rejected."""
        from fastapi.testclient import TestClient

        bare = TestClient(api_mod.app)
        self.assertEqual(bare.post("/api/cancel").status_code, 403)
        self.assertEqual(
            bare.post(
                "/api/cancel",
                headers={config_mod.API_TOKEN_HEADER: "wrong-token"},
            ).status_code,
            403,
        )
        # Even a valid token is refused when fetch metadata says cross-site.
        self.assertEqual(
            bare.post(
                "/api/cancel",
                headers={
                    config_mod.API_TOKEN_HEADER: config_mod.API_TOKEN,
                    "sec-fetch-site": "cross-site",
                },
            ).status_code,
            403,
        )
        # Read-only endpoints stay open, and the page carries the token.
        self.assertEqual(bare.get("/api/progress").status_code, 200)
        home = bare.get("/")
        self.assertEqual(home.status_code, 200)
        self.assertIn('name="openbgr-api-token"', home.text)
        self.assertIn(config_mod.API_TOKEN, home.text)

    def test_status_and_progress_over_http(self) -> None:
        """`GET /api/status` and `/api/progress` return 200 with their contract fields."""
        res = self.client.get("/api/status")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["version"], config_mod.APP_VERSION)
        self.assertIn("tiers", data)
        self.assertIn("device", data)

        res = self.client.get("/api/progress")
        self.assertEqual(res.status_code, 200)
        self.assertIn("phase", res.json())

    def test_cancel_over_http(self) -> None:
        """`POST /api/cancel` returns the cancellation epoch."""
        res = self.client.post("/api/cancel")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json()["cancelled"])
        self.assertIsInstance(res.json()["epoch"], int)

    def test_save_round_trip_collision_and_validation(self) -> None:
        """`POST /api/save` writes files, auto-renames collisions, and rejects bad input."""
        payload = {"file": ("cut.png", b"png-bytes", "image/png")}
        with tempfile.TemporaryDirectory() as tmp:
            res = self.client.post(
                "/api/save", data={"directory": tmp, "filename": "out.png"}, files=payload
            )
            self.assertEqual(res.status_code, 200)
            self.assertEqual((Path(tmp) / "out.png").read_bytes(), b"png-bytes")

            res = self.client.post(
                "/api/save", data={"directory": tmp, "filename": "out.png"}, files=payload
            )
            self.assertEqual(res.json()["name"], "out-1.png")

            res = self.client.post(
                "/api/save",
                data={"directory": "/nonexistent-openbgr-dir", "filename": "x.png"},
                files=payload,
            )
            self.assertEqual(res.status_code, 400)

            res = self.client.post(
                "/api/save", data={"directory": tmp, "filename": ".."}, files=payload
            )
            self.assertEqual(res.status_code, 400)

    def test_open_files_pending_round_trip_over_http(self) -> None:
        """`POST /api/open-files` queues a path and `/api/pending-files` drains it once."""
        with tempfile.TemporaryDirectory() as tmp:
            img = Path(tmp) / "incoming.png"
            img.write_bytes(b"fakepng")
            res = self.client.post("/api/open-files", data={"files": [str(img)]})
            self.assertEqual(res.status_code, 200)
            self.assertTrue(res.json()["ok"])
            self.assertEqual(res.json()["pending"], 1)

            res = self.client.post("/api/pending-files")
            files = res.json()["files"]
            self.assertEqual(len(files), 1)
            self.assertEqual(files[0]["name"], "incoming.png")

            res = self.client.post("/api/pending-files")
            self.assertEqual(res.json()["files"], [])

    def test_local_file_grant_streams_once_over_http(self) -> None:
        """`GET /api/local-file` serves a granted path exactly once, then 404s."""
        with tempfile.TemporaryDirectory() as tmp:
            img = Path(tmp) / "picked.png"
            img.write_bytes(b"img-bytes")
            grants = bridge_mod.register_local_files([img])
            self.assertEqual(len(grants), 1)
            file_id = grants[0]["file_id"]

            res = self.client.get(f"/api/local-file?file_id={file_id}")
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.content, b"img-bytes")

            # One-shot grant: a second fetch is refused, as are unknown ids.
            res = self.client.get(f"/api/local-file?file_id={file_id}")
            self.assertEqual(res.status_code, 404)
            res = self.client.get("/api/local-file?file_id=nope")
            self.assertEqual(res.status_code, 404)

    def test_remove_bg_http_validation(self) -> None:
        """`POST /api/remove-bg` maps bad tier/empty/undecodable uploads to HTTP 400."""
        res = self.client.post(
            "/api/remove-bg",
            data={"tier": "not-a-tier"},
            files={"file": ("x.png", b"img", "image/png")},
        )
        self.assertEqual(res.status_code, 400)

        res = self.client.post(
            "/api/remove-bg",
            data={"tier": "general"},
            files={"file": ("x.png", b"", "image/png")},
        )
        self.assertEqual(res.status_code, 400)

        res = self.client.post(
            "/api/remove-bg",
            data={"tier": "general"},
            files={"file": ("x.png", b"not-an-image", "image/png")},
        )
        self.assertEqual(res.status_code, 400)

    def test_remove_bg_happy_path_over_http(self) -> None:
        """`POST /api/remove-bg` streams a PNG with telemetry headers when the pipeline runs."""
        buf = io.BytesIO()
        Image.new("RGB", (24, 16), (10, 20, 30)).save(buf, format="PNG")
        result_img = Image.new("RGBA", (24, 16), (10, 20, 30, 255))

        def _fake_seg(  # noqa: ANN001
            img, tier, defringe, despill, matting, job_epoch, edge_shift=0, edge_feather=0
        ):
            img.close()
            return result_img, 12.5, config_mod.TIERS["general"], 3

        with patch.object(api_mod, "segment_foreground", side_effect=_fake_seg):
            res = self.client.post(
                "/api/remove-bg",
                data={"tier": "general"},
                files={"file": ("in.png", buf.getvalue(), "image/png")},
            )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers["content-type"], "image/png")
        self.assertEqual(res.headers["X-Image-Width"], "24")
        self.assertIn("X-Inference-Time-Ms", res.headers)
        decoded = Image.open(io.BytesIO(res.content))
        self.assertEqual((decoded.width, decoded.height), (24, 16))
        decoded.close()
        result_img.close()

    def test_models_uninstall_unknown_target_over_http(self) -> None:
        """`POST /api/models/uninstall` rejects unknown targets with HTTP 400."""
        res = self.client.post("/api/models/uninstall", data={"target": "bogus-model"})
        self.assertEqual(res.status_code, 400)

    def test_quick_action_config_over_http(self) -> None:
        """`GET /api/quick-action-config` returns the persisted config and install status."""
        res = self.client.get("/api/quick-action-config")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("installed", data)
        self.assertIn("platform", data)


if __name__ == "__main__":
    unittest.main()
