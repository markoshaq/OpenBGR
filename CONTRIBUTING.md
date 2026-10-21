# Contributing

Thanks for your interest in OpenBGR. Here's how to get a change from idea to merged PR.

## Before you start

- **Bug?** Open an issue with the bug-report template; include your OS, the model tier used, and the relevant log output.
- **Feature or refactor?** Open an issue first to discuss scope before writing code. It avoids wasted work on changes that don't fit the project's goals (local-only, zero telemetry, no accounts).

## Development setup

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

## Guidelines

- Match the existing style: compact functions, type hints, docstrings on public APIs.
- Keep the privacy guarantee intact: no telemetry, no analytics, no network calls beyond Hugging Face model downloads.
- Frontend code lives in `static/` (vanilla JS, no build step); backend in `openbgr/`; entrypoint is `app.py`.
- If you add or rename files, update the **Project Layout** section in `README.md`.

## Releases

Maintainer-only: pushing a `v*` tag triggers `.github/workflows/release.yml` to build the Windows installer/portable ZIP, macOS DMG, Linux archive, and `SHA256SUMS.txt`, then attach them to a GitHub Release.

To bump the version, run `python3 scripts/bump_version.py X.Y.Z` — it updates `pyproject.toml`, `package.json`, and `package-lock.json` together. `pyproject.toml` is the canonical source; `test_version_single_sourced_from_pyproject` fails CI if any file drifts.
