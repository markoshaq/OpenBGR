#!/usr/bin/env python3
"""
Bump the project version in `pyproject.toml`.

Usage:
    python3 scripts/bump_version.py 0.11.3

`pyproject.toml` is the single canonical version source (read at runtime by
`openbgr.settings.APP_VERSION` / `openbgr.config.APP_VERSION` and by
`scripts/build_release.py`).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent


def main() -> int:
    if len(sys.argv) != 2 or not re.fullmatch(r"\d+\.\d+\.\d+", sys.argv[1]):
        print("usage: bump_version.py X.Y.Z")
        return 2
    version = sys.argv[1]

    pyproject = ROOT_DIR / "pyproject.toml"
    text = pyproject.read_text(encoding="utf-8")
    text, n = re.subn(
        r'(?m)^version\s*=\s*"[^"]+"',
        f'version = "{version}"',
        text,
        count=1,
    )
    if not n:
        print("error: no version field found in pyproject.toml")
        return 1
    pyproject.write_text(text, encoding="utf-8")

    print(f"Bumped to {version} in pyproject.toml")
    print(f"Next: add a CHANGELOG.md section, then `git tag v{version}` to release.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
