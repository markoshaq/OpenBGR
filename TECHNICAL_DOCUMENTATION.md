# OpenBGR — Technical Documentation

A complete developer-oriented reference for the codebase. The [README](./README.md)
covers features and usage; this document explains **how everything works internally**.

---

## Table of Contents

1. [What This Project Is](#1-what-this-project-is)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Repository Layout](#3-repository-layout)
4. [Backend: `app.py`](#4-backend-apppy)
   - 4.1 [Startup Configuration & Constants](#41-startup-configuration--constants)
   - 4.2 [Hardware Detection & Auto-Tuning](#42-hardware-detection--auto-tuning)
   - 4.3 [Model Registry (`MODELS` / `TIERS`)](#43-model-registry-models--tiers)
   - 4.4 [Model Lifecycle (`ModelManager`)](#44-model-lifecycle-modelmanager)
   - 4.5 [Inference Pipeline (`segment_foreground`)](#45-inference-pipeline-segment_foreground)
   - 4.6 [Edge Post-Processing (Defringe / Despill)](#46-edge-post-processing-defringe--despill)
   - 4.7 [The Refine Cache (`_LAST_JOB`)](#47-the-refine-cache-_last_job)
   - 4.8 [HTTP API Reference](#48-http-api-reference)
   - 4.9 [Desktop Bridge (`DesktopApi` / pywebview)](#49-desktop-bridge-desktopapi--pywebview)
   - 4.10 [Native Window, Menus & Persistence](#410-native-window-menus--persistence)
   - 4.11 [Process Entry Point & Signal Handling](#411-process-entry-point--signal-handling)
5. [Frontend: `static/`](#5-frontend-static)
   - 5.1 [`index.html` — DOM Skeleton](#51-indexhtml--dom-skeleton)
   - 5.2 [`state.js` — Shared State & Tab Model](#52-statejs--shared-state--tab-model)
   - 5.3 [`tabs.js` — Tab Lifecycle & Segmentation](#53-tabsjs--tab-lifecycle--segmentation)
   - 5.4 [`batch.js` — Batch Queue](#54-batchjs--batch-queue)
   - 5.5 [`export.js` — Canvas Export Pipeline & ZIP Writer](#55-exportjs--canvas-export-pipeline--zip-writer)
   - 5.6 [`stage.js` — Viewport Rendering](#56-stagejs--viewport-rendering)
   - 5.7 [`preferences.js` — Settings & Hardware Status](#57-preferencesjs--settings--hardware-status)
   - 5.8 [`app.js` — Event Wiring & `window.openBGR` Bridge](#58-appjs--event-wiring--windowopenbgr-bridge)
   - 5.9 [`styles.css`](#59-stylescss)
6. [End-to-End Data Flows](#6-end-to-end-data-flows)
7. [Concurrency & Cancellation Model](#7-concurrency--cancellation-model)
8. [Persistence & On-Disk State](#8-persistence--on-disk-state)
9. [Build & Release System](#9-build--release-system)
10. [Testing](#10-testing)
11. [Environment Variables & Runtime Knobs](#11-environment-variables--runtime-knobs)
12. [Contributor Gotchas & Design Notes](#12-contributor-gotchas--design-notes)

---

## 1. What This Project Is

**OpenBGR** is a self-hosted, offline-capable background-removal desktop app.
It wraps the [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) family of
dichotomous-image-segmentation models in a local FastAPI server plus a single-page
web "studio" UI, which is hosted inside a native OS window via `pywebview`
(with automatic fallback to a chromeless browser window).

- **No framework frontend** — the UI is hand-written HTML/CSS + vanilla ES modules.
- **No bundler, no Node** — `index.html` loads `app.js` as `<script type="module">`.
- **One Python file backend** — `app.py` (~2,200 lines) contains the entire server:
  model management, inference, post-processing, REST API, desktop bridge, and the
  native-window boot sequence.
- **Privacy-first** — after a one-time weight download per model, all inference is
  strictly local (`local_files_only=True` is attempted first on every load).
- Version: `0.02` (`APP_VERSION` in `app.py`, also embedded in the macOS `Info.plist`).

### Dependency stack (`requirements.txt`)

| Layer | Packages |
|---|---|
| Inference | `torch`, `torchvision`, `transformers` (`AutoModelForImageSegmentation`), `timm`, `kornia`, `einops` |
| Math/IO | `numpy` (via torch), `scipy`, `pillow` |
| Server | `fastapi`, `uvicorn`, `python-multipart` (multipart form uploads) |
| Desktop | `pywebview` (native window + JS↔Python bridge) |
| Hub | `huggingface-hub` (`snapshot_download`, `try_to_load_from_cache`) |

`app.py` also carries a PEP 723 inline script header (`# /// script … # ///`) so it
can technically be run with `uv run app.py` without a pre-made venv.

---

## 2. High-Level Architecture

```
┌────────────────────────────────────────────────────────────┐
│  OS process: python app.py                                 │
│                                                            │
│  Main thread                    Daemon thread              │
│  ┌──────────────────────┐      ┌────────────────────────┐  │
│  │ pywebview Cocoa/GTK/ │      │ uvicorn (127.0.0.1:7860)│  │
│  │ WebView2 event loop  │      │ FastAPI app            │  │
│  │  · native window     │      │  · /api/* REST routes  │  │
│  │  · native menu bar   │      │  · /static/* assets    │  │
│  │  · window.pywebview  │      │  · ModelManager        │  │
│  │    .api JS bridge    │      │  · inference lock      │  │
│  └─────────┬────────────┘      └───────────┬────────────┘  │
│            │ JS eval / JS API calls        │ HTTP fetch    │
│            ▼                               ▼               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ WebView: static/index.html + 7 ES modules            │  │
│  │   state · tabs · batch · export · stage · prefs · app│  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
  ~/.openbgr/                 ~/.cache/huggingface/hub
  (icon.png, window.json)     (BiRefNet checkpoints, FP16-compacted)
```

Key consequences of this topology:

- The **frontend talks to Python two ways**: REST (`fetch("/api/…")`) for inference
  and file writes, and `window.pywebview.api.*` for native-only capabilities
  (file dialogs, clipboard, fullscreen). Every native call has a browser fallback.
- **Inference is serialized** behind `MANAGER.inference_lock` — one forward pass at
  a time, since each model occupies hundreds of MB of device memory.
- `webview.start()` parks the main thread in the OS run loop, so signal handling
  needs a `set_wakeup_fd` watchdog (see §4.11).

---

## 3. Repository Layout

```text
├── app.py                    # Entire backend: FastAPI, model lifecycle, desktop bridge
├── icon_render.py            # Shared Pillow renderer for the squircle app icon
├── requirements.txt          # Python deps (mirrored in app.py's PEP 723 header)
├── static/
│   ├── index.html            # Single-page studio DOM (~890 lines)
│   ├── styles.css            # Full stylesheet incl. light theme & checkerboard
│   ├── state.js              # Shared state object, prefs schema, tab factory, DOM registry
│   ├── stage.js              # Split-view geometry, zoom/pan transform, 4× loupe
│   ├── export.js             # Canvas export renderer, live preview, store-only ZIP
│   ├── preferences.js        # Settings modal, /api/status sync, model install/uninstall UI
│   ├── batch.js              # Batch tab model, panel UI, sequential runner
│   ├── tabs.js               # Tab bar, image ingestion, runSegmentation, refine
│   └── app.js                # Entry point: all event wiring + window.openBGR bridge
├── scripts/
│   ├── build_release.py      # Builds dist/OpenBGR-{macOS.dmg,Windows.zip,Linux.tar.gz}
│   └── make_dev_bundle.py    # macOS dev-mode OpenBGR.app inside .venv for Dock icon
├── tests/test_openbgr.py     # unittest suite (API contracts, pipeline, packaging)
├── .github/workflows/release.yml  # CI: test + per-OS builds + tag-triggered GitHub Release
├── start.sh                  # macOS/Linux zero-config bootstrapper (venv + uv provisioning)
├── start.bat                 # Windows equivalent
├── Start Mac.command         # Double-clickable Finder launcher → start.sh
├── dist/                     # Build outputs (gitignored)
└── LICENSE                   # MIT
```

`__pycache__/`, `.venv/`, and `dist/` are local artifacts; `.venv/` is created by
the start scripts and marked ready via the `.venv/.installed` sentinel file.

---

## 4. Backend: `app.py`

The file is organized in clearly bannered sections; below is each one.

### 4.1 Startup Configuration & Constants

- **`os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"`** is set *before* importing
  torch, so any MPS-unimplemented op silently falls back to CPU instead of crashing.
- `torch.set_num_threads(min(8, cpu_count))` caps intra-op CPU parallelism.
- `IMAGENET_MEAN` / `IMAGENET_STD` are the normalization constants BiRefNet's
  Swin backbones expect.
- `BASE_DIR` / `STATIC_DIR` resolve the repo root; `APP_VERSION = "0.02"`.

**RAM probing** — `get_host_ram_gb()` detects physical RAM via `sysctl hw.memsize`
(macOS), `GlobalMemoryStatusEx` via ctypes (Windows), or `sysconf` (POSIX fallback),
defaulting to 16 GiB. `get_system_memory_gb()` prefers CUDA VRAM when a GPU exists.

**`HR_RESOLUTION`** — the "2K" models (`hr`, `matting`, `dynamic`) actually run at
`2048` only when the system has ≥ 14 GiB of (V)RAM; otherwise they drop to `1536`
because a 2048² forward pass allocates >6 GB of attention feature pyramids and
would thrash swap on 8 GB machines.

### 4.2 Hardware Detection & Auto-Tuning

- `detect_compute_device()` picks `cuda` → `mps` → `cpu` in that order.
- `format_device_label()` produces UI strings like `MPS / Apple M4 Pro` or
  `CUDA / NVIDIA …`.
- `DTYPE` is `float16` on `mps`/`cuda` (≈50 % memory, ~5× faster), `float32` on CPU.
- `select_recommended_tier()` — startup default: CPU → `lite`; CUDA with ≥16 GB
  VRAM → `hr`; everything else → `general`.

### 4.3 Model Registry (`MODELS` / `TIERS`)

`MODELS` maps 6 canonical keys to Hugging Face repos (all `ZhengPeng7/BiRefNet*`):

| Key | Repo | Backbone | Native res | Notes |
|---|---|---|---|---|
| `lite` | `BiRefNet_lite` | Swin-T | 1024² | CPU/iGPU-friendly |
| `general` | `BiRefNet` | Swin-L | 1024² | Default all-rounder |
| `hr` | `BiRefNet_HR` | Swin-L | `HR_RESOLUTION` | 4K/8K detail |
| `portrait` | `BiRefNet-portrait` | Swin-L | 1024² | Hair/eyelashes |
| `matting` | `BiRefNet_HR-matting` | Swin-L | `HR_RESOLUTION` | Soft alpha (glass, smoke) |
| `dynamic` | `BiRefNet_dynamic` | Swin-L | up to `HR_RESOLUTION` | Aspect-preserving input |

`TIERS` adds UI metadata per key (`label`, `sublabel`, `expected_bytes`,
`resolution`, `dynamic`, `description`) — it is the contract serialized into
`/api/status`. `TIER_ALIASES` + `normalize_tier_key()` keep backward compatibility
with the legacy preset names `low/mid/full/high` (frontend mirrors this).

Two preprocessing helpers:

- `get_preprocess_transform(resolution)` — caches a torchvision `Compose`
  (bilinear resize → tensor → ImageNet normalize) per `(h, w)` in `_TRANSFORM_CACHE`.
- `compute_dynamic_size(w, h, max_side)` — for `dynamic` only: scales so the long
  side ≤ `max_side` (and ≥ 512), clamps to `[256, max_side]`, rounds both axes to
  **multiples of 32** (required by Swin's 4-stage window/patch hierarchy).

Cache utilities:

- `get_model_cache_dir(repo_id)` → `HF_HUB_CACHE/models--org--name`.
- `get_model_disk_bytes(repo_id)` — recursive on-disk size.
- `is_model_cached_locally(repo_id)` — checks `model.safetensors` via
  `try_to_load_from_cache` **without network**.
- `compact_model_cache_fp16(repo_id)` — rewrites an FP32 `model.safetensors` in
  the HF cache to FP16 in place (halves e.g. portrait's 844 MB download), preserving
  safetensors metadata; returns bytes saved; no-op when already FP16.

### 4.4 Model Lifecycle (`ModelManager`)

Singleton (`MANAGER`) holding at most **one resident model**:

- `_lock` guards load/evict; `inference_lock` serializes forward passes.
- `cancel_epoch` is a monotonic counter: `request_cancel()` bumps it;
  `check_cancelled(job_epoch)` raises `InterruptedError` in any job started before
  the bump. This gives cooperative cancellation across queued and in-flight work.
- `flush_device_memory()` = `gc.collect()` + `torch.mps.empty_cache()` /
  `torch.cuda.empty_cache()`.
- `get_or_load(model_key)`:
  1. Fast path if already active.
  2. Evicts the old backbone and flushes before allocating.
  3. Loads via `AutoModelForImageSegmentation.from_pretrained(repo,
     trust_remote_code=True, local_files_only=True)`; on cache miss retries with
     `local_files_only=False` (one-time download), then `compact_model_cache_fp16`.
  4. Moves to `DEVICE`/`DTYPE`, sets `.eval()`, records `active_model_key`.

`lifespan()` (FastAPI lifespan hook) preloads the recommended model in a daemon
thread **only if already cached**, and unloads on shutdown.

### 4.5 Inference Pipeline (`segment_foreground`)

Called via `asyncio.to_thread` so the event loop stays responsive. Steps:

1. Snapshot `job_epoch`; resolve tier (`matting=True` flag overrides `tier`).
2. Acquire `MANAGER.inference_lock`; check-cancel → `get_or_load` → check-cancel.
3. `ImageOps.exif_transpose` the source, capture `(orig_w, orig_h)`, convert RGB.
4. Build input tensor with the cached transform — `(h, w)` from
   `compute_dynamic_size` for `dynamic`, else square `resolution`.
5. `torch.no_grad()` forward → take `outputs[-1]` → `sigmoid` → `.float().cpu()`.
   All GPU tensors are explicitly `del`eted in a `finally` immediately after.
6. Upsample the mask to exact source dimensions (`LANCZOS`) → `uint8` alpha.
7. Snapshot `{id, rgb, alpha}` into `_LAST_JOB` (see §4.7).
8. `compose_rgba` applies defringe/despill and returns a PIL RGBA image plus
   `elapsed_ms`, the tier config, and `job_id`.

### 4.6 Edge Post-Processing (Defringe / Despill)

Both are pure NumPy + Pillow C filters (milliseconds, no NN):

- **`decontaminate_edge_colors(rgb, alpha)`** — in the semi-transparent band
  `0.03 < α < 0.94` (hair strands, soft borders), compositing `I = αF + (1−α)B`
  leaves background bleed. A 5×5 `MaxFilter` dilation + 3×3 `BoxBlur` propagates
  solid-foreground color outward; edge pixels blend toward it proportionally to
  transparency (`blend_strength = (1 − fg_weight) * 0.65`).
- **`suppress_color_spill(rgb, mask_pil, alpha_norm)`** — kills rim reflections:
  1. Estimate a spatially-varying local background color by box-blurring
     background pixels (`α < 0.15`, radius 24), falling back to the global median.
  2. Build a receiver weight from the eroded solid rim (`MinFilter(15)`) and
     translucent regions.
  3. Project each pixel's chroma (`RGB − luma`) onto the local background's
     chroma; subtract only *positive* alignment — luminance is untouched, so
     sharpness survives.
- **`compose_rgba`** chains the two and `dstack`s RGB+alpha into the output image.

### 4.7 The Refine Cache (`_LAST_JOB`)

A single-slot cache (`_LAST_JOB`, guarded by `_LAST_JOB_LOCK`) storing the last
completed job's **raw** RGB + alpha and a monotonic `job_id` (`_JOB_ID_SEQ`).

`/api/refine` re-runs `compose_rgba` with different defringe/despill flags in ~20 ms
— that's why toggling those buttons in the UI is instant. A `job_id` that isn't the
latest returns **409**, which the frontend surfaces as "REPROCESS TO APPLY".

### 4.8 HTTP API Reference

All under `app = FastAPI(title="OpenBGR — Local Background Removal Studio")`.

| Method & path | Handler | Contract |
|---|---|---|
| `GET /` | `serve_index` | `static/index.html` |
| `GET /favicon.ico` | `serve_favicon` | `~/.openbgr/icon.png` or 204 |
| `GET /static/*` | `StaticFiles` mount | JS/CSS/etc.; `no-cache` middleware on `/` and `/static/` |
| `GET /api/status` | `api_status` | `{device, device_label, precision, ram_gb, ram_label, recommended_tier, active_model, version, total_cache_bytes, app_size_bytes, total_disk_bytes, cache_dir, tiers{key→{…cfg, cached, active, size_bytes}}, matting}` |
| `POST /api/remove-bg` | `api_remove_bg` | Form: `file`, `tier` (default `general`), `defringe`, `despill`, `matting`. Returns PNG bytes + headers `X-Inference-Time-Ms`, `X-Tier-Used`, `X-Device`, `X-Image-Width/Height`, `X-Refine-Job-Id`. Errors: 400 invalid/undecodable input, 499 cancelled, 500 pipeline failure. |
| `POST /api/refine` | `api_refine` | Form: `job_id`, `defringe`, `despill`. Returns re-composited PNG; **409** if `job_id` isn't the latest job. |
| `POST /api/cancel` | `api_cancel` | Bumps `cancel_epoch`; `{cancelled, epoch}` |
| `POST /api/save` | `api_save` | Form: `directory`, `filename`, `file`. Writes into an existing dir; filename is sanitized to basename; collisions auto-rename `-1, -2, …` |
| `POST /api/models/install` | `api_install_model` | Form: `target`. `snapshot_download` + FP16 compaction in a thread; returns refreshed `status`. |
| `POST /api/models/uninstall` | `api_uninstall_model` | Form: `target` (`all` allowed). 409 while inference runs; unloads active model; deletes HF cache dir + `.locks` entry; `matting` also removes the legacy `BiRefNet-matting` cache; returns `freed_bytes` + refreshed `status`. |
| `POST /api/open-cache-dir` | `api_open_cache_dir` | Opens HF cache in the OS file manager. |

Disk-usage helpers `_dir_tree_bytes` (scandir-based, symlink-safe) and
`get_app_disk_bytes` (repo incl. `.venv`, minus `.git`/`dist`, plus `~/.openbgr`;
60 s cache) feed `api_status`.

### 4.9 Desktop Bridge (`DesktopApi` / pywebview)

Exposed to JS as `window.pywebview.api` only in the native window. Every method is
defensive (returns `{cancelled}`/`{error}` dicts rather than raising):

- `open_image_dialog()` — native multi-select Open dialog; returns files as
  base64 (`OPEN_DIALOG_MAX_BYTES = 48 MB` cap per file).
- `save_file(data_base64, default_filename)` — native Save-As → writes bytes.
- `choose_output_dir()` — native folder picker for per-tab export destinations.
- `copy_image(data_base64)` — PNG to OS clipboard: `NSPasteboard` (macOS),
  `System.Windows.Forms.Clipboard` on an STA thread (Windows), `wl-copy`/`xclip`
  (Linux).
- `read_clipboard_image()` — `PIL.ImageGrab.grabclipboard()` (image or image file
  path), plus `wl-paste`/`xclip` on Linux.
- `toggle_fullscreen()`, `open_external(url)` (http/https only),
  `open_cache_dir()`, `set_window_theme(theme)` (macOS `NSAppearance` Aqua/DarkAqua
  via `AppHelper.callAfter`), and `quit()` (cancel + destroy window).

Dialog-mode resolution goes through `_dialog_mode` to support both the
`webview.FileDialog.OPEN` enum style and the legacy `OPEN_DIALOG` constants.

### 4.10 Native Window, Menus & Persistence

- `APP_CONFIG_DIR = ~/.openbgr`; `window.json` (geometry) and `icon.png` live there.
- `ensure_app_icon()` regenerates the icon via `icon_render.render_icon(512)` when
  missing or older than `icon_render.py` (mtime-based cache invalidation).
- `load_window_state` / `attach_window_state_persistence` — debounced (400 ms
  `threading.Timer`) save of `x/y/width/height` on move/resize events.
- `ensure_window_on_screen` — re-centers on the primary display if restored
  geometry lands off-screen (e.g. unplugged monitor), via `webview.screens`.
- `set_macos_app_name` — rewrites `NSProcessInfo` name + bundle `CFBundle*` keys so
  the menu bar shows "OpenBGR" instead of "Python".
- `build_native_menus(window)` — pywebview `Menu`/`MenuAction` tree (`__app__`,
  File, Edit, View, Model, Help). Actions are marshalled into JS through
  `window.evaluate_js("window.openBGR.<fn>()")`. Menu titles deliberately use `…`
  and `—` because Linux GTK `Gio.SimpleAction` treats `.`/`()` as GVariant params.
  Quit/Preferences are skipped in File on macOS (the `__app__` menu already hosts
  them); Windows skips native menus entirely (WinForms `MenuStrip` clashes with
  WebView2's `DockStyle.Fill`) and uses the in-app HTML menu bar instead.
- `configure_macos_native_window_and_menus` — on `shown`, walks the Cocoa
  `NSMenu` tree to attach `keyEquivalent`s (⌘T ⌘O ⌘B ⌘E ⌘W ⇧⌘C ⌘V ⌘1/2/3 ⌘+ ⌘− ⌘0
  ⌘R ⌃⌘F), rewires "About OpenBGR" to the in-app modal via
  `webview.platforms.cocoa.menu_handler.register_action`, sets DarkAqua window
  appearance, and disables WKWebView `setAllowsMagnification` so trackpad pinch
  reaches JS `GestureEvent`s.

### 4.11 Process Entry Point & Signal Handling

`__main__` sequence:

1. `_graceful_exit` + `_start_signal_watchdog` — normal Python signal handlers
   don't run while the main thread is inside Cocoa's run loop, so a daemon thread
   blocks on `select` over the `signal.set_wakeup_fd` pipe and hard-exits on
   SIGINT/SIGTERM/SIGHUP after cancelling inference and unloading the model.
2. `PORT` env (default **7860**), host `127.0.0.1`.
3. Three launch modes:
   - `NO_BROWSER=1` → headless API server.
   - `OPENBGR_BROWSER=1` → server + `open_fallback_app_window` (chromeless
     `--app=` window via Chrome/Brave/Edge/Chromium, else default browser).
   - Default → uvicorn on a daemon thread; `wait_for_server` polls the socket and
     `is_openbgr_server` verifies `GET /api/status` actually returns OpenBGR's
     shape (guards against a foreign service squatting on the port); then the
     pywebview window is created with persisted geometry (`min 980×640`,
     `background_color="#09090b"`, `js_api=DesktopApi()`), native menus + icon
     passed to `webview.start()`. Window close → cancel + unload + `os._exit(0)`.
   - pywebview failure → chromeless-browser fallback.

---

## 5. Frontend: `static/`

Vanilla ES modules loaded from `index.html` (`<script type="module"
src="/static/app.js">`). Module dependency graph:

```
app.js ─┬─▶ state.js
        ├─▶ stage.js ──▶ state.js
        ├─▶ export.js ──▶ state.js
        ├─▶ preferences.js ──▶ state.js
        ├─▶ batch.js ──▶ state.js, export.js, tabs.js
        └─▶ tabs.js ──▶ state.js, stage.js, export.js, preferences.js, batch.js
```

No build step; `no-cache` middleware keeps WebView assets fresh.

### 5.1 `index.html` — DOM Skeleton

Three-row shell inside `#appShell`:

1. **`.topbar`** — brand mark, the in-app menu bar (`#menuBar`, five `.menu-root`
   dropdowns: FILE/EDIT/VIEW/MODEL/HELP, items carry `data-cmd`, `data-requires`,
   `data-check`, `data-shortcut`), center view-mode segmented control + zoom
   cluster + `btnLoupe`, and a settings gear (`btnInfo`).
2. **`.studio-body`** — 3 columns:
   - **Left sidebar** (`sidebar-left`): Open button + hidden `#fileInput`
     (`accept="image/*" multiple`), the six-button model list `#tierSelector`
     (each `.tier-btn` has `data-tier`, tech label `tech-<key>`, status dot
     `dot-<key>`), `btnDefringe`/`btnDespill` toggle cards, `#shadowCutoffSlider`
     (0–75 %), matte backdrop swatches (`#matteSwatches` + `#colorPicker`), and
     `#btnProcess`.
   - **Center column**: `#tabBar`, then `#viewport` containing the empty-state
     dropzone/welcome splash, the split stage (`#stage` = `#stageSizerImg` sizing
     image + `#afterImg` result layer + `#beforeClip` clipped original layer +
     `#lblLeft`/`#lblRight` + `#splitLine`), the `#batchPanel` (header, `#batchList`,
     footer), `#loupeCanvas` (180 px), and `#busyOverlay` (progress bar +
     `#btnCancel`).
   - **Right sidebar** (`sidebar-right`): destination picker (`btnFileDest` /
     `fileDestPath`), format row (`#formatRow`: png/webp/jpg/mask), scale slider
     (10–200 %) + quick-scale buttons, custom W×H inputs (max 16384), and
     `#btnDownload` / `#btnCopy`.
3. **`.statusbar`** — `statFile` / `statDim` / `statTime` telemetry + credit link.

Modals: `#confirmModal` (generic 3-button confirm), `#tabContextMenu`, and
`#infoModal` — a 5-pane preferences dialog (`APPEARANCE`, `GENERAL`, `MODELS`,
`SYSTEM`, `ABOUT`; model rows have `sysdot-`/`syssize-`/`sysbtn-` IDs and
`data-model-key`/`data-uninstall-model` hooks).

An inline `<head>` script applies `theme`/`accent` from `localStorage` **before
first paint** to avoid a theme flash.

### 5.2 `state.js` — Shared State & Tab Model

- Constants: `TIER_KEYS`, `TIER_ALIASES`/`normalizeTierKey` (mirrors backend),
  `PRESET_NAMES`, `FORMAT_EXT`, `ACCENTS` (theme accent palettes),
  `DOT_TOOLTIPS` (cache-dot semantics: `ready`/`downloadable`/`unavailable`).
- **Prefs**: `getDefaultPrefs()` + `PREF_SCHEMA` validate `openbgr_prefs` in
  localStorage (`theme`, `accent`, `defaultTier`, `defaultFormat`,
  `defaultBackdrop`, `confirmClose`), with migration from the legacy
  `openbgr_confirm_close_tab` key.
- **`state`** — the single mutable workspace object: `tabs[]`, `activeTabId`,
  processing flags (`isProcessing`, `abortController`, `refineJobId`,
  `refineToken`, `previewRenderToken`), image fields (`sourceFile`, `resultBlob`,
  object URLs, `naturalWidth/Height`), export config (`exportFormat`, `outputDir`,
  `exportScale`, `exportWidth/Height`, `activeBackdrop`), view config (`viewMode`,
  `splitPercent`, `zoom/panX/panY`, `loupeEnabled`, `shadowCutoff`, `tier`,
  `defringe`, `despill`), `serverStatus`, `batch` runner state, and drag payloads
  (`dragTabId`, `dragBatchItem`).
- **`dom`** — a registry resolving every element ID once at module load.
- **Tab records** (`createTabRecord`) — `kind: "image" | "batch"`, all the same
  fields as `state` plus `batchFiles[]`. `saveStateToActiveTab()` copies global
  state back into the active record on every tab switch (per-tab isolation).
- Helpers: `masterCutoutImg` (off-DOM `Image` holding the decoded RGBA cutout for
  canvas export), `revokeTabUrls` (object-URL cleanup), `setError` (toast),
  `openConfirmModal`/`closeConfirmModal` (pending callbacks on `state`),
  `base64ToBlob`/`blobToBase64`, `filesFromDialogResult` (pywebview payloads →
  `File` objects), `downloadBlob`, `openExternalUrl` (native-aware).

### 5.3 `tabs.js` — Tab Lifecycle & Segmentation

- `renderTabBar()` — rebuilds tab DOM each switch; wires per-tab drag (`dragstart`/
  `dragover`/`drop` merge semantics), `contextmenu` → `showTabContextMenu`, close
  button, click-to-switch (with a confirm modal when processing), and the trailing
  `+` button. Batch tabs render as `BATCH (n)`. `showTabGhost`/`hideTabGhost`
  draw a phantom tab while dragging a batch row over the tab bar.
- `createBlankTab`, `requestCloseTab` (confirm-gated by `prefs.confirmClose`),
  `closeTabImmediate` (aborts in-flight work, revokes URLs, collapses to empty
  workspace when nothing content-bearing remains, activates neighbor tab).
- `switchToTab(tabId)` — the heart of per-tab isolation: save current → load all
  record fields into `state` → sync tier buttons, toggles, sliders, format,
  destination, backdrop, zoom → batch tabs route to `renderBatchPanel`; image tabs
  restore the stage, decode `masterCutoutImg`, and show either split view (has
  result) or original-only.
- `ingestImageFile(file)` — fills the current blank tab or creates a new record;
  sets the original image on stage and resets result/export fields.
- `selectTier`, `setViewMode`, `toggleLoupe`, `syncMenuBarState` (enables menu
  items via `data-requires` = `tab|image|result|processing` and checkmarks via
  `data-check`), `cancelProcessing` (aborts fetch + `POST /api/cancel` + batch
  flag).
- **`runSegmentation()`** — single-image flow: guards on cache/offline, aborts any
  prior job, sets busy overlay text (including "FETCHING MODEL WEIGHTS" when the
  checkpoint isn't local), POSTs `FormData` to `/api/remove-bg`, reads telemetry
  headers (incl. `X-Refine-Job-Id`), stores `resultBlob` + object URL, decodes
  `masterCutoutImg`, then `setViewMode("split")` + `syncServerStatus` refresh.
- **`applyEdgeRefinement()`** — POSTs `{job_id, defringe, despill}` to
  `/api/refine` with a `refineToken` guard against out-of-order responses; on 409
  sets status text "REPROCESS TO APPLY". This is what makes the defringe/despill
  toggles feel instant.

### 5.4 `batch.js` — Batch Queue

- **Ingestion**: `pickImageFiles` (native dialog → base64 Files, or
  `<input>` with `state.expectingBatch`), `openMultiFileChooser` (modal: batch vs.
  individual tabs), `createBatchTab`/`addFilesToBatchTab`,
  `requestBatch`/`requestBatchDispatch`.
- **Tab algebra**: `convertTabToBatch`, `mergeTabsIntoBatch` (drop tab on tab),
  `extractBatchItemToTab` (drag a row out), `moveBatchItemToBatch` (drag row onto
  another batch tab).
- **`renderBatchPanel`** — row per file: status dot + name + size + status label +
  remove button; statuses `queued → processing → done|failed`.
- **`runBatch(tab)`** — snapshots settings (`snap` = tier, filters, format, scale,
  dims, backdrop, cutoff) so mid-run UI changes can't corrupt the run; resolves
  `outputDir` (native folder picker if unset); sequentially POSTs each file to
  `/api/remove-bg`, converts via `buildBatchExportBlob`, then either
  `saveBatchFile` → `POST /api/save` (folder mode) or accumulates results for a
  `buildZip` download (`openbgr-cutouts.zip`, browser mode). Honors
  `batch.cancelled`; per-file failures mark the row and continue; ends with a
  summary modal and `tab.elapsedText` like `12/15 DONE`.

### 5.5 `export.js` — Canvas Export Pipeline & ZIP Writer

- **`renderExportBlob(source, srcW, srcH, opts)`** — offscreen canvas at target
  size; `mask` format turns alpha into an 8-bit grayscale PNG; `shadowCutoff`
  applies a rescaled alpha threshold (below cutoff → 0, above → linearly
  re-expanded) on an isolated fg buffer; JPG or non-checker backdrop composites
  onto `matteColor`; encodes via `canvas.toBlob` (PNG uncompressed, WebP/JPG
  q=0.95).
- `buildExportBlob` (fast path: returns `resultBlob` untouched for PNG/100%/
  checker/0-cutoff) and `buildBatchExportBlob` (custom W×H acts as an
  aspect-preserving bounding box).
- `updateLiveStagePreview` — re-renders the *preview* (`previewBlob`/
  `previewObjectUrl` → `afterImg.src`) on every format/scale/backdrop/cutoff
  change with a token guard; the stage shows exactly what export will produce.
- Destination plumbing: `updateDestUI` (hides folder picker in browsers),
  `chooseOutputFolder` → `pywebview.api.choose_output_dir`, `saveBatchFile` →
  `/api/save`.
- `updateExportTelemetry` — keeps the export button label (`EXPORT PNG` / `RUN
  BATCH`), scale labels, quick-scale active state, W×H inputs, `statDim`, and the
  right split-stage label in sync.
- `exportActiveImage` — filename `{base}-{cutout|mask}[-{W}x{H}].{ext}`; save order:
  `outputDir` → `/api/save`; else native `save_file` dialog; else `downloadBlob`.
- `copyActiveCutout` — PNG (or mask) to clipboard: native `copy_image`, else
  `navigator.clipboard.write` with `ClipboardItem`.
- **`buildZip`** — a dependency-free **STORED** (no compression) ZIP writer:
  local headers + CRC32 table + central directory + EOCD. STORE is correct here
  because PNG/WebP payloads are already compressed.

### 5.6 `stage.js` — Viewport Rendering

- `renderStageGeometry` — split view = `clip-path: inset(0 X% 0 0)` on the
  before-layer + split line position; `cutout` hides the original; `original`
  shows it full.
- `applyZoomTransform` / `setZoom` — CSS `translate+scale`, clamped to `[1, 8]`,
  resets pan at 1×, updates the zoom-readout button.
- `renderLoupeAtPointer` — 180 px, 4× circular magnifier painted on
  `#loupeCanvas` honoring checkerboard/solid backdrop and which side of the split
  the cursor is on.
- `handleSplitDrag` — pointer X → `splitPercent`.

### 5.7 `preferences.js` — Settings & Hardware Status

- `syncServerStatus` — `GET /api/status` → `state.serverStatus`; fills
  compute/precision/RAM/version labels; on first load picks `prefs.defaultTier`
  or the server's `recommended_tier`.
- `updateCacheIndicator` — drives every cache dot (`dot-*/sysdot-*`), per-model
  size labels (`syssize-*`), uninstall buttons (`sysbtn-*`), total disk usage
  (`modelsTotalSize` = `total_disk_bytes` = app + models), cache path, and the
  "UNINSTALL ALL" button.
- `installModel` / `uninstallModel` → `/api/models/install|uninstall` with busy
  guards (`state.isProcessing`, `installingModelKey`, `navigator.onLine`).
- `openCacheFolder` → native bridge, falling back to `/api/open-cache-dir`.
- `showModelContextMenu` — right-click menu on model rows/buttons: install or
  uninstall with size, plus "Manage Models in Settings…".
- `openPrefsDialog`/`selectPrefsPane` — section aliases (`models`, `about`, …) →
  pane IDs. `applyPreferences` — theme class, accent CSS vars, pref control
  states, and `pywebview.api.set_window_theme` sync.

### 5.8 `app.js` — Event Wiring & `window.openBGR` Bridge

Everything user-facing converges here:

- Connectivity `online`/`offline` → `updateCacheIndicator`.
- Tab-bar dropzone for batch-row extraction; global click dismisses context menus.
- Modal button wiring (confirm modal's pending confirm/alt callbacks; prefs modal
  panes, theme/accent/default selects, reset-defaults, per-model uninstall).
- Sidebar controls: tier buttons (click = select, right-click = model context
  menu), Process, defringe/despill (each flips state **and** calls
  `applyEdgeRefinement` for instant re-render), shadow-cutoff slider, view-mode
  segmented, zoom cluster, format buttons, destination picker, scale slider +
  quick buttons + custom W×H inputs (aspect-locked, 16384 cap), Export, Copy.
- Pointer model on the viewport: wheel pans (two-finger scroll) or zooms on
  `ctrlKey`/`metaKey` (trackpad pinch); WKWebView `gesturestart/change` pinch
  zooms relative to gesture start; double-click resets zoom; middle/right-button
  or Space+drag pans when zoomed; left-drag drives the split line (unless loupe);
  touch equivalents included.
- File ingress: native open dialog → `openMultiFileChooser`/`ingestImageFile`;
  `#fileInput` (with `expectingBatch` routing and `cancel` cleanup); window-level
  drag-and-drop (routes to active batch tab, multi-file chooser, or confirm-cancel
  ingest); paste via Clipboard API with `pywebview.api.read_clipboard_image`
  fallback.
- **`window.openBGR`** — the command surface both the in-app menu bar and the
  native pywebview menus call (`newTab`, `openImage`, `startBatch`, `exportImage`,
  `copyImage`, `closeActiveTab`, `pasteImage`, `setView`, `zoomIn/Out/Reset`,
  `toggleLoupe`, `toggleTheme`, `toggleFullscreen`, `selectPreset`,
  `toggleDefringe/Despill`, `rerunSegmentation`, `cancelProcessing`,
  `openSettings`, `openGithub`, `quitApp`). Native menus reach it through
  `window.evaluate_js`.
- Keyboard: `Esc` hierarchy (context menu → menus → modals → cancel processing →
  loupe), `F11` fullscreen, `Mod+T/O/E/S/W/B/,/R/1/2/3/0/=/-` , `Shift+Mod+C`,
  `Mod+Q`, `Z` loupe, `Space` pan modifier. The in-app menu bar IIFE rewrites
  shortcut labels to `Ctrl+…` off-Mac and dispatches `data-cmd` clicks.

### 5.9 `styles.css`

~2,200 lines, hand-authored. Notable internals: CSS custom-property theming
(`--accent`, `--accent-contrast`, `--checker-a/b`), `.theme-light` overrides,
`checkerboard-canvas` transparency grid, `.app-shell` state classes
(`no-image`, `no-result`, `batch-active`, `is-processing`) that drive conditional
UI (`.batch-hide`, `.requires-image`), the clipped before/after stage layers,
loupe/busy-overlay/modal/tab/menu styles, and the prefs dialog panes. It's pure
presentation — safe to restyle without touching logic.

---

## 6. End-to-End Data Flows

**Single image (native window):**

```
Open dialog (pywebview, base64) / drag-drop / paste / file input
  → ingestImageFile(File)            [new or reused tab record]
  → PROCESS IMAGE → runSegmentation()
      POST /api/remove-bg {file, tier, defringe, despill}
        → segment_foreground under inference_lock
          (EXIF orient → resize → BiRefNet → sigmoid alpha → LANCZOS upsample
           → snapshot _LAST_JOB → compose_rgba)
      ← PNG + X-* telemetry headers (incl. X-Refine-Job-Id)
  → masterCutoutImg decode → split view → live preview loop
  → EXPORT → buildExportBlob (canvas) → /api/save | native Save dialog | download
```

**Toggle refine filters:** button click → `applyEdgeRefinement` →
`POST /api/refine {job_id, …}` → re-composited PNG (409 if stale → "REPROCESS TO
APPLY").

**Batch:** files → `createBatchTab` → `runBatch` loops `/api/remove-bg` per file →
`buildBatchExportBlob` per result → `/api/save` each (folder mode) or one
`buildZip` download; per-file status rows update live; `/api/cancel` +
`AbortController` stop the loop.

---

## 7. Concurrency & Cancellation Model

- **One model in memory** (`ModelManager`); switching models evicts + flushes
  (`gc` + `empty_cache`).
- **One forward pass at a time** via `MANAGER.inference_lock` — cancel + new job
  can never overlap on the GPU, and a queued batch waits cleanly.
- **Cooperative cancellation**: `cancel_epoch` increments on `/api/cancel`;
  `check_cancelled` is called before load, after preprocess, after forward, and
  before compositing → raises `InterruptedError` → HTTP 499. The client also
  aborts its `fetch` via `AbortController`, so both ends stop.
- **Refine races** are handled by `refineToken`/`previewRenderToken` monotonic
  guards plus the server-side `job_id` freshness check.
- `get_app_disk_bytes` caches 60 s so `/api/status` stays sub-millisecond.
- Frontend de-dupes: `installingModelKey`, `state.isProcessing`, and
  `state.batch.running` gate every re-entrant operation.

---

## 8. Persistence & On-Disk State

| Location | Contents |
|---|---|
| `~/.cache/huggingface/hub` | BiRefNet checkpoints (auto-compacted to FP16), HF `.locks` |
| `~/.openbgr/` | `icon.png`, `window.json` (geometry), `venv/` + `openbgr.log` for release builds |
| `<repo>/.venv/` | dev environment; `.installed` sentinel marks setup complete |
| `localStorage.openbgr_prefs` | `{theme, accent, defaultTier, defaultFormat, defaultBackdrop, confirmClose}` |

Nothing else is written — no telemetry, no analytics, no outbound calls after
weight download.

---

## 9. Build & Release System

- **`scripts/make_dev_bundle.py`** — macOS-only: clones the framework's
  `Python.app` stub into `.venv/OpenBGR.app`, patches `Info.plist` (name/icon via
  `generate_macos_icns`), drops `pyvenv.cfg` + a `lib` symlink so the stub resolves
  the venv, ad-hoc re-signs. `start.sh` launches through it for a proper Dock icon.
- **`scripts/build_release.py`** — produces ~1 MB "thin" packages that bootstrap
  `~/.openbgr/venv` on first run:
  - macOS: `dist/OpenBGR.app` (payload under `Resources/app`, launcher script in
    `MacOS/`, `OpenBGR.icns`, `Info.plist`, ad-hoc `codesign`) → `hdiutil` →
    `OpenBGR-macOS.dmg` with `/Applications` symlink.
  - Windows: payload + a `csc.exe`-compiled `OpenBGR.exe` shim that runs
    `start.bat` → `OpenBGR-Windows.zip`.
  - Linux: payload + `OpenBGR.desktop` entry → `OpenBGR-Linux.tar.gz`.
- **`start.sh` / `start.bat` / `Start Mac.command`** — zero-config bootstrappers:
  reuse `.venv` if `.installed` exists; else provision Python 3.12 via `uv`
  (auto-installed if needed and no Python 3.10+); on Linux + `nvidia-smi` installs
  CUDA PyTorch from the cu124 index; then `pip install -r requirements.txt` and
  launch `app.py`.
- **CI** (`.github/workflows/release.yml`) — on push/PR/`v*` tags/manual: runs the
  unittest suite (CPU torch), builds all three packages in parallel matrix jobs,
  and publishes them to a GitHub Release on version tags.

---

## 10. Testing

`tests/test_openbgr.py` — run with `python -m unittest discover -s tests -v`.

- `test_version_and_status_contract` — `/api/status` schema, tier keys, alias
  normalization, `compute_dynamic_size` 32-alignment.
- `test_icon_squircle_geometry` — corner transparency + center opacity.
- `test_edge_refinement_pipeline` — defringe/despill/compose output shapes & alpha.
- `test_api_refine_endpoint` — seeds `_LAST_JOB`, verifies PNG + headers and the
  409 stale-job path.
- `test_api_save_sanitizes_and_renames_collisions` — path traversal stripped to
  basename, `-1` collision renaming.
- `test_api_uninstall_validation` — 400s on unknown targets.
- `test_fp16_cache_compaction` — real safetensors FP32→FP16 rewrite + idempotence.
- `test_frontend_modules_and_dom_ids` — every literal `getElementById("…")` in the
  JS must exist in `index.html`.
- `test_release_archives_contain_all_modules` — actually builds the Windows/Linux
  packages and asserts all modules ship.

---

## 11. Environment Variables & Runtime Knobs

| Variable | Effect |
|---|---|
| `PORT` | Server port (default `7860`) |
| `NO_BROWSER=1` | Headless API-only mode |
| `OPENBGR_BROWSER=1` | Chromeless browser window instead of pywebview |
| `PYTORCH_ENABLE_MPS_FALLBACK=1` | Set by app itself before torch import |
| `HF_HUB_CACHE` (implicit) | Where model weights live |

Server listens on `127.0.0.1` only — it is not exposed beyond localhost.

---

## 12. Contributor Gotchas & Design Notes

- **`app.py` is intentionally monolithic** — the packaged apps ship it as a loose
  file, and PEP 723 metadata lets `uv` run it standalone. Keep that header in
  sync with `requirements.txt`.
- **Adding a model** means: `MODELS` entry, `TIERS` entry (with `expected_bytes`),
  `TIER_KEYS`/`PRESET_NAMES`/`MODEL_TECH_NAMES`/`MODEL_EXPECTED_BYTES` on the
  frontend, a `.tier-btn` in `index.html`, a model row in the MODELS pane, menu
  items in `build_native_menus` + `index.html` + `app.js` dispatch, and the test
  key list.
- **Icons regenerate by mtime** — touch `icon_render.py` (not just edit logic
  silently) semantics: `ensure_app_icon` deletes `~/.openbgr/icon.png` when the
  source file is newer.
- **The matting flag is a vestige** — `matting` is now a first-class tier; the
  `matting` form field on `/api/remove-bg` remains for API compatibility.
- **`_LAST_JOB` holds a full-resolution RGB+alpha copy** of the last job — expect
  `W×H×4` bytes resident; only the most recent job can be refined.
- **Menu titles must avoid `.` and `()`** (GTK Gio action parser) — use `…`/`—`.
- **Don't rename DOM IDs casually** — `dom` registry + `test_frontend_modules_and_dom_ids`
  enforce ID↔HTML agreement.
- **Browser fallback path must stay functional** — every `pywebview.api.*` call is
  optional-chained with a `fetch`/`navigator.clipboard` fallback; keep it that way.
- **ZIP is store-only on purpose** — don't add DEFLATE; payloads are already
  compressed images.
- **Release builds are ad-hoc signed**, not notarized — the Gatekeeper note in the
  README is expected behavior, not a bug.
