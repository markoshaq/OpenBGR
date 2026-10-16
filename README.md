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
- **Six Specialized BiRefNet Models** — Switch between `Lite` (fast CPU/iGPU), `General` (default all-round Swin-L), `Ultra HR` (2K detail), `Portrait` (people & flyaway hair), `Matting` (2K soft alpha for glass, smoke & sheer fabric), and `Dynamic` (preserves native aspect ratio up to 2K without square distortion).
- **Edge & Reflection Refinement** — Edge defringing removes background color bleed along hair and soft borders, color-spill suppression cleans rim reflections, and a shadow/reflection alpha cutoff floors out floor shadows at export.
- **Live Export Preview** — Export as `PNG`, `WEBP`, `JPG`, or an 8-bit `Alpha Mask` at any scale (`10%–200%`) or custom pixel dimensions (`W × H`), rendered live on `<canvas>` without re-running inference.
- **Export Destinations** — Set a per-tab output folder for one-click exports, or leave it unset for a native Save-As dialog (browser downloads in fallback mode).
- **Zoom, Pan & 4× Loupe** — Pinch-to-zoom (`100%–800%`) with two-finger trackpad panning, plus a toggleable 4× circular magnifier loupe (`Z` key) for inspecting hair strands and edges — works before and after processing.
- **Native Desktop Window** — Opens in a standalone native OS window via `pywebview` (with native menus, clipboard, Save dialogs, and automatic browser fallback).
- **Model Storage Management** — Right-click any model button (or open `⌘,` → MODELS) to see exact on-disk size per checkpoint and uninstall weights you don't need; uninstalled models re-download on next use.
- **Hardware Acceleration** — Runs in `FP16` half-precision on CUDA and Apple MPS (cutting memory usage in half and speeding up inference ~5×), and automatically evicts inactive models from memory when switching models.

## Models

| Model | Checkpoint | Backbone | Native Resolution | FP16 Size | Best For |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Lite** (`lite`) | `ZhengPeng7/BiRefNet_lite` | Swin-T | `1024 × 1024` | ~85–170 MB | Quick batches, CPUs & integrated graphics |
| **General** (`general`, *Default*) | `ZhengPeng7/BiRefNet` | Swin-L | `1024 × 1024` | ~424 MB | Products, objects, animals & everyday photos |
| **Ultra HR** (`hr`) | `ZhengPeng7/BiRefNet_HR` | Swin-L | `1536` / `2048` | ~424 MB | 4K/8K studio photos & micro-edge detail |
| **Portrait** (`portrait`) | `ZhengPeng7/BiRefNet-portrait` | Swin-L | `1024 × 1024` | ~424 MB | People, headshots, flyaway hair & eyelashes |
| **Matting** (`matting`) | `ZhengPeng7/BiRefNet_HR-matting` | Swin-L | `1536` / `2048` | ~424 MB | Glass, smoke, veils, sheer fabric & soft alpha |
| **Dynamic** (`dynamic`) | `ZhengPeng7/BiRefNet_dynamic` | Swin-L | Up to `2048` (native ratio) | ~424 MB | Ultrawide panoramas & tall vertical banners |

Output masks are always upsampled (`LANCZOS`) back to the exact pixel dimensions of the source image. Any FP32 checkpoint downloaded from Hugging Face is automatically compacted to FP16 on disk.

Weights download on first use of each model into the standard Hugging Face cache (`~/.cache/huggingface`) — only for the models you actually run.

## API

You can also call the FastAPI server directly:

```bash
curl -X POST "http://127.0.0.1:7860/api/remove-bg" \
  -F "file=@photo.jpg" \
  -F "tier=general" \
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

Pushing a version tag (e.g. `git tag v0.02 && git push origin v0.02`) triggers `.github/workflows/release.yml` to build and attach `OpenBGR-macOS.dmg`, `OpenBGR-Windows.zip`, and `OpenBGR-Linux.tar.gz` to a GitHub Release automatically.

> **macOS Gatekeeper note:** Because release builds are ad-hoc signed rather than Apple-notarized, macOS may prompt on first launch when opening `OpenBGR.app` from a downloaded `.dmg`. Right-click `OpenBGR.app` → **Open** (once), or run `xattr -cr /Applications/OpenBGR.app`.

## License

[MIT](./LICENSE)
