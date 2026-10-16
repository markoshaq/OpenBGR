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
- **Multi-Tab Workspace** — Open several images as tabs, work on them independently, and drag one tab onto another to merge them into a batch — like folders.
- **Batch Processing** — Batch tabs queue any number of images under one shared settings snapshot, with per-file status, drag-out extraction, direct folder export (or a single ZIP in browser mode), and per-file failure recovery.
- **Three Model Presets + Matting** — Switch between `BiRefNet_lite` (fast CPU/iGPU), full `BiRefNet` (default for GPUs and Apple Silicon), `BiRefNet_HR` (2K high-resolution), and a dedicated `BiRefNet-matting` mode for glass, water, and sheer materials.
- **Edge & Reflection Refinement** — Edge defringing removes background color bleed along hair and soft borders, color-spill suppression cleans rim reflections, and a shadow/reflection alpha cutoff floors out floor shadows at export.
- **Live Export Preview** — Export as `PNG`, `WEBP`, `JPG`, or an 8-bit `Alpha Mask` at any scale (`10%–200%`) or custom pixel dimensions (`W × H`), rendered live on `<canvas>` without re-running inference.
- **Export Destinations** — Set a per-tab output folder for one-click exports, or leave it unset for a native Save-As dialog (browser downloads in fallback mode).
- **Zoom, Pan & 4× Loupe** — Scroll-wheel zoom (`100%–800%`) with click-and-drag panning, plus a toggleable 4× circular magnifier loupe (`Z` key) for inspecting hair strands and edges — works before and after processing.
- **Native Desktop Window** — Opens in a standalone native OS window via `pywebview` (with native menus, clipboard, Save dialogs, and automatic browser fallback).
- **Hardware Acceleration** — Runs in `FP16` half-precision on CUDA and Apple MPS (cutting memory usage in half and speeding up inference ~5×), and automatically evicts inactive models from memory when switching presets.

## Models

| Preset | Checkpoint | Backbone | Native Resolution | FP16 Memory | Best For |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Low-End** | `ZhengPeng7/BiRefNet_lite` | Swin-T | `1024 × 1024` | ~110 MB | CPUs & integrated graphics |
| **Mid-Range** *(Default)* | `ZhengPeng7/BiRefNet` | Swin-L | `1024 × 1024` | ~440 MB | Apple Silicon & consumer GPUs |
| **High-End** | `ZhengPeng7/BiRefNet_HR` | Swin-L | `1536` / `2048` | ~440 MB | High-megapixel studio photos |
| **Matting** | `ZhengPeng7/BiRefNet-matting` | Swin-L | `1024 × 1024` | ~880 MB | Glass, water & sheer materials |

Output masks are always upsampled (`LANCZOS`) back to the exact pixel dimensions of the source image.

Weights download on first use of each preset into the standard Hugging Face cache (`~/.cache/huggingface`) — roughly `170 MB`–`880 MB` per checkpoint, only for the tiers you actually run.

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
├── app.py                  # FastAPI server, model lifecycle & inference pipeline
├── icon_render.py          # Shared macOS squircle icon renderer
├── static/
│   ├── index.html          # 3-column studio workspace
│   ├── styles.css          # Stylesheet
│   ├── state.js            # Shared state, tab model & helpers
│   ├── stage.js            # Split view, pan/zoom & loupe rendering
│   ├── export.js           # Canvas export pipeline & ZIP writer
│   ├── preferences.js      # Hardware status, cache dots & preferences
│   ├── batch.js            # Batch queue, panel & runner
│   ├── tabs.js             # Tab bar, ingestion & segmentation lifecycle
│   └── app.js              # Event wiring, menus & native bridge
├── scripts/
│   ├── build_release.py    # Builds .dmg / .zip / .tar.gz into dist/
│   └── make_dev_bundle.py  # Generates the venv-local OpenBGR.app for dev runs
├── Start Mac.command       # macOS Finder launcher
├── start.sh                # macOS / Linux bootstrapper
├── start.bat               # Windows bootstrapper
└── requirements.txt        # Python dependencies
```

## Building Desktop Releases (`.dmg` / `.exe` / Linux)

To build lightweight desktop release bundles locally into `dist/`:

```bash
python3 scripts/build_release.py
```

Pushing a version tag (e.g. `git tag v0.01 && git push origin v0.01`) triggers `.github/workflows/release.yml` to build and attach `OpenBGR-macOS.dmg`, `OpenBGR-Windows.zip`, and `OpenBGR-Linux.tar.gz` to a GitHub Release automatically.

## License

[MIT](./LICENSE)
