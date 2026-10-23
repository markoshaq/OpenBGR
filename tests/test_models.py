"""
Concurrency and lifecycle tests for `openbgr.models`: `ModelManager` loading,
eviction, non-blocking unload, cooperative download cancellation, progress
phase isolation under `model_download_guard`, and uninstall lock ordering.

Run with:
    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

import openbgr.api as api_mod
import openbgr.models as models_mod


class _FakeBackbone:
    """Lightweight stand-in for a BiRefNet `torch.nn.Module`."""

    def __init__(self, repo_id: str) -> None:
        self.repo_id = repo_id
        self.to_calls: list[tuple[Any, Any]] = []
        self.eval_called = False

    def to(self, *, device: Any = None, dtype: Any = None) -> _FakeBackbone:
        self.to_calls.append((device, dtype))
        return self

    def eval(self) -> _FakeBackbone:
        self.eval_called = True
        return self


class TestModelImportDetection(unittest.TestCase):
    """Covers `detect_model_tier` and `find_checkpoint_dirs` folder scanning."""

    @staticmethod
    def _make_checkpoint(folder: Path, name_or_path: str | None = None) -> Path:
        """Writes the two marker files of a checkpoint into `folder`."""
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "model.safetensors").write_bytes(b"weights")
        cfg = {"_name_or_path": name_or_path} if name_or_path else {}
        (folder / "config.json").write_text(json.dumps(cfg), encoding="utf-8")
        return folder

    def test_detect_model_tier_from_config_name_or_path(self) -> None:
        """`_name_or_path` matches repo ids, HF URLs, and local paths to a tier."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cases = {
                "ZhengPeng7/BiRefNet_lite": "lite",
                "https://huggingface.co/ZhengPeng7/BiRefNet_HR": "hr",
                "/home/u/dl/BiRefNet-portrait": "portrait",
                "ZhengPeng7/BiRefNet-matting": "matting",  # legacy repo name
                "C:\\models\\BiRefNet_dynamic": "dynamic",
            }
            for i, (name_or_path, expected) in enumerate(cases.items()):
                folder = self._make_checkpoint(root / f"case-{i}", name_or_path)
                self.assertEqual(
                    models_mod.detect_model_tier(folder),
                    expected,
                    f"_name_or_path {name_or_path!r}",
                )

    def test_detect_model_tier_folder_name_fallback_and_misses(self) -> None:
        """Folder names match repo basenames; unrecognized folders return None."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = self._make_checkpoint(root / "BiRefNet_dynamic")
            self.assertEqual(models_mod.detect_model_tier(folder), "dynamic")
            unknown = self._make_checkpoint(root / "some-model", "unrelated/repo")
            self.assertIsNone(models_mod.detect_model_tier(unknown))
            # A non-checkpoint directory still resolves by name alone.
            bare = root / "BiRefNet_HR"
            bare.mkdir()
            self.assertEqual(models_mod.detect_model_tier(bare), "hr")

    def test_find_checkpoint_dirs_flat_and_nested(self) -> None:
        """Finds the folder itself or its immediate checkpoint children only."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            flat = self._make_checkpoint(root / "flat")
            self.assertEqual(models_mod.find_checkpoint_dirs(flat), [flat])

            container = root / "container"
            child = self._make_checkpoint(container / "inner-model")
            (container / "readme.txt").write_text("x", encoding="utf-8")
            # A checkpoint two levels deep is not discovered by the shallow scan.
            deep = self._make_checkpoint(container / "nest" / "deep-model")
            found = models_mod.find_checkpoint_dirs(container)
            self.assertEqual(found, [child])
            self.assertNotIn(deep, found)

            empty = root / "empty"
            empty.mkdir()
            self.assertEqual(models_mod.find_checkpoint_dirs(empty), [])
            self.assertEqual(models_mod.find_checkpoint_dirs(root / "missing"), [])


class TestModelManagerConcurrency(unittest.TestCase):
    """Covers `ModelManager` state transitions, lock ordering, and download cancellation."""

    def setUp(self) -> None:
        models_mod.set_job_phase("idle")

    def tearDown(self) -> None:
        models_mod.set_job_phase("idle")

    def test_get_or_load_cache_hit_and_eviction(self) -> None:
        """`get_or_load` reuses the active backbone, evicts on switch, and rejects unknown keys."""
        mgr = models_mod.ModelManager()
        loaded: list[_FakeBackbone] = []

        def _fake_from_pretrained(repo_id: str, **_kwargs: Any) -> _FakeBackbone:
            inst = _FakeBackbone(repo_id)
            loaded.append(inst)
            return inst

        with (
            patch.object(
                models_mod.AutoModelForImageSegmentation,
                "from_pretrained",
                side_effect=_fake_from_pretrained,
            ) as mock_fp,
            patch.object(mgr, "flush_device_memory") as mock_flush,
        ):
            m1 = mgr.get_or_load("lite")
            self.assertIs(m1, loaded[0])
            self.assertEqual(mgr.active_model_key, "lite")
            self.assertTrue(loaded[0].eval_called)
            self.assertEqual(len(loaded[0].to_calls), 1)
            self.assertEqual(mock_fp.call_count, 1)

            # Fast path: second request for the same tier reuses the resident model.
            m1_again = mgr.get_or_load("lite")
            self.assertIs(m1_again, m1)
            self.assertEqual(mock_fp.call_count, 1)
            mock_flush.assert_not_called()

            # Switching tiers evicts the previous backbone and flushes device memory.
            m2 = mgr.get_or_load("general")
            self.assertIs(m2, loaded[1])
            self.assertEqual(mgr.active_model_key, "general")
            self.assertEqual(mock_fp.call_count, 2)
            mock_flush.assert_called_once_with()

        with self.assertRaises(ValueError):
            mgr.get_or_load("not-a-model")

    def test_get_or_load_cache_miss_downloads_compacts_and_loads(self) -> None:
        """A local cache miss triggers `snapshot_download`, FP16 compaction, and reload."""
        mgr = models_mod.ModelManager()
        calls: list[bool] = []

        def _fake_from_pretrained(repo_id: str, *, local_files_only: bool = False, **_kw: Any):
            calls.append(local_files_only)
            if len(calls) == 1:
                raise OSError("not in local cache")
            return _FakeBackbone(repo_id)

        with (
            patch.object(
                models_mod.AutoModelForImageSegmentation,
                "from_pretrained",
                side_effect=_fake_from_pretrained,
            ),
            patch.object(models_mod, "snapshot_download") as mock_snap,
            patch.object(models_mod, "compact_model_cache_fp16", return_value=1024) as mock_compact,
            patch.object(models_mod, "offline_mode_enabled", return_value=False),
        ):
            model = mgr.get_or_load("lite")
            self.assertEqual(mgr.active_model_key, "lite")
            self.assertIsInstance(model, _FakeBackbone)
            self.assertEqual(calls, [True, True])
            mock_snap.assert_called_once()
            mock_compact.assert_called_once_with(models_mod.MODELS["lite"])
            self.assertEqual(models_mod.JOB_PROGRESS["phase"], "idle")

    def test_get_or_load_snapshot_failure_falls_back_to_transformers_downloader(self) -> None:
        """Non-cancel errors in `snapshot_download` fall back to `local_files_only=False`."""
        mgr = models_mod.ModelManager()
        calls: list[bool] = []

        def _fake_from_pretrained(repo_id: str, *, local_files_only: bool = False, **_kw: Any):
            calls.append(local_files_only)
            if local_files_only:
                raise OSError("cache miss")
            return _FakeBackbone(repo_id)

        with (
            patch.object(
                models_mod.AutoModelForImageSegmentation,
                "from_pretrained",
                side_effect=_fake_from_pretrained,
            ),
            patch.object(models_mod, "snapshot_download", side_effect=RuntimeError("hub glitch")),
            patch.object(models_mod, "compact_model_cache_fp16", return_value=0),
            patch.object(models_mod, "offline_mode_enabled", return_value=False),
        ):
            mgr.get_or_load("general")
            self.assertEqual(mgr.active_model_key, "general")
            self.assertEqual(calls, [True, False])

    def test_get_or_load_respects_offline_mode_on_cache_miss(self) -> None:
        """Offline mode turns a cache miss into `FileNotFoundError` without touching the network."""
        mgr = models_mod.ModelManager()
        with (
            patch.object(
                models_mod.AutoModelForImageSegmentation,
                "from_pretrained",
                side_effect=OSError("missing"),
            ),
            patch.object(models_mod, "snapshot_download") as mock_snap,
            patch.object(models_mod, "offline_mode_enabled", return_value=True),
        ):
            with self.assertRaises(FileNotFoundError):
                mgr.get_or_load("lite")
            mock_snap.assert_not_called()
            self.assertIsNone(mgr.model)
            self.assertEqual(models_mod.JOB_PROGRESS["phase"], "idle")

    def test_unload_nonblocking_when_lock_is_held(self) -> None:
        """`unload(wait=False)` returns False immediately when `_lock` is held, True when free."""
        mgr = models_mod.ModelManager()
        mgr.model = MagicMock()
        mgr.active_model_key = "lite"

        acquired = threading.Event()
        release = threading.Event()

        def _hold_lock() -> None:
            with mgr._lock:
                acquired.set()
                release.wait(timeout=5.0)

        t = threading.Thread(target=_hold_lock, daemon=True)
        t.start()
        self.assertTrue(acquired.wait(timeout=2.0))
        try:
            self.assertFalse(mgr.unload(wait=False))
            self.assertIsNotNone(mgr.model)
        finally:
            release.set()
            t.join(timeout=2.0)

        with patch.object(mgr, "flush_device_memory") as mock_flush:
            self.assertTrue(mgr.unload(wait=False))
            self.assertIsNone(mgr.model)
            self.assertIsNone(mgr.active_model_key)
            mock_flush.assert_called_once_with()

    def test_download_tqdm_byte_accounting_and_cooperative_cancel(self) -> None:
        """`_JobDownloadTqdm` tracks bytes and aborts `get_or_load` on `request_cancel()`."""
        mgr = models_mod.MANAGER
        mgr.unload()

        def _cancelling_snapshot(repo_id: str, tqdm_class: Any = None, **_kw: Any) -> None:
            bar = models_mod._JobDownloadTqdm(total=1000, initial=100)
            bar.update(250)
            self.assertEqual(models_mod.JOB_PROGRESS["total_bytes"], 1000)
            self.assertEqual(models_mod.JOB_PROGRESS["downloaded_bytes"], 350)
            mgr.request_cancel()
            bar.update(100)  # must raise InterruptedError

        with (
            patch.object(
                models_mod.AutoModelForImageSegmentation,
                "from_pretrained",
                side_effect=OSError("cache miss"),
            ) as mock_fp,
            patch.object(models_mod, "snapshot_download", side_effect=_cancelling_snapshot),
            patch.object(models_mod, "offline_mode_enabled", return_value=False),
        ):
            with self.assertRaises(InterruptedError):
                mgr.get_or_load("lite")
            # Cancelled downloads must not fall back to a second `from_pretrained` call.
            self.assertEqual(mock_fp.call_count, 1)
            self.assertIsNone(mgr.model)
            self.assertEqual(models_mod.JOB_PROGRESS["phase"], "idle")

    def test_model_download_guard_does_not_mislabel_progress_phase(self) -> None:
        """`model_download_guard` serializes cache ops without reporting `phase == 'download'`."""
        self.assertFalse(models_mod.model_download_active())
        with models_mod.model_download_guard(blocking=False):
            # Guard holds the lock so concurrent non-blocking guards fail fast...
            with (
                self.assertRaises(BlockingIOError),
                models_mod.model_download_guard(blocking=False),
            ):
                pass
            # ...but does NOT claim a download is in flight.
            self.assertFalse(models_mod.model_download_active())
            self.assertEqual(api_mod.api_job_progress()["phase"], "idle")

        with models_mod.track_model_download("portrait"):
            self.assertTrue(models_mod.model_download_active())
            snap = api_mod.api_job_progress()
            self.assertEqual(snap["phase"], "download")
            self.assertEqual(snap["model_key"], "portrait")
        self.assertFalse(models_mod.model_download_active())

    def test_uninstall_conflict_guards_and_lock_ordering(self) -> None:
        """`api_uninstall_model` returns HTTP 409 without deadlocking under held locks."""
        mgr = models_mod.MANAGER

        # 1. Held inference_lock -> 409
        with mgr.inference_lock:
            with self.assertRaises(HTTPException) as ctx:
                api_mod.api_uninstall_model(target="lite")
            self.assertEqual(ctx.exception.status_code, 409)

        # 2. Active download / held model_download_guard -> 409
        with models_mod.model_download_guard(blocking=False):
            with self.assertRaises(HTTPException) as ctx2:
                api_mod.api_uninstall_model(target="lite")
            self.assertEqual(ctx2.exception.status_code, 409)

        # 3. Active model whose `_lock` is held on another thread -> fast 409 via unload(wait=False)
        mgr.active_model_key = "lite"
        mgr.model = MagicMock()
        acquired = threading.Event()
        release = threading.Event()

        def _hold_model_lock() -> None:
            with mgr._lock:
                acquired.set()
                release.wait(timeout=5.0)

        t = threading.Thread(target=_hold_model_lock, daemon=True)
        t.start()
        self.assertTrue(acquired.wait(timeout=2.0))
        try:
            with self.assertRaises(HTTPException) as ctx3:
                api_mod.api_uninstall_model(target="lite")
            self.assertEqual(ctx3.exception.status_code, 409)
        finally:
            release.set()
            t.join(timeout=2.0)
            mgr.unload()


if __name__ == "__main__":
    unittest.main()
