# OpenBGR

Local background removal tool powered by [BiRefNet](https://github.com/ZhengPeng7/BiRefNet). Runs entirely on your own hardware (NVIDIA CUDA, Apple Silicon MPS, or CPU) and exports full-resolution cutouts without cloud uploads, watermarks, or compression.

## Quickstart

Works on macOS, Windows, and Linux. If Python 3.10+ isn't installed on your machine, the launch script automatically provisions a standalone Python 3.12 runtime via [`uv`](https://docs.astral.sh/uv/).

**macOS & Linux**
```bash
git clone https://github.com/markoshaq/OpenBGR.git
cd OpenBGR
./start.sh
```

**Windows**
```bat
git clone https://github.com/markoshaq/OpenBGR.git
cd OpenBGR
start.bat
```

Or download the repository ZIP and double-click **`Start Mac.command`** (macOS) or **`start.bat`** (Windows). The app opens at `http://127.0.0.1:7860`.

## Features

- **100% Offline After Setup** — Model weights are downloaded once from Hugging Face and loaded strictly from local cache (`local_files_only=True`) on future runs.
- **Three Model Presets** — Switch between `BiRefNet_lite` (fast CPU/iGPU), full `BiRefNet` (default for GPUs and Apple Silicon), and `BiRefNet_HR` (2K high-resolution).
- **Edge Defringing** — Removes background color bleed along semi-transparent hair and soft borders.
- **Live Export Preview** — Export as `PNG`, `WEBP`, `JPG`, or an 8-bit `Alpha Mask` at any scale (`10%–200%`) or custom pixel dimensions (`W × H`), rendered live on `<canvas>` without re-running inference.
- **Zoom, Pan & 4× Loupe** — Scroll-wheel zoom (`100%–800%`) with click-and-drag panning, plus a toggleable 4× circular magnifier loupe (`Z` key) for inspecting hair strands and edges.
- **Native Desktop Window** — Opens in a standalone native OS window via `pywebview` (with a native OS Save dialog and automatic browser fallback).
- **Hardware Acceleration** — Runs in `FP16` half-precision on CUDA and Apple MPS (cutting memory usage in half and speeding up inference ~5×), and automatically evicts inactive models from memory when switching presets.

## Models

| Preset | Checkpoint | Backbone | Native Resolution | FP16 Memory | Best For |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Low-End** | `ZhengPeng7/BiRefNet_lite` | Swin-T | `1024 × 1024` | ~110 MB | CPUs & integrated graphics |
| **Mid-Range** *(Default)* | `ZhengPeng7/BiRefNet` | Swin-L | `1024 × 1024` | ~440 MB | Apple Silicon & consumer GPUs |
| **High-End** | `ZhengPeng7/BiRefNet_HR` | Swin-L | `1536` / `2048` | ~440 MB | High-megapixel studio photos |

Output masks are always upsampled (`LANCZOS`) back to the exact pixel dimensions of the source image.

## API

You can also call the FastAPI server directly:

```bash
curl -X POST "http://127.0.0.1:7860/api/remove-bg" \
  -F "file=@photo.jpg" \
  -F "tier=mid" \
  -F "defringe=true" \
  -o photo-cutout.png
```

## Project Layout

```text
├── app.py               # FastAPI server, model lifecycle & inference pipeline
├── static/
│   ├── index.html       # 3-column studio workspace
│   ├── styles.css       # Stylesheet
│   └── app.js           # UI controller, split view & client-side canvas export
├── Start Mac.command    # macOS Finder launcher
├── start.sh             # macOS / Linux bootstrapper
├── start.bat            # Windows bootstrapper
└── requirements.txt     # Python dependencies
```

## Building Desktop Releases (`.dmg` / `.exe` / Linux)

To build lightweight desktop release bundles locally into `dist/`:

```bash
python3 scripts/build_release.py
```

Pushing a version tag (e.g. `git tag v0.01 && git push origin v0.01`) triggers `.github/workflows/release.yml` to build and attach `OpenBGR-macOS.dmg`, `OpenBGR-Windows.zip`, and `OpenBGR-Linux.tar.gz` to a GitHub Release automatically.

## License

[MIT](./LICENSE)
