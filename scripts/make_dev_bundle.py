#!/usr/bin/env python3
"""
Creates a venv-local `.venv/OpenBGR.app` launcher bundle on macOS so the dev
server gets a proper Dock icon and application name instead of "Python".

The bundle is a copy of the framework's `Python.app` interpreter stub with a
patched Info.plist (name, display name, identifier, icon), the venv's
`pyvenv.cfg` dropped into `Contents/`, and a `lib` symlink back to the venv's
site-packages. It is ad-hoc re-signed because modifying the bundle
invalidates the original signature. No-op on non-macOS systems and when the
bundle already exists.
"""

import platform
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path


def main() -> int:
    """Builds (idempotently) the `.venv/OpenBGR.app` dev bundle. Returns 0 on success or no-op."""
    root = Path(__file__).resolve().parent.parent
    venv = root / ".venv"
    dev_app = venv / "OpenBGR.app"
    if platform.system() != "Darwin" or not venv.is_dir() or dev_app.exists():
        return 0

    src_app = Path(sys.base_prefix) / "Resources" / "Python.app"
    if not (src_app / "Contents" / "MacOS" / "Python").is_file():
        return 0

    shutil.copytree(src_app, dev_app)
    contents = dev_app / "Contents"

    try:
        from build_release import generate_macos_icns
    except ImportError:
        sys.path.insert(0, str(root / "scripts"))
        from build_release import generate_macos_icns  # type: ignore
    generate_macos_icns(contents / "Resources" / "OpenBGR.icns")

    info_plist = contents / "Info.plist"
    for key, value in {
        "CFBundleName": "OpenBGR",
        "CFBundleDisplayName": "OpenBGR",
        "CFBundleIdentifier": "com.openbgr.dev",
        "CFBundleIconFile": "OpenBGR.icns",
    }.items():
        subprocess.run(
            ["plutil", "-replace", key, "-string", value, str(info_plist)],
            check=False,
        )

    # Register image UTIs so Finder offers "Open With → OpenBGR" for the dev
    # bundle; files arrive through the 'odoc' AppleEvent handled in app.py.
    try:
        with open(info_plist, "rb") as fh:
            plist = plistlib.load(fh)
        plist["CFBundleDocumentTypes"] = [
            {
                "CFBundleTypeName": "Image",
                "CFBundleTypeRole": "Viewer",
                "LSHandlerRank": "Alternate",
                "LSItemContentTypes": ["public.image"],
            }
        ]
        # Keep Launch Services from running the universal stub under Rosetta.
        plist["LSArchitecturePriority"] = ["arm64", "x86_64"]
        plist["LSRequiresNativeExecution"] = True
        with open(info_plist, "wb") as fh:
            plistlib.dump(plist, fh)
    except Exception:
        pass

    # Make the bundled stub resolve the venv: pyvenv.cfg sets sys.prefix to
    # Contents/, and the lib symlink maps Contents/lib -> .venv/lib.
    pyvenv_cfg = venv / "pyvenv.cfg"
    if pyvenv_cfg.is_file():
        shutil.copy2(pyvenv_cfg, contents / "pyvenv.cfg")
    lib_link = contents / "lib"
    if not lib_link.exists():
        lib_link.symlink_to("../../lib")

    subprocess.run(
        ["codesign", "--force", "--deep", "--sign", "-", str(dev_app)],
        check=False,
        capture_output=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
