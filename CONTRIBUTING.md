# Contributing

Thanks for your interest in OpenBGR. Here's how to get a change from idea to merged PR.

## Before you start

- **Bug?** Open an issue with the bug-report template; include your OS, the model tier used, and the relevant log output.
- **Feature or refactor?** Open an issue first to discuss scope before writing code. It avoids wasted work on changes that don't fit the project's goals (local-only, zero telemetry, no accounts).

## Development setup

OpenBGR is a FastAPI backend (`openbgr/`, `app.py` entrypoint), a pywebview desktop shell, and a vanilla ES-module frontend (`static/`) with no build step.

```bash
git clone https://github.com/markoshaq/OpenBGR.git
cd OpenBGR
./start.sh          # macOS / Linux: provisions .venv automatically
start.bat           :: Windows
```

The launcher creates `.venv` and installs `requirements.txt`. On first run it also downloads a BiRefNet checkpoint (~85-425 MB) from Hugging Face.

## Checks that must pass before a PR

CI runs the same suite on CPU-only PyTorch, so you can verify everything locally:

```bash
pip install ruff mypy
ruff check . && ruff format --check .   # lint + format
mypy app.py openbgr scripts  # type-check
python -m unittest discover -s tests -v # backend test suite
npm ci && npx eslint static             # frontend lint (Node 18+)
node --test "tests/*.test.mjs"          # frontend unit tests
```

Optionally, `npm run test:smoke` runs the headless-browser smoke test (`scripts/browser_smoke.mjs`): it starts the server and drives a real Chromium-family browser through menus, paste, zoom, and settings. It needs Node 22+ and Chrome, Brave, Chromium, or Edge installed (or `CHROME_BIN` set).

Test coverage spans the pipeline, API contracts, the desktop bridge, CLI and Quick Action runners, release payloads, and frontend modules.

## Guidelines

- Match the existing style: compact functions, type hints, docstrings on public APIs.
- Keep the privacy guarantee intact: no telemetry, no analytics, no network calls beyond Hugging Face model downloads.
- If you add or rename files, update the layout below.

## Frontend architecture

`static/` is vanilla ES modules with no build step. `tests/architecture.test.mjs` enforces the structure below, so CI fails if it regresses:

- **Import graph is acyclic.** Imports may point downward in the layer map or sideways within a layer; calls that need to travel upward go through injected collaborators (`init*` functions wired in `app.js`) or `bus.js` events for fire-and-forget signals.
- **No import-time side effects.** Only `app.js` runs code at load; every other module must be importable under `node --test` without triggering fetch calls, timers, or event listeners. Behavior lives behind exported functions and `init*` wiring.
- **Bounded file sizes.** `app.js` stays a thin boot file (imports, init calls, startup sync); other modules stay under 1000 lines.

Layer map, bottom to top:

1. **Primitives:** `dom.js`, `prefs.js`, `format.js`, `state.js`, `bus.js`, `zip.js`, `shortcuts.js`, `tooltips.js` (bottom layer).
2. **Shared helpers:** `stage.js`, `preferences.js`, `export.js`, `export-ui.js`, `export-io.js` (export stack builds downward).
3. **Workspace domains:** `segmentation.js`, `batch.js`, `batch-panel.js`, `batch-run.js` (batch/segmentation operations; their calls into the tab strip are injected, not imported).
4. **Workspace coordinator:** `tabs.js` (tab lifecycle and workspace state; may call domain modules directly).
5. **UI wiring:** `menubar.js`, `keyboard.js`, `modals.js`, `clipboard.js`, `open-files.js`, `recent.js`, `settings.js`, `controls.js`, `stage-input.js`, `backdrop.js`, `tier-dropdown.js`, `bridge.js` (event listeners and the `window.openBGR` command surface).
6. **Boot:** `app.js`.

New module checklist: a `tests/<name>.test.mjs`, an entry in `expected_modules` and the archive set in `tests/test_repo_integrity.py`, and a line in the layout below.

## Desktop signal and shutdown design

On macOS, `webview.start()` parks the main thread inside Cocoa's native `CFRunLoop`. While that loop runs, Python's bytecode interpreter never regains control on the main thread, so standard `signal.signal(SIGINT/SIGTERM, ...)` handlers do not fire until the window closes. `app.py` installs `signal.set_wakeup_fd` writing raw signal numbers into a non-blocking pipe watched by a daemon thread (`_start_signal_watchdog`), which cancels active jobs and calls `os._exit(128 + sig)`. `ModelManager.unload()` is intentionally skipped in signal/window-close teardown because `get_or_load` holds the model lock across first-run downloads; process exit lets the OS reclaim device memory immediately without risking a hung Ctrl+C.

To clean local build and tool caches:

```bash
rm -rf dist build .mypy_cache .ruff_cache .coverage
```

## Project layout

```text
├── app.py                  # Entrypoint (CLI / Quick Action / desktop launcher)
├── openbgr/
│   ├── config.py           # Runtime paths, hardware auto-detection & model tier registry
│   ├── settings.py         # Stdlib-only version, tokens, tier aliases & offline-mode switch
│   ├── models.py           # Thread-safe ModelManager, HF cache inspection & FP16 compaction
│   ├── pipeline.py         # Defringe, color-spill suppression, RGBA composition & segmentation
│   ├── icon_render.py      # Shared macOS squircle icon renderer (Pillow-only)
│   ├── quick_action.py     # Quick Action / headless CLI runner & cutout encoding
│   ├── quick_action_config.py # Persisted Quick Action settings & OS integration install
│   ├── quick_action_native.py # Native clipboard, dialogs & notification dispatch
│   ├── desktop_bridge.py   # JS↔Python bridge (DesktopApi) & pending open-files queue
│   ├── desktop_clipboard.py # Native OS clipboard probe, read & write mixin
│   ├── desktop_window.py   # Window geometry persistence & chromeless browser fallback
│   ├── desktop_menus.py    # Native menu bar (macOS / Linux GTK)
│   ├── desktop_cocoa.py    # macOS-only: app name, NSMenu/appearance & 'odoc' handlers
│   ├── server_probe.py     # Local-server probes & single-instance file forwarding
│   └── api.py              # FastAPI application and HTTP endpoints
├── pyproject.toml          # Project metadata, ruff & mypy config (deps read from requirements.txt)
├── docs/
│   └── demo.gif            # README demo
├── static/
│   ├── index.html          # 3-column studio workspace
│   ├── styles.css          # Stylesheet
│   ├── dom.js              # Lazy Proxy-backed DOM element registry
│   ├── prefs.js            # Shared constants, preference schema & localStorage persistence
│   ├── format.js           # Byte/duration formatting & per-tier download progress UI
│   ├── state.js            # Shared workspace state, tab model & helpers
│   ├── stage.js            # Split view, pan/zoom & loupe rendering
│   ├── export.js           # Canvas export pipeline, live preview & batch render
│   ├── export-ui.js        # Export telemetry, backdrop/scale controls & dim sync
│   ├── export-io.js        # Save/copy/reveal & output-folder actions
│   ├── zip.js              # ZIP writer (store + stream)
│   ├── preferences.js      # Hardware status, cache dots & preferences
│   ├── batch.js            # Batch queue model, tab ops & context menu
│   ├── batch-panel.js      # Batch row & panel rendering
│   ├── batch-run.js        # Sequential batch processing runner
│   ├── tabs.js             # Tab bar, ingestion, switching & view state
│   ├── segmentation.js     # Segmentation run, progress polling & refinement
│   ├── shortcuts.js        # Shortcut table, text-field gate & platform labels
│   ├── bridge.js           # window.openBGR command bridge (menus, shortcuts, native)
│   ├── menubar.js          # Declarative in-app menu bar & native-menus mode
│   ├── keyboard.js         # Escape cascade & key handlers
│   ├── open-files.js       # Open dialog, drag-and-drop & OS-delivered files
│   ├── clipboard.js        # Paste ingest & clipboard probe
│   ├── recent.js           # Open Recent modal
│   ├── backdrop.js         # Matte backdrop chips, swatches & photo
│   ├── tier-dropdown.js    # Model dropdown & tier cards
│   ├── tooltips.js         # Shared floating tooltip
│   ├── modals.js           # Confirm modal, busy cancel & context-menu dismiss
│   ├── settings.js         # Settings modal controls
│   ├── controls.js         # Sidebar, top-bar & export controls
│   ├── stage-input.js      # Stage wheel, gestures, pan & split drag
│   ├── bus.js              # Small event bus for cross-module signals
│   └── app.js              # Entry point: module init & startup only
├── scripts/
│   ├── build_release.py    # Builds .dmg / OpenBGR-Setup.exe / .zip / .tar.gz into dist/
│   ├── OpenBGR.iss         # Thin Inno Setup 6 definition for OpenBGR-Setup.exe
│   ├── OpenBGR.cs          # C# first-run bootstrapper compiled into OpenBGR.exe
│   ├── make_dev_bundle.py  # Generates the venv-local OpenBGR.app for dev runs
│   ├── bump_version.py     # Bumps the version in pyproject.toml
│   ├── browser_smoke.mjs   # Headless-browser smoke test for the frontend
│   ├── context_process.sh  # Headless cutout helper (server fast-path > --cli fallback)
│   ├── install_macos_quick_action.py      # Finder "Remove Background" Quick Action
│   ├── install_windows_context_menu.bat   # Explorer right-click entries (HKCU)
│   ├── uninstall_windows_context_menu.bat
│   └── install_linux_integration.sh       # .desktop / KDE / Nautilus entries
├── tests/
│   ├── test_api.py             # HTTP endpoint contracts & pending-file queueing
│   ├── test_models.py          # ModelManager concurrency, eviction, cancel & lock guards
│   ├── test_pipeline.py        # Icon render, edge refinement, FP16 compaction, segmentation
│   ├── test_quick_action.py    # Quick Action config, dialogs, runner & notifier bundle
│   ├── test_desktop_bridge.py  # DesktopApi bridge: dialogs, clipboard, window actions
│   ├── test_repo_integrity.py  # Version/dependency sync, release payloads & DOM integrity
│   ├── dom-shim.mjs            # Minimal DOM for importing static/ modules in node
│   ├── workspace-deps.mjs      # Injects real tab ops into domain modules for tests
│   ├── import-probe.mjs        # Side-effect counter used by the architecture test
│   ├── architecture.test.mjs   # Acyclic imports, import-safety & file-size caps
│   └── *.test.mjs              # Frontend module tests, one per static/ module (node:test)
├── start_mac.command       # macOS Finder launcher
├── start.sh                # macOS / Linux bootstrapper
├── start.bat               # Windows bootstrapper
└── requirements.txt        # Canonical Python dependency list
```

## Releases

Maintainer-only: pushing a `v*` tag triggers `.github/workflows/release.yml` to build the Windows installer/portable ZIP, macOS DMG, Linux archive, and `SHA256SUMS.txt`, then attach them to a GitHub Release. To build the bundles locally into `dist/`, run `python3 scripts/build_release.py`.

To bump the version, run `python3 scripts/bump_version.py X.Y.Z`. It updates `pyproject.toml`, which is the single canonical source; `test_version_single_sourced_from_pyproject` fails CI if any consumer drifts. The same applies to `requirements.txt` for dependencies: `pyproject.toml` reads them dynamically, so edit the txt file only.

Tag a release when `main` has soaked for a few days and the checklist below passes, not on a schedule.

### Manual release checklist

CI covers lint, types, and unit tests; it cannot exercise OS integrations or the bundled artifacts. Before tagging a `v*` release, run through this on each OS you can test:

- Fresh checkout with no `.venv`: `start.sh` / `start.bat` provisions and opens the studio.
- Drop an image in, run a cutout, export a PNG and a small batch ZIP.
- "Open With" / context menu / Quick Action once while the app is running and once while closed; the cutout lands next to the source.
- `python app.py --cli photo.png` writes `photo-cutout.png`.
- Model install and uninstall from the UI, with progress and disk usage updating.
- Restart restarts; window size and preferences survive relaunch.
- Built artifacts in `dist/`: launch the installer or portable bundle and run one cutout.
