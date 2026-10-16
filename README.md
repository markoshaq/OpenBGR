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

- **100% Offline After Setup** — Model weights are downloaded once from Hugging Face and loaded strictly from local cache (`local_files_only=True`) on future runs. No uploads, no telemetry, no accounts, no subscriptions.
- **Welcome Splash** — The empty workspace doubles as a splash screen showing the app version, detected compute engine, privacy guarantees, and platform-adapted shortcuts (`⌘` on macOS, `CTRL` on Windows/Linux).
- **Multi-Tab Workspace** — Open several images as tabs, work on them independently, and drag one tab onto another to merge them into a batch — like folders. Zoom and pan are remembered per tab.
- **Batch Processing** — Batch tabs queue any number of images under one shared settings snapshot, with per-file status, drag-out extraction, direct folder export (or a single ZIP in browser mode), and per-file failure recovery.
- **Six Specialized BiRefNet Models** — Switch between `Lite` (fast CPU/iGPU), `General` (default all-round Swin-L), `Ultra HR` (2K detail), `Portrait` (people & flyaway hair), `Matting` (2K soft alpha for glass, smoke & sheer fabric), and `Dynamic` (preserves native aspect ratio up to 2K without square distortion).
- **Live Edge Filters** — Defringe and color-spill suppression are classical post-processing passes, not extra inference. Toggling either re-composes the cached result via `POST /api/refine` in ~100 ms instead of re-running the network; stale jobs are rejected with HTTP 409.
- **Edge & Reflection Refinement** — Edge defringing removes background color bleed along hair and soft borders, color-spill suppression cleans rim reflections, and a shadow/reflection alpha cutoff floors out floor shadows at export.
- **Live Export Preview** — Export as `PNG`, `WEBP`, `JPG`, or an 8-bit `Alpha Mask` at any scale (`10%–200%`) or custom pixel dimensions (`W × H`), rendered live on `<canvas>` without re-running inference.
- **Export Destinations** — Set a per-tab output folder for one-click exports, or leave it unset for a native Save-As dialog (browser downloads in fallback mode).
- **Zoom, Pan & 4× Loupe** — Pinch-to-zoom and two-finger trackpad panning (`100%–800%`), plus a toggleable 4× circular magnifier loupe (`Z` key) for inspecting hair strands and edges — works before and after processing.
- **Native Desktop Window** — Opens in a standalone native OS window via `pywebview` (with native menus, clipboard, Save dialogs, per-monitor window-state restore, and automatic browser fallback).
- **Model Storage Management** — Right-click any model card (or open `⌘,` → MODELS) for `Install (size)` / `Uninstall (size)` per checkpoint, open the Hugging Face cache folder in the system file manager, and see total disk usage split between app files and model weights. Uninstalled models re-download on next use.
- **System Info** — The Settings → SYSTEM pane reports the detected compute engine (`CUDA` / `MPS` / `CPU`), inference precision (`FP16`/`FP32`), total RAM, and app version.
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

## Right-Click / "Open With" Integration

OpenBGR can be wired into your OS file manager — everything stays 100% local (the cutout is written next to the original as `<name>-cutout.png`; nothing is uploaded).

**macOS** — Finder Quick Action (right-click → Quick Actions → *Remove Background with OpenBGR*):

```bash
python3 scripts/install_macos_quick_action.py     # --remove to uninstall
```

The release `OpenBGR.app` also registers itself as an "Open With" target for image files — right-click → Open With → OpenBGR launches the app with the image loaded in a tab. (Drag onto the Dock icon works too.)

**Windows** — Explorer context menu (per-user registry entries, no admin):

```bat
scripts\install_windows_context_menu.bat           :: uninstall: uninstall_windows_context_menu.bat
```

Adds *Remove background with OpenBGR* (headless cutout) and *Open in OpenBGR*.

**Linux**:

```bash
./scripts/install_linux_integration.sh            # --remove to uninstall
```

Installs an "Open With" `.desktop` entry, a KDE Dolphin service-menu action, and a GNOME Files (Nautilus) script.

**CLI** — the same pipeline is available directly:

```bash
python app.py --cli photo.png                      # writes photo-cutout.png
python app.py --cli a.png b.png -o ~/cutouts       # batch to a directory
python app.py --cli photo.png -o                   # native Save-As dialog
python app.py --cli photo.png --tier portrait      # pick a model preset
python app.py photo.png                            # open app with image loaded
```

When an OpenBGR window is already running, the context-menu action reuses it over localhost (model is warm → near-instant); otherwise it runs `app.py --cli` standalone (~10–20 s cold start while torch + the model load).

### Headless / CLI-Only Install (no GUI)

For scripts, servers, or users who never want a window — same local pipeline, same privacy guarantees:

```bash
git clone https://github.com/markoshaq/OpenBGR.git && cd OpenBGR
./start.sh --cli photo.png      # one-time setup: provisions .venv + model, writes photo-cutout.png
python3 scripts/install_macos_quick_action.py   # optional: registers the right-click entry
```

(On Windows use `start.bat` and `scripts\install_windows_context_menu.bat`; on Linux `./scripts/install_linux_integration.sh`.)

`start.sh --cli` provisions the environment itself, so this works on a fresh clone. Afterwards use `python app.py --cli` / `--quick-action` from your own scripts — `--quick-action` applies the saved Quick Action preferences (model, format, destination, clipboard, notification), while `--cli` takes explicit flags. It still needs the same torch + model download (~1.5 GB); the difference is that no window, browser, or server is ever opened.

## API

You can also call the FastAPI server directly:

```bash
curl -X POST "http://127.0.0.1:7860/api/remove-bg" \
  -F "file=@photo.jpg" \
  -F "tier=general" \
  -F "defringe=true" \
  -o photo-cutout.png
```

Other endpoints: `GET /api/status` (version, device, RAM, per-model cache state), `POST /api/refine` (re-apply edge filters to the cached job without re-inference), `POST /api/models/install` / `/api/models/uninstall` (checkpoint management), `POST /api/save` (write to a chosen folder), `POST /api/open-cache-dir` (reveal the HF cache in the OS file manager), `POST /api/cancel` (abort the active job), and `GET/POST /api/quick-action-config`, `POST /api/quick-action`, `POST /api/quick-action-install` (Quick Action settings, execution, and OS integration).

## Tests

```bash
python -m unittest discover -s tests -v
```

The suite covers the status contract, refine endpoint, save sanitization, FP16 compaction, the edge-refinement pipeline, end-to-end segmentation with a mocked model, CLI & Quick Action runners, the desktop bridge, frontend DOM/module integrity, icon geometry, and release-archive contents. CI runs the same suite on CPU-only PyTorch for every push and pull request (`.github/workflows/release.yml`).

## Development

The project ships a `pyproject.toml` configured for [Ruff](https://docs.astral.sh/ruff/) and [mypy](https://mypy.readthedocs.io/):

```bash
pip install ruff mypy
ruff check . && ruff format --check .   # lint
mypy app.py openbgr                     # type-check
```

## Project Layout

```text
├── app.py                  # Entrypoint (CLI / Quick Action / desktop launcher & re-exports)
├── openbgr/
│   ├── config.py           # Runtime paths, hardware auto-detection & model tier registry
│   ├── models.py           # Thread-safe ModelManager, HF cache inspection & FP16 compaction
│   ├── pipeline.py         # Defringe, color-spill suppression, RGBA composition & segmentation
│   ├── quick_action.py     # OS Quick Action config, native dialogs, notifications & CLI runner
│   ├── desktop.py          # Native pywebview bridge (DesktopApi), window state & Cocoa menus
│   └── api.py              # FastAPI application and HTTP endpoints
├── icon_render.py          # Shared macOS squircle icon renderer
├── pyproject.toml          # Project metadata, ruff & mypy configuration
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
│   ├── make_dev_bundle.py  # Generates the venv-local OpenBGR.app for dev runs
│   ├── context_process.sh  # Headless cutout helper (server fast-path → --cli fallback)
│   ├── install_macos_quick_action.py      # Finder "Remove Background" Quick Action
│   ├── install_windows_context_menu.bat   # Explorer right-click entries (HKCU)
│   ├── uninstall_windows_context_menu.bat
│   └── install_linux_integration.sh       # .desktop / KDE / Nautilus entries
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
