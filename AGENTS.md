# OpenBGR Agent Rules

## Commits and releases
- No AI or tool attribution anywhere: no "Generated with" lines, no `Co-Authored-By` bot trailers, in commits, tags, PRs, or files.
- Do not commit, tag, or push without being asked.
- Version is single-sourced from `pyproject.toml`; bump with `python3 scripts/bump_version.py X.Y.Z`.
- Runtime dependencies are single-sourced from `requirements.txt`; `pyproject.toml` reads them via setuptools dynamic metadata.
- `CHANGELOG.md` leads with the current work: one top section, replaced each release. Past release sections stay collapsed in a `<details>` block at the bottom (`### [x.y.z]` headings). Release notes on GitHub are generated from the top section by `.github/workflows/release.yml` on a `v*` tag push.
- Changelog entries use Keep a Changelog grouping: `### Added`, `### Changed`, `### Fixed` (plus `Removed`/`Security` when needed), and each bullet states the user-visible effect, not internals.

## Writing style
- No em dashes or en dashes in docs, comments, or commit messages.
- README is user-facing and concise; maintainer docs (setup, checks, layout, releases) live in `CONTRIBUTING.md`.
- Plain concrete sentences, no marketing language, no emoji in repo files.

## Verification
- Backend: `python -m unittest discover -s tests -v` (use `.venv/bin/python`).
- Frontend: `npm ci && npx eslint static && node --test "tests/*.test.mjs"`.
- Lint/format/type: `ruff check . && ruff format --check .` and `mypy app.py openbgr scripts` (CI enforces all four).
