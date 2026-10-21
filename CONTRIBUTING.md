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

Test coverage spans the pipeline, API contracts, CLI and Quick Action runners, release payloads, and frontend state helpers.

## Guidelines

- Match the existing style: compact functions, type hints, docstrings on public APIs.
- Keep the privacy guarantee intact: no telemetry, no analytics, no network calls beyond Hugging Face model downloads.
- If you add or rename files, update the layout below.

## Project layout

```text
├── app.py                  # Entrypoint (CLI / Quick Action / desktop launcher)
├── openbgr/
│   ├── config.py           # Runtime paths, hardware auto-detection & model tier registry
│   ├── models.py           # Thread-safe ModelManager, HF cache inspection & FP16 compaction
│   ├── pipeline.py         # Defringe, color-spill suppression, RGBA composition & segmentation
│   ├── icon_render.py      # Shared macOS squircle icon renderer (Pillow-only)
│   ├── quick_action.py     # Quick Action / headless CLI runner & cutout encoding
│   ├── quick_action_config.py # Persisted Quick Action settings & OS integration install
│   ├── quick_action_native.py # Native clipboard, dialogs & notification dispatch
│   ├── desktop_bridge.py   # JS↔Python bridge (DesktopApi) & pending open-files queue
│   ├── desktop_window.py   # Window geometry persistence & chromeless browser fallback
│   ├── desktop_menus.py    # Native menu bar (macOS / Linux GTK)
│   ├── desktop_cocoa.py    # macOS-only: app name, NSMenu/appearance & 'odoc' handlers
│   ├── server_probe.py     # Local-server probes & single-instance file forwarding
│   └── api.py              # FastAPI application and HTTP endpoints
├── pyproject.toml          # Project metadata, ruff & mypy configuration
├── docs/
│   └── demo.gif            # README demo
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
│   ├── build_release.py    # Builds .dmg / OpenBGR-Setup.exe / .zip / .tar.gz into dist/
│   ├── OpenBGR.iss         # Thin Inno Setup 6 definition for OpenBGR-Setup.exe
│   ├── OpenBGR.cs          # C# first-run bootstrapper compiled into OpenBGR.exe
│   ├── make_dev_bundle.py  # Generates the venv-local OpenBGR.app for dev runs
│   ├── bump_version.py     # Bumps the version in pyproject/package*.json together
│   ├── context_process.sh  # Headless cutout helper (server fast-path > --cli fallback)
│   ├── install_macos_quick_action.py      # Finder "Remove Background" Quick Action
│   ├── install_windows_context_menu.bat   # Explorer right-click entries (HKCU)
│   ├── uninstall_windows_context_menu.bat
│   └── install_linux_integration.sh       # .desktop / KDE / Nautilus entries
├── tests/
│   ├── test_api.py             # HTTP endpoint contracts & pending-file queueing
│   ├── test_pipeline.py        # Icon render, edge refinement, FP16 compaction, segmentation
│   ├── test_quick_action.py    # Quick Action config, dialogs, runner & notifier bundle
│   ├── test_repo_integrity.py  # Version/dependency sync, release payloads & DOM integrity
│   └── state.test.mjs          # Frontend state helpers (node:test)
├── Start Mac.command       # macOS Finder launcher
├── start.sh                # macOS / Linux bootstrapper
├── start.bat               # Windows bootstrapper
└── requirements.txt        # Python dependencies
```

## Releases

Maintainer-only: pushing a `v*` tag triggers `.github/workflows/release.yml` to build the Windows installer/portable ZIP, macOS DMG, Linux archive, and `SHA256SUMS.txt`, then attach them to a GitHub Release. To build the bundles locally into `dist/`, run `python3 scripts/build_release.py`.

To bump the version, run `python3 scripts/bump_version.py X.Y.Z`. It updates `pyproject.toml`, `package.json`, and `package-lock.json` together. `pyproject.toml` is the canonical source; `test_version_single_sourced_from_pyproject` fails CI if any file drifts.
