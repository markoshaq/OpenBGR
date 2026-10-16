#!/usr/bin/env python3
"""
OpenBGR — Cross-Platform Lightweight Desktop Release Builder
============================================================
Builds lightweight native desktop packages (Option 2 architecture) that keep
download sizes under ~1 MB while automatically provisioning the local AI
runtime (`~/.openbgr/venv`) and opening a native `pywebview` desktop window:

- macOS   : `dist/OpenBGR-macOS.dmg` (containing `OpenBGR.app` + `/Applications` link)
- Windows : `dist/OpenBGR-Windows.zip` (containing compiled `OpenBGR.exe` + app files)
- Linux   : `dist/OpenBGR-Linux.tar.gz` (containing `OpenBGR` launcher + `.desktop` file)
"""

from __future__ import annotations

import os
import platform
import shutil
import stat
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
DIST_DIR = ROOT_DIR / "dist"

APP_FILES = [
    "app.py",
    "icon_render.py",
    "requirements.txt",
    "start.sh",
    "start.bat",
    "Start Mac.command",
    "LICENSE",
    "README.md",
]


def copy_project_payload(dest_dir: Path) -> None:
    """Copies the core OpenBGR application files and static assets into `dest_dir`."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    for filename in APP_FILES:
        src = ROOT_DIR / filename
        if src.exists():
            shutil.copy2(src, dest_dir / filename)

    for script_name in (
        "make_dev_bundle.py",
        "context_process.sh",
        "install_macos_quick_action.py",
        "install_windows_context_menu.bat",
        "uninstall_windows_context_menu.bat",
        "install_linux_integration.sh",
    ):
        script_src = ROOT_DIR / "scripts" / script_name
        if script_src.exists():
            scripts_dst = dest_dir / "scripts"
            scripts_dst.mkdir(parents=True, exist_ok=True)
            dst = scripts_dst / script_name
            shutil.copy2(script_src, dst)
            make_executable(dst)

    static_src = ROOT_DIR / "static"
    static_dst = dest_dir / "static"
    if static_dst.exists():
        shutil.rmtree(static_dst)
    shutil.copytree(static_src, static_dst)

    pkg_src = ROOT_DIR / "openbgr"
    pkg_dst = dest_dir / "openbgr"
    if pkg_dst.exists():
        shutil.rmtree(pkg_dst)
    if pkg_src.is_dir():
        shutil.copytree(
            pkg_src,
            pkg_dst,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )


def make_executable(path: Path) -> None:
    """Sets executable permissions (`chmod +x`) on a file."""
    mode = path.stat().st_mode
    path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def generate_macos_icns(icns_path: Path) -> None:
    """Generates the squircle `OpenBGR.icns` via Pillow (shared renderer) and `iconutil`."""
    try:
        import sys

        sys.path.insert(0, str(ROOT_DIR))
        import icon_render
        from PIL import Image
    except ImportError:
        return

    with tempfile.TemporaryDirectory() as tmp:
        iconset_dir = Path(tmp) / "OpenBGR.iconset"
        iconset_dir.mkdir(parents=True, exist_ok=True)

        base_img = icon_render.render_icon(1024)

        sizes = [16, 32, 128, 256, 512]
        for sz in sizes:
            img_1x = base_img.resize((sz, sz), Image.Resampling.LANCZOS)
            img_1x.save(iconset_dir / f"icon_{sz}x{sz}.png")
            img_2x = base_img.resize((sz * 2, sz * 2), Image.Resampling.LANCZOS)
            img_2x.save(iconset_dir / f"icon_{sz}x{sz}@2x.png")

        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset_dir), "-o", str(icns_path)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def build_macos_dmg() -> Path:
    """Builds `dist/OpenBGR.app` and packages it into `dist/OpenBGR-macOS.dmg`."""
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    app_bundle = DIST_DIR / "OpenBGR.app"
    if app_bundle.exists():
        shutil.rmtree(app_bundle)

    contents_dir = app_bundle / "Contents"
    macos_dir = contents_dir / "MacOS"
    resources_dir = contents_dir / "Resources"
    payload_dir = resources_dir / "app"

    macos_dir.mkdir(parents=True, exist_ok=True)
    payload_dir.mkdir(parents=True, exist_ok=True)

    copy_project_payload(payload_dir)
    generate_macos_icns(resources_dir / "OpenBGR.icns")

    info_plist = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDisplayName</key>
    <string>OpenBGR</string>
    <key>CFBundleExecutable</key>
    <string>OpenBGR</string>
    <key>CFBundleIconFile</key>
    <string>OpenBGR.icns</string>
    <key>CFBundleIdentifier</key>
    <string>com.markoshaq.openbgr</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>OpenBGR</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeName</key>
            <string>Image</string>
            <key>CFBundleTypeRole</key>
            <string>Viewer</string>
            <key>LSHandlerRank</key>
            <string>Alternate</string>
            <key>LSItemContentTypes</key>
            <array>
                <string>public.image</string>
            </array>
        </dict>
    </array>
    <key>CFBundleShortVersionString</key>
    <string>0.10</string>
    <key>CFBundleVersion</key>
    <string>0.10</string>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
    <key>LSArchitecturePriority</key>
    <array>
        <string>arm64</string>
        <string>x86_64</string>
    </array>
    <key>LSRequiresNativeExecution</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
"""
    (contents_dir / "Info.plist").write_text(info_plist, encoding="utf-8")

    # Native macOS app launcher script that provisions ~/.openbgr/venv on first run
    launcher_script = """#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
RUNTIME_DIR="$HOME/.openbgr"
VENV_DIR="$RUNTIME_DIR/venv"
LOG_FILE="$RUNTIME_DIR/openbgr.log"

mkdir -p "$RUNTIME_DIR"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.cargo/bin:/Library/Frameworks/Python.framework/Versions/Current/bin:$PATH"

if [ ! -f "$VENV_DIR/.installed" ]; then
  osascript -e 'display notification "Setting up local AI engine (one-time setup, ~1-2 min)..." with title "OpenBGR"' >/dev/null 2>&1 || true
  HAS_PY310=0
  if command -v python3 >/dev/null 2>&1; then
    PY_OK=$(python3 -c 'import sys; print(int(sys.version_info >= (3, 10)))' 2>/dev/null || echo 0)
    if [ "$PY_OK" = "1" ]; then
      HAS_PY310=1
    fi
  fi
  if ! command -v uv >/dev/null 2>&1 && [ "$HAS_PY310" != "1" ]; then
    curl -LsSf https://astral.sh/uv/install.sh | sh >>"$LOG_FILE" 2>&1
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  fi
  if command -v uv >/dev/null 2>&1; then
    uv venv "$VENV_DIR" --python 3.12 >>"$LOG_FILE" 2>&1
    uv pip install --python "$VENV_DIR/bin/python" -r "$DIR/requirements.txt" >>"$LOG_FILE" 2>&1
  else
    python3 -m venv "$VENV_DIR" >>"$LOG_FILE" 2>&1
    "$VENV_DIR/bin/pip" install --upgrade pip -q >>"$LOG_FILE" 2>&1
    "$VENV_DIR/bin/pip" install -r "$DIR/requirements.txt" >>"$LOG_FILE" 2>&1
  fi
  touch "$VENV_DIR/.installed"
fi

cd "$DIR"
# Launch Services can pick the x86_64 slice of the universal `bash` stub under
# Rosetta; pin the interpreter to arm64 on Apple Silicon so MPS stays usable.
PY="$VENV_DIR/bin/python"
if [ "$(uname -m)" = "arm64" ] && command -v arch >/dev/null 2>&1; then
  exec arch -arm64 "$PY" "$DIR/app.py" "$@" >>"$LOG_FILE" 2>&1
fi
exec "$PY" "$DIR/app.py" "$@" >>"$LOG_FILE" 2>&1
"""
    launcher_path = macos_dir / "OpenBGR"
    launcher_path.write_text(launcher_script, encoding="utf-8")
    make_executable(launcher_path)
    make_executable(payload_dir / "start.sh")
    make_executable(payload_dir / "Start Mac.command")

    # Ad-hoc sign the app bundle so macOS Apple Silicon launch services accept it.
    subprocess.run(
        ["codesign", "--force", "--deep", "--sign", "-", str(app_bundle)],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    dmg_path = DIST_DIR / "OpenBGR-macOS.dmg"
    if dmg_path.exists():
        dmg_path.unlink()

    with tempfile.TemporaryDirectory() as stage_tmp:
        stage_dir = Path(stage_tmp) / "dmg_root"
        stage_dir.mkdir(parents=True, exist_ok=True)
        shutil.copytree(app_bundle, stage_dir / "OpenBGR.app", symlinks=True)
        os.symlink("/Applications", stage_dir / "Applications")

        subprocess.run(
            [
                "hdiutil",
                "create",
                "-volname",
                "OpenBGR",
                "-srcfolder",
                str(stage_dir),
                "-ov",
                "-format",
                "UDZO",
                str(dmg_path),
            ],
            check=True,
        )

    print(f"[Release] Built macOS app bundle : {app_bundle}")
    print(f"[Release] Built macOS disk image : {dmg_path}")
    return dmg_path


def build_windows_release() -> Path:
    """
    Builds `dist/OpenBGR-Windows.zip` containing a compiled `OpenBGR.exe`
    native launcher (if `csc.exe` is available on Windows) and the application files.
    """
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    win_stage = DIST_DIR / "OpenBGR-Windows"
    if win_stage.exists():
        shutil.rmtree(win_stage)

    copy_project_payload(win_stage)

    # On Windows hosts, compile a zero-dependency C# GUI launcher `OpenBGR.exe`
    csc_candidates = [
        r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
        r"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe",
    ]
    csc_exe = next((p for p in csc_candidates if os.path.exists(p)), None)
    if csc_exe:
        cs_source = r"""
using System;
using System.Diagnostics;
using System.IO;

class OpenBGRLauncher {
    [STAThread]
    static void Main(string[] args) {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string argLine = "";
        foreach (string a in args) argLine += " \"" + a.Replace("\"", "\"\"") + "\"";
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = "cmd.exe";
        psi.Arguments = "/c \"\"" + Path.Combine(dir, "start.bat") + "\"" + argLine + "\"";
        psi.WorkingDirectory = dir;
        psi.UseShellExecute = false;
        // Headless invocations (right-click "Remove background") must not flash
        // a console window; GUI launches keep it so setup progress is visible.
        bool headless = Array.Exists(args, a => a == "--quick-action" || a == "--cli");
        if (headless) {
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
        }
        Process.Start(psi);
    }
}
"""
        cs_file = win_stage / "Launcher.cs"
        exe_file = win_stage / "OpenBGR.exe"
        cs_file.write_text(cs_source, encoding="utf-8")
        subprocess.run(
            [csc_exe, "/target:winexe", f"/out:{exe_file}", str(cs_file)],
            check=False,
        )
        cs_file.unlink(missing_ok=True)

    zip_path = DIST_DIR / "OpenBGR-Windows.zip"
    if zip_path.exists():
        zip_path.unlink()

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in win_stage.rglob("*"):
            if file_path.is_file():
                arcname = Path("OpenBGR") / file_path.relative_to(win_stage)
                zf.write(file_path, arcname)

    print(f"[Release] Built Windows archive  : {zip_path}")
    return zip_path


def build_linux_release() -> Path:
    """Builds `dist/OpenBGR-Linux.tar.gz` with a `.desktop` launcher entry."""
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    linux_stage = DIST_DIR / "OpenBGR-Linux"
    if linux_stage.exists():
        shutil.rmtree(linux_stage)

    copy_project_payload(linux_stage)
    make_executable(linux_stage / "start.sh")

    desktop_entry = """[Desktop Entry]
Type=Application
Name=OpenBGR
Comment=Local AI Background Removal Studio
Exec=sh -c 'cd "$(dirname "$1")" && shift && exec ./start.sh "$@"' _ %k %F
MimeType=image/png;image/jpeg;image/webp;image/bmp;image/tiff;image/gif;
Terminal=false
Categories=Graphics;Photography;
"""
    (linux_stage / "OpenBGR.desktop").write_text(desktop_entry, encoding="utf-8")
    make_executable(linux_stage / "OpenBGR.desktop")

    tar_path = DIST_DIR / "OpenBGR-Linux.tar.gz"
    if tar_path.exists():
        tar_path.unlink()

    with tarfile.open(tar_path, "w:gz") as tf:
        tf.add(linux_stage, arcname="OpenBGR")

    print(f"[Release] Built Linux tarball    : {tar_path}")
    return tar_path


if __name__ == "__main__":
    sys_name = platform.system()
    if sys_name == "Darwin":
        build_macos_dmg()
    build_windows_release()
    build_linux_release()
