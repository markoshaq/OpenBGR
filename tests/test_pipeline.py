"""
Pipeline and model-lifecycle tests: icon rendering, edge refinement, FP16
cache compaction, and the mocked end-to-end segmentation path.

Run with:
    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import io
import tempfile
import unittest
import warnings
from pathlib import Path
from unittest.mock import patch

import numpy as np
import torch
from fastapi import HTTPException, UploadFile
from PIL import Image

import openbgr.api as api_mod
import openbgr.icon_render as icon_render
import openbgr.models as models_mod
import openbgr.pipeline as pipeline_mod


class TestPipeline(unittest.TestCase):
    """Image pipeline, cache compaction, and segmentation-flow tests."""

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

        defringed = pipeline_mod.decontaminate_edge_colors(np.array(rgb, dtype=np.uint8), alpha)
        self.assertEqual(defringed.shape, (32, 32, 3))
        self.assertEqual(defringed.dtype, np.uint8)

        despilled = pipeline_mod.suppress_color_spill(defringed, alpha.astype(np.float32) / 255.0)
        self.assertEqual(despilled.shape, (32, 32, 3))
        self.assertEqual(despilled.dtype, np.uint8)

        # compose_rgba produces a full 32-bit RGBA cutout with and without filters
        composed = pipeline_mod.compose_rgba(
            np.array(rgb, dtype=np.uint8), alpha, defringe=True, despill=True
        )
        self.assertEqual(composed.mode, "RGBA")
        self.assertEqual(composed.size, (32, 32))
        self.assertEqual(composed.getpixel((0, 0))[3], 0)
        self.assertEqual(composed.getpixel((16, 16))[3], 255)
        composed.close()

    def test_suppress_color_spill_off_grid_background(self) -> None:
        """A lone background pixel off the stride-8 subsample grid must not NaN the pass."""
        rgb = np.full((16, 16, 3), (100, 100, 100), dtype=np.uint8)
        alpha_norm = np.full((16, 16), 200 / 255.0, dtype=np.float32)
        alpha_norm[3, 3] = 10 / 255.0  # sole background pixel, misses the [::8, ::8] grid
        with warnings.catch_warnings():
            warnings.simplefilter("error", RuntimeWarning)
            despilled = pipeline_mod.suppress_color_spill(rgb, alpha_norm)
        np.testing.assert_array_equal(despilled, rgb)

    def test_adjust_alpha_geometry(self) -> None:
        """`adjust_alpha_geometry` contracts, expands, and feathers the matte edge."""
        alpha = np.zeros((32, 32), dtype=np.uint8)
        alpha[8:24, 8:24] = 255

        # Negative shift erodes the matte: bbox shrinks by shift px per side.
        eroded = pipeline_mod.adjust_alpha_geometry(alpha, shift_px=-3)
        self.assertEqual(eroded.dtype, np.uint8)
        self.assertEqual(int(eroded[8, 8]), 0)
        self.assertEqual(int(eroded[11, 11]), 255)
        self.assertGreater(int(alpha.sum() - eroded.sum()), 0)

        # Positive shift dilates it outward.
        dilated = pipeline_mod.adjust_alpha_geometry(alpha, shift_px=2)
        self.assertEqual(int(dilated[6, 16]), 255)
        self.assertEqual(int(dilated[5, 16]), 0)

        # Feather softens hard edges into intermediate alpha values.
        feathered = pipeline_mod.adjust_alpha_geometry(alpha, shift_px=0, feather_px=2)
        self.assertEqual(feathered.dtype, np.uint8)
        edge_vals = feathered[7, 8:24]
        self.assertTrue(((edge_vals > 0) & (edge_vals < 255)).any())
        self.assertEqual(int(feathered[16, 16]), 255)

        # compose_rgba applies geometry before compositing.
        rgb = np.full((32, 32, 3), (40, 200, 60), dtype=np.uint8)
        contracted = pipeline_mod.compose_rgba(
            rgb, alpha, defringe=False, despill=False, edge_shift=-4
        )
        self.assertEqual(contracted.getpixel((10, 10))[3], 0)
        self.assertEqual(contracted.getpixel((16, 16))[3], 255)
        contracted.close()

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
            with patch.object(models_mod, "try_to_load_from_cache", return_value=str(sf_path)):
                saved = models_mod.compact_model_cache_fp16("dummy/repo")
                self.assertGreater(saved, 0)
                self.assertLess(sf_path.stat().st_size, size_before)
                # Second call is a no-op once already FP16
                self.assertEqual(models_mod.compact_model_cache_fp16("dummy/repo"), 0)

            with safe_open(str(sf_path), framework="pt", device="cpu") as f:
                self.assertEqual(f.get_tensor("weight").dtype, torch.float16)

    def test_segment_foreground_and_api_remove_bg_with_mock_model(self) -> None:
        """Full `segment_foreground` and `/api/remove-bg` flow works with a mocked BiRefNet model."""

        class _DummyBiRefNet(torch.nn.Module):
            def forward(self, x: torch.Tensor) -> list[torch.Tensor]:
                b, _c, h, w = x.shape
                logits = torch.full((b, 1, h, w), -4.0, dtype=torch.float32)
                logits[:, :, h // 4 : 3 * h // 4, w // 4 : 3 * w // 4] = 4.0
                return [logits]

        dummy_model = _DummyBiRefNet()
        with patch.object(models_mod.MANAGER, "get_or_load", return_value=dummy_model):
            src_img = Image.new("RGB", (64, 48), (30, 200, 50))
            try:
                out_img, elapsed_ms, tier_cfg, job_id = pipeline_mod.segment_foreground(
                    src_img,
                    tier="dynamic",
                    defringe=True,
                    despill=True,
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
            stale_epoch = models_mod.MANAGER.cancel_epoch - 1
            with self.assertRaises(InterruptedError):
                pipeline_mod.segment_foreground(Image.new("RGB", (16, 16)), job_epoch=stale_epoch)

            # End-to-end /api/remove-bg HTTP handler test
            buf = io.BytesIO()
            Image.new("RGB", (40, 30), (120, 80, 200)).save(buf, format="PNG")
            upload = UploadFile(filename="sample.png", file=io.BytesIO(buf.getvalue()))
            res = asyncio.run(
                api_mod.api_remove_bg(
                    file=upload,
                    tier="low",
                    defringe=True,
                    despill=True,
                    matting=False,
                    edge_shift=0,
                    edge_feather=0,
                )
            )
            self.assertEqual(res.media_type, "image/png")
            self.assertEqual(res.headers["X-Image-Width"], "40")
            self.assertEqual(res.headers["X-Image-Height"], "30")
            self.assertIn("Lite", res.headers["X-Tier-Used"])

            # Empty upload raises HTTP 400
            empty_up = UploadFile(filename="empty.png", file=io.BytesIO(b""))
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(api_mod.api_remove_bg(file=empty_up))
            self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
