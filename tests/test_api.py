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
from unittest.mock import MagicMock, patch

import numpy as np
from fastapi import HTTPException, UploadFile
from PIL import Image

import openbgr.api as api_mod
import openbgr.config as config_mod
import openbgr.desktop_bridge as bridge_mod
import openbgr.models as models_mod
import openbgr.pipeline as pipeline_mod
import openbgr.settings as settings_mod


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
        """`/api/refine` re-composes cached multi-tab jobs, evicts over-budget entries, and 409s on misses."""
        rgb = np.full((24, 24, 3), (30, 180, 90), dtype=np.uint8)
        alpha = np.zeros((24, 24), dtype=np.uint8)
        alpha[6:18, 6:18] = 255
        alpha[5, 6:18] = 140

        pipeline_mod.clear_refine_jobs()
        self.assertTrue(pipeline_mod.cache_refine_job(41, rgb, alpha))
        self.assertTrue(pipeline_mod.cache_refine_job(42, rgb, alpha))

        # Both tab 41 and tab 42 stay refinable concurrently (multi-tab LRU cache).
        for jid in (41, 42):
            res = asyncio.run(
                api_mod.api_refine(
                    job_id=jid, defringe=True, despill=True, edge_shift=0, edge_feather=0
                )
            )
            self.assertEqual(res.media_type, "image/png")
            self.assertEqual(res.headers["X-Refine-Job-Id"], str(jid))
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

        # Unknown or evicted job ids are rejected with HTTP 409
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                api_mod.api_refine(
                    job_id=999, defringe=True, despill=True, edge_shift=0, edge_feather=0
                )
            )
        self.assertEqual(ctx.exception.status_code, 409)

        # LRU eviction under byte budget evicts the oldest entry (41) when a new one is cached
        single_bytes = int(rgb.nbytes + alpha.nbytes)
        with patch.object(pipeline_mod, "_LAST_JOB_MAX_BYTES", single_bytes * 2):
            pipeline_mod.cache_refine_job(43, rgb, alpha)
        self.assertIsNone(pipeline_mod.get_last_job(41))
        self.assertIsNotNone(pipeline_mod.get_last_job(42))
        self.assertIsNotNone(pipeline_mod.get_last_job(43))

    def test_api_save_sanitizes_and_renames_collisions(self) -> None:
        """`/api/save` strips path traversal and de-duplicates colliding filenames."""
        with tempfile.TemporaryDirectory() as tmp:
            bridge_mod.grant_output_dir(Path(tmp))
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
        self.assertEqual(bridge.native_menus_enabled(), {"enabled": False})
        bridge.native_menus = True
        self.assertEqual(bridge.native_menus_enabled(), {"enabled": True})
        with tempfile.TemporaryDirectory() as tmp:
            img_path = Path(tmp) / "test.png"
            img_path.write_bytes(b"fake-png-content")

            # Recent-files persistence is redirected so tests never touch the
            # real ~/.openbgr/recent_files.json.
            recents_patch = patch.object(
                bridge_mod, "_recent_files_path", return_value=Path(tmp) / "recent_files.json"
            )
            recents_patch.start()
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
            recents_patch.stop()

    def test_native_menus_resolve_window_lazily_and_add_window_menu(self) -> None:
        """`build_native_menus` actions reach the window attached later; Window menu is macOS-only."""
        import openbgr.desktop_menus as menus_mod

        bridge = bridge_mod.DesktopApi()
        with patch.object(menus_mod.platform, "system", return_value="Darwin"):
            menus = menus_mod.build_native_menus(bridge)
        titles = [m.title for m in menus]
        self.assertEqual(titles, ["__app__", "File", "Edit", "View", "Model", "Window", "Help"])

        # Actions are safe before the window exists and reach it afterwards.
        window_menu = menus[titles.index("Window")]
        actions = {
            getattr(item, "title", ""): getattr(item, "function", None)
            for item in window_menu.items
        }
        actions["Minimize"]()
        actions["Zoom"]()
        fake_window = MagicMock()
        bridge.window = fake_window
        actions["Minimize"]()
        actions["Zoom"]()
        fake_window.minimize.assert_called_once_with()
        fake_window.maximize.assert_called_once_with()

        # On Linux there is no Window menu; the file menu gains Preferences/Quit.
        with patch.object(menus_mod.platform, "system", return_value="Linux"):
            linux_titles = [m.title for m in menus_mod.build_native_menus(bridge)]
        self.assertNotIn("Window", linux_titles)

    def test_queue_open_files_rejects_non_images(self) -> None:
        """Launch-time 'odoc' events for the script itself (app.py) are filtered out."""
        bridge = bridge_mod.DesktopApi()
        with tempfile.TemporaryDirectory() as tmp:
            script_path = Path(tmp) / "app.py"
            script_path.write_text("print('not an image')")
            missing_img = Path(tmp) / "ghost.png"

            with patch.object(
                bridge_mod, "_recent_files_path", return_value=Path(tmp) / "recent_files.json"
            ):
                bridge_mod.queue_open_files([str(script_path), str(missing_img)])
            self.assertEqual(bridge.take_pending_files(), {"files": []})

    def test_recent_files_round_trip_and_grants(self) -> None:
        """Open Recent records paths, prunes missing files, and re-grants on demand."""
        bridge = bridge_mod.DesktopApi()
        with tempfile.TemporaryDirectory() as tmp:
            recents = Path(tmp) / "recent_files.json"
            img_a = Path(tmp) / "a.png"
            img_a.write_bytes(b"a")
            img_b = Path(tmp) / "b.jpg"
            img_b.write_bytes(b"b")
            stray = Path(tmp) / "c.txt"
            stray.write_text("not an image")
            ghost = Path(tmp) / "ghost.png"

            with patch.object(bridge_mod, "_recent_files_path", return_value=recents):
                bridge_mod.add_recent_files([str(img_a), str(stray), str(ghost)])
                bridge_mod.add_recent_files([str(img_b)])
                entries = bridge_mod.list_recent_files()
                self.assertEqual([e["name"] for e in entries], ["b.jpg", "a.png"])

                granted = bridge.open_recent_file(entries[1]["path"])
                self.assertEqual(len(granted["files"]), 1)
                self.assertEqual(granted["files"][0]["name"], "a.png")

                # Paths outside the persisted recents list are refused.
                refused = bridge.open_recent_file(str(Path(tmp) / "x.png"))
                self.assertEqual(refused["files"], [])
                self.assertIn("error", refused)

                # Deleted files are pruned from the list.
                img_a.unlink()
                entries = bridge_mod.list_recent_files()
                self.assertEqual([e["name"] for e in entries], ["b.jpg"])

                self.assertEqual(bridge.clear_recent_files(), {"cleared": True})
                self.assertEqual(bridge.get_recent_files(), {"files": []})

                # reveal_path delegates to the platform file-manager opener.
                with patch.object(
                    bridge_mod, "reveal_in_file_manager", return_value=True
                ) as mock_reveal:
                    self.assertEqual(bridge.reveal_path(str(img_b)), {"revealed": True})
                    mock_reveal.assert_called_once()

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

    def test_settings_round_trip_and_offline_env(self) -> None:
        """`settings` persists the offline switch and mirrors it into HF env vars."""
        import os

        import huggingface_hub.constants as hf_constants

        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.object(settings_mod, "SETTINGS_PATH", Path(tmp) / "settings.json"),
        ):
            try:
                self.assertFalse(settings_mod.offline_mode_enabled())
                self.assertTrue(settings_mod.set_offline_mode(True))
                self.assertTrue(settings_mod.offline_mode_enabled())
                self.assertEqual(os.environ.get("HF_HUB_OFFLINE"), "1")
                self.assertTrue(hf_constants.HF_HUB_OFFLINE)
                self.assertFalse(settings_mod.set_offline_mode(False))
                self.assertNotIn("HF_HUB_OFFLINE", os.environ)
                self.assertFalse(hf_constants.HF_HUB_OFFLINE)
            finally:
                settings_mod.apply_offline_mode(False)

    def test_offline_mode_blocks_model_install(self) -> None:
        """`/api/models/install` rejects downloads while offline mode is on."""
        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.object(settings_mod, "SETTINGS_PATH", Path(tmp) / "settings.json"),
        ):
            try:
                settings_mod.set_offline_mode(True)
                with self.assertRaises(HTTPException) as ctx:
                    asyncio.run(api_mod.api_install_model(target="general"))
                self.assertEqual(ctx.exception.status_code, 409)
            finally:
                settings_mod.set_offline_mode(False)

    def test_import_model_from_dir_layout(self) -> None:
        """`import_model_from_dir` builds a refs/main-resolvable synthetic snapshot."""
        from huggingface_hub import try_to_load_from_cache

        repo_id = "ZhengPeng7/BiRefNet"
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as cache:
            src_dir = Path(src)
            (src_dir / "model.safetensors").write_bytes(b"weights")
            (src_dir / "config.json").write_text("{}", encoding="utf-8")
            (src_dir / "custom.py").write_text("# remote code", encoding="utf-8")
            nested = src_dir / ".git" / "objects"
            nested.mkdir(parents=True)
            (nested / "pack").write_bytes(b"git")

            with patch.object(models_mod, "HF_HUB_CACHE", cache):
                copied = models_mod.import_model_from_dir(repo_id, src_dir)
                self.assertGreater(copied, 0)
                hit = try_to_load_from_cache(repo_id, "model.safetensors", cache_dir=cache)
                self.assertIsInstance(hit, str)
                self.assertEqual(Path(hit).read_bytes(), b"weights")
                snapshot_dir = Path(hit).parent
                self.assertTrue((snapshot_dir / "custom.py").is_file())
                self.assertFalse((snapshot_dir / "pack").exists())

            with self.assertRaises(ValueError):
                empty = src_dir / "empty"
                empty.mkdir()
                models_mod.import_model_from_dir(repo_id, empty)
            with self.assertRaises(FileNotFoundError):
                models_mod.import_model_from_dir(repo_id, src_dir / "missing")

            # Nested folders with duplicate basenames fail loudly instead of overwriting.
            dup_dir = src_dir / "dup"
            (dup_dir / "a").mkdir(parents=True)
            (dup_dir / "b").mkdir(parents=True)
            (dup_dir / "model.safetensors").write_bytes(b"weights")
            (dup_dir / "config.json").write_text("{}", encoding="utf-8")
            (dup_dir / "a" / "modeling.py").write_text("# 1", encoding="utf-8")
            (dup_dir / "b" / "modeling.py").write_text("# 2", encoding="utf-8")
            with self.assertRaises(ValueError):
                models_mod.import_model_from_dir(repo_id, dup_dir)

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

    def test_track_model_download_patches_and_restores_tqdm(self) -> None:
        """The download progress patch swaps hf's tqdm factory, restores it, and warns when absent."""
        import types

        sentinel = object()
        fake_mod = types.SimpleNamespace(tqdm=sentinel)
        original_mod = models_mod._HF_TQDM_MODULE
        try:
            models_mod._HF_TQDM_MODULE = fake_mod
            with models_mod.track_model_download("general"):
                self.assertIs(fake_mod.tqdm, models_mod._JobDownloadTqdm)
            self.assertIs(fake_mod.tqdm, sentinel)

            # Moved/broken huggingface_hub internals warn instead of silently
            # degrading, and still yield the outer-bar class.
            models_mod._HF_TQDM_MODULE = None
            with (
                self.assertLogs("openbgr", level="WARNING") as logs,
                models_mod.track_model_download("general") as bar_cls,
            ):
                self.assertIs(bar_cls, models_mod._JobOuterBarTqdm)
            self.assertTrue(any("tqdm" in out for out in logs.output))
        finally:
            models_mod._HF_TQDM_MODULE = original_mod
            models_mod.set_job_phase("idle")

    def test_apply_offline_mode_reports_unapplied_layers(self) -> None:
        """`apply_offline_mode` returns False and warns when HF session reset is unavailable."""
        try:
            with (
                patch.dict("sys.modules", {"huggingface_hub.utils._http": None}),
                self.assertLogs("openbgr", level="WARNING") as logs,
            ):
                self.assertFalse(settings_mod.apply_offline_mode(True))
            self.assertTrue(any("session" in m.lower() for m in logs.output))
        finally:
            settings_mod.apply_offline_mode(False)


class TestApiEndpoints(unittest.TestCase):
    """HTTP-level coverage of the FastAPI surface: routing, form parsing, and status codes."""

    @classmethod
    def setUpClass(cls) -> None:
        from fastapi.testclient import TestClient

        # Loopback base URL: TrustedHostMiddleware rejects every other Host.
        cls.client = TestClient(api_mod.app, base_url="http://127.0.0.1")
        # Mutating endpoints require the per-session token header.
        cls.client.headers.update({config_mod.API_TOKEN_HEADER: config_mod.API_TOKEN})

    def setUp(self) -> None:
        with bridge_mod._PENDING_OPEN_LOCK:
            bridge_mod._PENDING_OPEN_FILES.clear()
        # Recent-files persistence goes to a temp file, never the real config dir.
        self._recents_tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._recents_tmp.cleanup)
        recents_patch = patch.object(
            bridge_mod,
            "_recent_files_path",
            return_value=Path(self._recents_tmp.name) / "recent_files.json",
        )
        recents_patch.start()
        self.addCleanup(recents_patch.stop)

    def test_mutating_endpoints_require_session_token(self) -> None:
        """Mutating `/api/*` calls without a valid token or cross-site are rejected."""
        from fastapi.testclient import TestClient

        bare = TestClient(api_mod.app, base_url="http://127.0.0.1")
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
        # Read-only endpoints stay open, and the page carries the browser-scoped token.
        self.assertEqual(bare.get("/api/progress").status_code, 200)
        home = bare.get("/")
        self.assertEqual(home.status_code, 200)
        self.assertIn('name="openbgr-api-token"', home.text)
        self.assertIn(config_mod.WEB_API_TOKEN, home.text)
        self.assertNotIn(config_mod.API_TOKEN, home.text)
        self.assertIn("default-src 'self'", home.headers.get("content-security-policy", ""))

        # The browser token works on UI endpoints, but raw-path local-IPC
        # endpoints (/api/open-files, /api/quick-action) refuse it and require
        # the 0600 ~/.openbgr/session_token local token.
        web_headers = {config_mod.API_TOKEN_HEADER: config_mod.WEB_API_TOKEN}
        self.assertEqual(bare.post("/api/cancel", headers=web_headers).status_code, 200)
        self.assertEqual(
            bare.post(
                "/api/open-files", data={"files": ["/tmp/a.png"]}, headers=web_headers
            ).status_code,
            403,
        )
        self.assertEqual(
            bare.post(
                "/api/quick-action", data={"files": ["/tmp/a.png"]}, headers=web_headers
            ).status_code,
            403,
        )

    def test_foreign_host_header_rejected(self) -> None:
        """Non-loopback Host headers get HTTP 400 and never receive the token page."""
        from fastapi.testclient import TestClient

        client = TestClient(api_mod.app, base_url="http://127.0.0.1")
        foreign = {"host": "evil.example.com"}
        res = client.get("/", headers=foreign)
        self.assertEqual(res.status_code, 400)
        self.assertNotIn("openbgr-api-token", res.text)
        # A valid token cannot rescue a rebounded Host on mutating calls.
        res = client.post(
            "/api/cancel",
            headers={**foreign, config_mod.API_TOKEN_HEADER: config_mod.API_TOKEN},
        )
        self.assertEqual(res.status_code, 400)
        # Browsers resolve *.localhost to loopback natively, so wildcard
        # subdomains would widen the token-injection surface; they are rejected.
        res = client.get("/", headers={"host": "app.localhost"})
        self.assertEqual(res.status_code, 400)
        self.assertNotIn("openbgr-api-token", res.text)
        # The loopback names the app and its probes use still pass.
        for host in ("127.0.0.1", "127.0.0.1:7860", "localhost"):
            res = client.get("/api/progress", headers={"host": host})
            self.assertEqual(res.status_code, 200, host)

    def test_status_and_progress_over_http(self) -> None:
        """`GET /api/status` and `/api/progress` return 200 with their contract fields."""
        res = self.client.get("/api/status")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["app"], "openbgr")
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
            bridge_mod.grant_output_dir(Path(tmp))
            res = self.client.post(
                "/api/save", data={"directory": tmp, "filename": "out.png"}, files=payload
            )
            self.assertEqual(res.status_code, 200)
            self.assertEqual((Path(tmp) / "out.png").read_bytes(), b"png-bytes")

            res = self.client.post(
                "/api/save", data={"directory": tmp, "filename": "out.png"}, files=payload
            )
            self.assertEqual(res.json()["name"], "out-1.png")

            # Directories that were never dialog-picked are refused, even when
            # they exist; the folder check never runs for ungranted paths.
            unpicked = Path(tmp) / "unpicked"
            unpicked.mkdir()
            res = self.client.post(
                "/api/save",
                data={"directory": str(unpicked), "filename": "x.png"},
                files=payload,
            )
            self.assertEqual(res.status_code, 403)
            res = self.client.post(
                "/api/save",
                data={"directory": "/nonexistent-openbgr-dir", "filename": "x.png"},
                files=payload,
            )
            self.assertEqual(res.status_code, 403)

            # A granted folder that no longer exists still reports 400.
            gone = Path(tmp) / "gone"
            gone.mkdir()
            bridge_mod.grant_output_dir(gone)
            gone.rmdir()
            res = self.client.post(
                "/api/save",
                data={"directory": str(gone), "filename": "x.png"},
                files=payload,
            )
            self.assertEqual(res.status_code, 400)

            res = self.client.post(
                "/api/save", data={"directory": tmp, "filename": ".."}, files=payload
            )
            self.assertEqual(res.status_code, 400)

    def test_upload_size_cap_over_http(self) -> None:
        """Oversized uploads are refused with HTTP 413 at the middleware and read caps."""
        # Middleware Content-Length rejection fires before the body is parsed.
        with (
            patch.object(api_mod, "MAX_UPLOAD_BYTES", 32),
            patch.object(api_mod, "_MULTIPART_OVERHEAD_BYTES", 0),
        ):
            res = self.client.post(
                "/api/remove-bg",
                files={"file": ("big.png", b"x" * 1024, "image/png")},
            )
            self.assertEqual(res.status_code, 413)
        # The bounded read still catches bodies under a missing/forged length.
        with (
            patch.object(api_mod, "MAX_UPLOAD_BYTES", 8),
            patch.object(api_mod, "_MULTIPART_OVERHEAD_BYTES", 1024 * 1024),
        ):
            res = self.client.post(
                "/api/remove-bg",
                files={"file": ("big.png", b"x" * 1024, "image/png")},
            )
            self.assertEqual(res.status_code, 413)

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

    def test_settings_endpoints_over_http(self) -> None:
        """`GET|POST /api/settings` expose and persist the offline-mode switch."""
        res = self.client.get("/api/settings")
        self.assertEqual(res.status_code, 200)
        self.assertIn("offline_mode", res.json())
        self.assertIn("offline_forced", res.json())

        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.object(settings_mod, "SETTINGS_PATH", Path(tmp) / "settings.json"),
        ):
            try:
                res = self.client.post("/api/settings", data={"offline_mode": "true"})
                self.assertEqual(res.status_code, 200)
                self.assertTrue(res.json()["offline_mode"])
                res = self.client.post("/api/settings", data={"offline_mode": "false"})
                self.assertFalse(res.json()["offline_mode"])
            finally:
                settings_mod.apply_offline_mode(False)

    def test_models_import_over_http(self) -> None:
        """`POST /api/models/import` requires a dialog-granted folder and copies checkpoints."""
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as cache:
            src_dir = Path(src)
            (src_dir / "model.safetensors").write_bytes(b"weights")
            (src_dir / "config.json").write_text("{}", encoding="utf-8")

            # Ungranted directories are rejected with HTTP 403 before touching disk.
            res = self.client.post(
                "/api/models/import",
                data={"target": "general", "path": src},
            )
            self.assertEqual(res.status_code, 403)

            # `/api/choose-folder` grants the native-dialog pick for subsequent imports.
            with patch.object(api_mod, "choose_output_folder_native", return_value=src_dir):
                pick_res = self.client.post("/api/choose-folder")
            self.assertEqual(pick_res.status_code, 200)
            self.assertFalse(pick_res.json()["cancelled"])
            self.assertTrue(bridge_mod.is_output_dir_granted(src_dir))

            with (
                patch.object(models_mod, "HF_HUB_CACHE", cache),
                patch.object(api_mod, "compact_model_cache_fp16", return_value=0),
            ):
                res = self.client.post(
                    "/api/models/import",
                    data={"target": "general", "path": src},
                )
                self.assertEqual(res.status_code, 200)
                self.assertTrue(res.json()["ok"])
                self.assertIn("tiers", res.json()["status"])

            res = self.client.post(
                "/api/models/import",
                data={"target": "bogus-model", "path": src},
            )
            self.assertEqual(res.status_code, 400)
            missing_dir = src_dir / "missing"
            bridge_mod.grant_output_dir(missing_dir)
            res = self.client.post(
                "/api/models/import",
                data={"target": "general", "path": str(missing_dir)},
            )
            self.assertEqual(res.status_code, 400)

    def test_models_import_auto_detect_over_http(self) -> None:
        """`POST /api/models/import` without `target` detects and imports recognized checkpoints."""
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as cache:
            src_dir = Path(src)
            # Checkpoint identified via config.json _name_or_path.
            lite_dir = src_dir / "checkpoint-a"
            lite_dir.mkdir()
            (lite_dir / "model.safetensors").write_bytes(b"w1")
            (lite_dir / "config.json").write_text(
                '{"_name_or_path": "ZhengPeng7/BiRefNet_lite"}', encoding="utf-8"
            )
            # Checkpoint identified via its folder name.
            hr_dir = src_dir / "BiRefNet_HR"
            hr_dir.mkdir()
            (hr_dir / "model.safetensors").write_bytes(b"w2")
            (hr_dir / "config.json").write_text("{}", encoding="utf-8")
            # Checkpoint-looking folder that matches no known model is skipped.
            stray_dir = src_dir / "some-other-model"
            stray_dir.mkdir()
            (stray_dir / "model.safetensors").write_bytes(b"w3")
            (stray_dir / "config.json").write_text(
                '{"_name_or_path": "unrelated/repo"}', encoding="utf-8"
            )

            bridge_mod.grant_output_dir(src_dir)
            with (
                patch.object(models_mod, "HF_HUB_CACHE", cache),
                patch.object(api_mod, "compact_model_cache_fp16", return_value=0),
            ):
                res = self.client.post("/api/models/import", data={"path": src})
                self.assertEqual(res.status_code, 200)
                imported = res.json()["imported"]
                self.assertEqual({e["target"] for e in imported}, {"lite", "hr"})
                for repo in ("BiRefNet_lite", "BiRefNet_HR"):
                    snap = (
                        Path(cache)
                        / f"models--ZhengPeng7--{repo}"
                        / "snapshots"
                        / "manual"
                        / "model.safetensors"
                    )
                    self.assertTrue(snap.is_file(), f"missing snapshot {snap}")

                # A picked folder that is itself a checkpoint imports directly.
                flat = src_dir / "flat" / "BiRefNet-portrait"
                flat.mkdir(parents=True)
                (flat / "model.safetensors").write_bytes(b"w4")
                (flat / "config.json").write_text("{}", encoding="utf-8")
                bridge_mod.grant_output_dir(flat)
                res = self.client.post("/api/models/import", data={"path": str(flat)})
                self.assertEqual(res.status_code, 200)
                self.assertEqual([e["target"] for e in res.json()["imported"]], ["portrait"])

            # No checkpoint folders at all -> 400.
            empty = src_dir / "empty"
            empty.mkdir()
            (empty / "notes.txt").write_text("nothing here", encoding="utf-8")
            bridge_mod.grant_output_dir(empty)
            res = self.client.post("/api/models/import", data={"path": str(empty)})
            self.assertEqual(res.status_code, 400)

            # Checkpoint present but unidentifiable -> 400.
            bridge_mod.grant_output_dir(stray_dir)
            res = self.client.post("/api/models/import", data={"path": str(stray_dir)})
            self.assertEqual(res.status_code, 400)

    def test_quick_action_config_over_http(self) -> None:
        """`GET /api/quick-action-config` returns the persisted config and install status."""
        res = self.client.get("/api/quick-action-config")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("installed", data)
        self.assertIn("platform", data)

    def test_extract_and_encode_animation_over_http(self) -> None:
        """`/api/extract-frames` and `/api/encode-animation` extract and re-encode multi-frame GIF/WebP."""
        f1 = Image.new("RGBA", (20, 16), (255, 0, 0, 255))
        f2 = Image.new("RGBA", (20, 16), (0, 255, 0, 128))
        gif_bytes = pipeline_mod.encode_animated_image([f1, f2], [70, 90], fmt="gif")
        png_buf1 = io.BytesIO()
        f1.save(png_buf1, format="PNG")
        png_bytes = png_buf1.getvalue()
        png_buf2 = io.BytesIO()
        f2.save(png_buf2, format="PNG")
        png2_bytes = png_buf2.getvalue()
        f1.close()
        f2.close()

        # Static PNG reports animated=False.
        res_static = self.client.post(
            "/api/extract-frames",
            files={"file": ("static.png", png_bytes, "image/png")},
        )
        self.assertEqual(res_static.status_code, 200)
        self.assertFalse(res_static.json()["animated"])

        # Multi-frame GIF returns base64 PNG frames and durations.
        res_anim = self.client.post(
            "/api/extract-frames",
            files={"file": ("anim.gif", gif_bytes, "image/gif")},
        )
        self.assertEqual(res_anim.status_code, 200)
        body = res_anim.json()
        self.assertTrue(body["animated"])
        self.assertEqual(body["frame_count"], 2)
        self.assertEqual(len(body["frames"]), 2)

        # Re-encode frames as GIF and WebP via /api/encode-animation.
        for fmt, expected_mime in (("gif", "image/gif"), ("webp", "image/webp")):
            enc_res = self.client.post(
                "/api/encode-animation",
                files=[
                    ("files", ("f1.png", png_bytes, "image/png")),
                    ("files", ("f2.png", png2_bytes, "image/png")),
                ],
                data={"durations": "[80, 120]", "format": fmt},
            )
            self.assertEqual(enc_res.status_code, 200)
            self.assertEqual(enc_res.headers["content-type"], expected_mime)
            with Image.open(io.BytesIO(enc_res.content)) as out_im:
                self.assertEqual(getattr(out_im, "n_frames", 1), 2)

        # Bad format rejected with HTTP 400.
        bad_res = self.client.post(
            "/api/encode-animation",
            files=[("files", ("f1.png", png_bytes, "image/png"))],
            data={"durations": "[80]", "format": "mp4"},
        )
        self.assertEqual(bad_res.status_code, 400)


if __name__ == "__main__":
    unittest.main()
