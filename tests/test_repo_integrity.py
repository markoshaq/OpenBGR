"""
Repository-integrity tests: version and dependency single-sourcing,
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
        self.assertNotIn("version", pkg)

    def test_dependencies_single_sourced_from_requirements_txt(self) -> None:
        """`requirements.txt` is the only dependency list; pyproject consumes it."""
        try:
            import tomllib
        except ModuleNotFoundError:
            # Python 3.10 has no tomllib; the dev extra installs tomli there.
            import tomli as tomllib

        parsed = tomllib.loads((ROOT_DIR / "pyproject.toml").read_text())
        project = parsed["project"]
        self.assertNotIn("dependencies", project)
        self.assertIn("dependencies", project.get("dynamic", []))
        self.assertEqual(
            parsed["tool"]["setuptools"]["dynamic"]["dependencies"]["file"],
            ["requirements.txt"],
        )

        requirements = [
            line.strip()
            for line in (ROOT_DIR / "requirements.txt").read_text().splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        self.assertTrue(requirements)
        for req in requirements:
            self.assertRegex(req, r"^[A-Za-z0-9][A-Za-z0-9._-]*")

    def test_runtime_dependencies_have_upper_bounds(self) -> None:
        """Every runtime requirement is capped so unvetted majors can't auto-resolve."""
        for line in (ROOT_DIR / "requirements.txt").read_text().splitlines():
            req = line.strip()
            if not req or req.startswith("#"):
                continue
            name = re.split(r"[<>=!~;\s]", req, maxsplit=1)[0]
            self.assertIn(">=", req, f"{name} has no lower bound")
            self.assertIn("<", req, f"{name} has no upper bound")

    def test_frontend_constants_match_backend(self) -> None:
        """Constants shared across prefs.js and config.py cannot drift, and ACCENTS is single-sourced."""
        html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
        prefs_js = (STATIC_DIR / "prefs.js").read_text(encoding="utf-8")

        def js_object_block(text: str, name: str) -> str:
            m = re.search(rf"{name}\s*=\s*\{{(.*?)\}}", text, re.DOTALL)
            return m.group(1) if m else ""

        pair_re = r'(\w+)\s*:\s*\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]'
        js_accents = {
            k: [a, b] for k, a, b in re.findall(pair_re, js_object_block(prefs_js, "ACCENTS"))
        }
        self.assertTrue(js_accents, "ACCENTS literal missing from prefs.js")
        self.assertEqual(
            js_object_block(html, "ACCENTS"),
            "",
            "index.html must not duplicate the ACCENTS table",
        )

        js_aliases = dict(
            re.findall(r'(\w+)\s*:\s*"(\w+)"', js_object_block(prefs_js, "TIER_ALIASES"))
        )
        self.assertEqual(js_aliases, config_mod.TIER_ALIASES)

        keys_block = re.search(r"TIER_KEYS\s*=\s*\[(.*?)\]", prefs_js, re.DOTALL)
        js_tier_keys = re.findall(r'"(\w+)"', keys_block.group(1) if keys_block else "")
        self.assertEqual(js_tier_keys, list(config_mod.TIERS.keys()))

    def test_frontend_modules_and_dom_ids(self) -> None:
        """Every registered DOM id in `dom.js` and `getElementById` in `static/` exists in index.html."""
        expected_modules = [
            "dom.js",
            "prefs.js",
            "format.js",
            "state.js",
            "stage.js",
            "export.js",
            "preferences.js",
            "batch.js",
            "tabs.js",
            "shortcuts.js",
            "bridge.js",
            "menubar.js",
            "keyboard.js",
            "open-files.js",
            "clipboard.js",
            "recent.js",
            "backdrop.js",
            "tier-dropdown.js",
            "tooltips.js",
            "modals.js",
            "settings.js",
            "controls.js",
            "stage-input.js",
            "export-ui.js",
            "export-io.js",
            "zip.js",
            "segmentation.js",
            "animation.js",
            "anim-preview.js",
            "anim-export.js",
            "batch-panel.js",
            "batch-run.js",
            "bus.js",
            "app.js",
        ]
        html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
        html_ids = set(re.findall(r'\bid="([^"]+)"', html))

        dom_js = (STATIC_DIR / "dom.js").read_text(encoding="utf-8")
        dom_ids_block = re.search(r"DOM_IDS\s*=\s*Object\.freeze\(\[(.*?)\]\)", dom_js, re.DOTALL)
        registered_ids = re.findall(r'"([^"]+)"', dom_ids_block.group(1) if dom_ids_block else "")
        self.assertTrue(registered_ids, "DOM_IDS missing from dom.js")
        for ref_id in registered_ids:
            self.assertIn(
                ref_id,
                html_ids,
                f"#{ref_id} registered in dom.js does not exist in index.html",
            )

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
                "OpenBGR/openbgr/desktop_clipboard.py",
                "OpenBGR/openbgr/desktop_window.py",
                "OpenBGR/openbgr/desktop_menus.py",
                "OpenBGR/openbgr/desktop_cocoa.py",
                "OpenBGR/openbgr/server_probe.py",
                "OpenBGR/openbgr/settings.py",
                "OpenBGR/openbgr/api.py",
                "OpenBGR/static/index.html",
                "OpenBGR/static/styles.css",
                "OpenBGR/static/app.js",
                "OpenBGR/static/dom.js",
                "OpenBGR/static/prefs.js",
                "OpenBGR/static/format.js",
                "OpenBGR/static/state.js",
                "OpenBGR/static/stage.js",
                "OpenBGR/static/export.js",
                "OpenBGR/static/preferences.js",
                "OpenBGR/static/shortcuts.js",
                "OpenBGR/static/batch.js",
                "OpenBGR/static/tabs.js",
                "OpenBGR/static/bridge.js",
                "OpenBGR/static/menubar.js",
                "OpenBGR/static/keyboard.js",
                "OpenBGR/static/open-files.js",
                "OpenBGR/static/clipboard.js",
                "OpenBGR/static/recent.js",
                "OpenBGR/static/backdrop.js",
                "OpenBGR/static/tier-dropdown.js",
                "OpenBGR/static/tooltips.js",
                "OpenBGR/static/modals.js",
                "OpenBGR/static/settings.js",
                "OpenBGR/static/controls.js",
                "OpenBGR/static/stage-input.js",
                "OpenBGR/static/export-ui.js",
                "OpenBGR/static/export-io.js",
                "OpenBGR/static/zip.js",
                "OpenBGR/static/segmentation.js",
                "OpenBGR/static/animation.js",
                "OpenBGR/static/anim-preview.js",
                "OpenBGR/static/anim-export.js",
                "OpenBGR/static/batch-panel.js",
                "OpenBGR/static/batch-run.js",
                "OpenBGR/static/bus.js",
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
                "OpenBGR/start_mac.command",
                "OpenBGR/scripts/context_process.sh",
                "OpenBGR/scripts/install_linux_integration.sh",
                "OpenBGR/scripts/install_macos_quick_action.py",
                "OpenBGR/scripts/make_dev_bundle.py",
            }
            linux_foreign_entries = {
                "OpenBGR/start.bat",
                "OpenBGR/start_mac.command",
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
