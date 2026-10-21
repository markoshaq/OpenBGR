#!/usr/bin/env python3
"""
Bump the project version in every file that pins it.

Usage:
    python3 scripts/bump_version.py 0.11.3

`pyproject.toml` stays the canonical source (read at runtime by
`openbgr.config.APP_VERSION` and `build_release.APP_VERSION`); this script
keeps `package.json` and `package-lock.json` in lockstep so the
`test_version_single_sourced_from_pyproject` integrity test never drifts.
"""

from __future__ import annotations

import json
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

    for name in ("package.json", "package-lock.json"):
        path = ROOT_DIR / name
        data = json.loads(path.read_text(encoding="utf-8"))
        data["version"] = version
        if name == "package-lock.json":
            root_pkg = data.get("packages", {}).get("")
            if isinstance(root_pkg, dict):
                root_pkg["version"] = version
        path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

    print(f"Bumped to {version}: pyproject.toml, package.json, package-lock.json")
    print(f"Next: add a CHANGELOG.md section, then `git tag v{version}` to release.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
