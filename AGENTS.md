# OpenBGR Agent Rules

## Commits and releases
- No AI or tool attribution anywhere: no "Generated with" lines, no `Co-Authored-By` bot trailers, in commits, tags, PRs, or files.
- Do not commit, tag, or push without being asked.
- Version is single-sourced from `pyproject.toml`; bump with `python3 scripts/bump_version.py X.Y.Z`.
- Runtime dependencies are single-sourced from `requirements.txt`; `pyproject.toml` reads them via setuptools dynamic metadata.
- `CHANGELOG.md` leads with the current work: one top section, replaced each release. Past release sections stay collapsed in a `<details>` block at the bottom (`### [x.y.z]` headings). Release notes on GitHub are generated from the top section by `.github/workflows/release.yml` on a `v*` tag push.
- Changelog entries use Keep a Changelog grouping: `### Added`, `### Changed`, `### Fixed` (plus `Removed`/`Security` when needed). The same grouping applies inside collapsed past releases, nested one level down as `####` headings. Every bullet states the user-visible effect, not internals. Within each group, order bullets by user impact: headline features and visible fixes first, internals and housekeeping last.

## Writing style
- No em dashes or en dashes in docs, comments, or commit messages.
- README is user-facing and concise; maintainer docs (setup, checks, layout, releases) live in `CONTRIBUTING.md`.
- Plain concrete sentences, no marketing language, no emoji in repo files.

## Architecture and security guardrails
- **Thin-client entrypoints stay stdlib-only.** `app.py` defers importing `uvicorn`, `openbgr.api`, `openbgr.config`, and `openbgr.models` until after `--help`, `--version`, warm-server Quick Action delegation, and Open With file forwarding. Shared lightweight helpers live in stdlib-only `openbgr/settings.py` and `openbgr/server_probe.py`.
- **The ML stack loads lazily.** `openbgr.config` is torch-free at module level: `import torch`, device detection, precision, recommended tier, and the 2K tier resolutions are materialized by `ensure_runtime()` on first access (module `__getattr__`) or by the server lifespan's background warmup thread. `openbgr.models` and `openbgr.pipeline` import torch/transformers/torchvision/scipy/huggingface_hub lazily (module `__getattr__` plus `_ensure_hf_names`), so `import openbgr.api` stays ML-free and the desktop window is never gated on the heavy imports. Do not move these imports back to module level; `tests/test_quick_action.py::test_thin_client_paths_do_not_import_torch` enforces it. The startup preload also runs one small dummy forward (`models.warm_device_kernels`) to absorb the one-time MPS/CUDA kernel compilation so the first real click is warm; it is skipped on CPU and while a job is running.
- **Window-first desktop launch.** `_start_or_reuse_server` starts Uvicorn without waiting; `_run_desktop_window` opens the native window on an inline placeholder page and `_navigate_when_ready` (the `webview.start(func=...)` loader) navigates to the studio once the socket accepts, or loads an error page when the port was taken by a foreign app or the server died. A reused warm instance navigates directly. Server identity probes use the runtime-free `/api/progress`, not `/api/status`, so they answer before the torch warmup finishes.
- **Capability model:** Browser UI calls authenticate with `WEB_API_TOKEN` (injected into `GET /`), while raw-path OS IPC endpoints (`/api/open-files`, `/api/quick-action`) require `API_TOKEN` from `0600 ~/.openbgr/session_token`. Both `/api/save` and `/api/models/import` require a directory granted through the native folder picker (`desktop_bridge.grant_output_dir` or `/api/choose-folder`).
- **Frontend module rules (`tests/architecture.test.mjs`):** `static/` modules must have an acyclic import graph, zero import-time side effects (no DOM queries, `fetch`, timers, or element event listeners at module load; `dom.js` uses a lazy `Proxy`), and stay under 1000 lines (`app.js` under 120 lines).
- **Multi-frame animations (`static/animation.js`):** Animated GIFs and WebPs extract frames via `/api/extract-frames`, render in the bottom `#animDock` filmstrip + playback bar (`Space` play/pause, `ArrowLeft`/`ArrowRight` step), trim via `startFrame`/`endFrame`, and re-encode via `/api/encode-animation`.
- **New frontend module checklist:** Add `tests/<name>.test.mjs`, register the module in `expected_modules` and `common_entries` in `tests/test_repo_integrity.py`, and list it in `CONTRIBUTING.md`.

## Verification
- Backend: `python -m unittest discover -s tests -v` (use `.venv/bin/python`).
- Frontend: `npm ci && npx eslint static && node --test "tests/*.test.mjs"`.
- Lint/format/type: `ruff check . && ruff format --check .` and `mypy app.py openbgr scripts` (CI enforces all four).
