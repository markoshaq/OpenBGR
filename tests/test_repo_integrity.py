"""
Repository-integrity tests: version single-sourcing, dependency-list sync,
release payload contents, and frontend ES module / DOM integrity.

Run with:
    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import re
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import openbgr.config as config_mod
from scripts import build_release

ROOT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT_DIR / "static"


class TestRepoIntegrity(unittest.TestCase):
    """Cross-file contracts that must not drift apart."""

    def test_version_single_sourced_from_pyproject(self) -> None:
        """pyproject.toml is the only version source; every consumer must agree."""
        m = re.search(
            r'^version\s*=\s*"([^"]+)"',
            (ROOT_DIR / "pyproject.toml").read_text(encoding="utf-8"),
            re.MULTILINE,
        )
        self.assertIsNotNone(m)
        canonical = m.group(1) if m else ""
        self.assertEqual(config_mod.APP_VERSION, canonical)
        self.assertEqual(build_release.APP_VERSION, canonical)
        pkg = json.loads((ROOT_DIR / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(pkg["version"], canonical)

    def test_dependency_lists_stay_in_sync(self) -> None:
        """`requirements.txt` and `pyproject.toml` declare identical dependencies."""
        requirements = {
            line.strip()
            for line in (ROOT_DIR / "requirements.txt").read_text().splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }

        import tomllib

        pyproject_deps = set(
            tomllib.loads((ROOT_DIR / "pyproject.toml").read_text())["project"]["dependencies"]
        )
        self.assertEqual(requirements, pyproject_deps)

    def test_frontend_modules_and_dom_ids(self) -> None:
        """Every `getElementById` in the ES modules resolves to a real `id` in index.html."""
        expected_modules = [
            "state.js",
            "stage.js",
            "export.js",
            "preferences.js",
            "batch.js",
            "tabs.js",
            "app.js",
        ]
        html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
        html_ids = set(re.findall(r'\bid="([^"]+)"', html))

        for mod_name in expected_modules:
            mod_path = STATIC_DIR / mod_name
            self.assertTrue(mod_path.is_file(), f"Missing ES module: {mod_name}")
            src = mod_path.read_text(encoding="utf-8")
            for ref_id in re.findall(r'getElementById\("([^"$]+)"\)', src):
                self.assertIn(
                    ref_id,
                    html_ids,
                    f"#{ref_id} referenced in {mod_name} does not exist in index.html",
                )

    def test_release_archives_contain_all_modules(self) -> None:
        """Windows/Linux release archives ship every frontend module, icon, and launcher."""
        with (
            tempfile.TemporaryDirectory() as tmp_dist,
            patch.object(build_release, "DIST_DIR", Path(tmp_dist)),
        ):
            win_zip = build_release.build_windows_release()
            linux_tar = build_release.build_linux_release()

            common_entries = {
                "OpenBGR/app.py",
                "OpenBGR/openbgr/__init__.py",
                "OpenBGR/openbgr/config.py",
                "OpenBGR/openbgr/icon_render.py",
                "OpenBGR/openbgr/models.py",
                "OpenBGR/openbgr/pipeline.py",
                "OpenBGR/openbgr/quick_action.py",
                "OpenBGR/openbgr/quick_action_config.py",
                "OpenBGR/openbgr/quick_action_native.py",
                "OpenBGR/openbgr/desktop_bridge.py",
                "OpenBGR/openbgr/desktop_window.py",
                "OpenBGR/openbgr/desktop_menus.py",
                "OpenBGR/openbgr/desktop_cocoa.py",
                "OpenBGR/openbgr/server_probe.py",
                "OpenBGR/openbgr/api.py",
                "OpenBGR/static/index.html",
                "OpenBGR/static/styles.css",
                "OpenBGR/static/app.js",
                "OpenBGR/static/state.js",
                "OpenBGR/static/stage.js",
                "OpenBGR/static/export.js",
                "OpenBGR/static/preferences.js",
                "OpenBGR/static/batch.js",
                "OpenBGR/static/tabs.js",
            }
            windows_entries = common_entries | {
                "OpenBGR/start.bat",
                "OpenBGR/scripts/install_windows_context_menu.bat",
                "OpenBGR/scripts/uninstall_windows_context_menu.bat",
            }
            linux_entries = common_entries | {
                "OpenBGR/start.sh",
                "OpenBGR/scripts/context_process.sh",
                "OpenBGR/scripts/install_linux_integration.sh",
            }
            windows_foreign_entries = {
                "OpenBGR/start.sh",
                "OpenBGR/Start Mac.command",
                "OpenBGR/scripts/context_process.sh",
                "OpenBGR/scripts/install_linux_integration.sh",
                "OpenBGR/scripts/install_macos_quick_action.py",
                "OpenBGR/scripts/make_dev_bundle.py",
            }
            linux_foreign_entries = {
                "OpenBGR/start.bat",
                "OpenBGR/Start Mac.command",
                "OpenBGR/scripts/install_macos_quick_action.py",
                "OpenBGR/scripts/install_windows_context_menu.bat",
                "OpenBGR/scripts/uninstall_windows_context_menu.bat",
                "OpenBGR/scripts/make_dev_bundle.py",
            }

            with zipfile.ZipFile(win_zip, "r") as zf:
                zip_names = {n.replace("\\", "/") for n in zf.namelist()}
                self.assertTrue(windows_entries.issubset(zip_names))
                self.assertIn("OpenBGR/OpenBGR.ico", zip_names)
                self.assertFalse(windows_foreign_entries & zip_names)

            with tarfile.open(linux_tar, "r:gz") as tf:
                tar_names = set(tf.getnames())
                self.assertTrue(linux_entries.issubset(tar_names))
                self.assertIn("OpenBGR/icon.png", tar_names)
                self.assertIn("OpenBGR/OpenBGR.desktop", tar_names)
                self.assertFalse(linux_foreign_entries & tar_names)

        # Verify CUDA torch wheel preservation in start.sh / start.bat and thin Inno Setup script
        start_sh = (ROOT_DIR / "start.sh").read_text(encoding="utf-8")
        start_bat = (ROOT_DIR / "start.bat").read_text(encoding="utf-8")
        iss_text = (ROOT_DIR / "scripts" / "OpenBGR.iss").read_text(encoding="utf-8")
        self.assertIn("grep -Ev '^[[:space:]]*torch'", start_sh)
        self.assertIn('findstr /V /I /B /C:"torch"', start_bat)
        self.assertIn("OutputBaseFilename", iss_text)
        self.assertIn(
            "RunStartBatWithGui",
            (ROOT_DIR / "scripts" / "OpenBGR.cs").read_text(encoding="utf-8"),
        )


if __name__ == "__main__":
    unittest.main()
