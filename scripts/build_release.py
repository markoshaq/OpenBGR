#!/usr/bin/env python3
"""
OpenBGR - Cross-Platform Lightweight Desktop Release Builder
============================================================
Builds lightweight native desktop packages that keep
download sizes under ~1 MB while automatically provisioning the local AI
runtime (`.venv` / `~/.openbgr/venv`) and opening a native `pywebview` desktop
window:

- macOS   : `dist/OpenBGR-macOS.dmg` (containing `OpenBGR.app` + `/Applications` link)
- Windows : `dist/OpenBGR-Setup.exe` (thin Inno Setup installer) + `dist/OpenBGR-Windows.zip`
- Linux   : `dist/OpenBGR-Linux.tar.gz` (containing `OpenBGR` launcher + `.desktop` file)
"""

from __future__ import annotations

import math
import os
import platform
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
DIST_DIR = ROOT_DIR / "dist"


def _read_version() -> str:
    """Reads `version` from `pyproject.toml`; fails loudly rather than silently shipping mislabeled artifacts."""
    try:
        m = re.search(
            r'^version\s*=\s*"([^"]+)"',
            (ROOT_DIR / "pyproject.toml").read_text(encoding="utf-8"),
            re.MULTILINE,
        )
        if m:
            return m.group(1)
    except OSError:
        pass
    raise RuntimeError(
        f"Cannot determine version: {ROOT_DIR / 'pyproject.toml'} is missing or unreadable."
    )


APP_VERSION = _read_version()

APP_FILES = [
    "app.py",
    "pyproject.toml",
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
        from PIL import Image

        from openbgr import icon_render
    except ImportError:
        return

    with tempfile.TemporaryDirectory() as tmp:
        iconset_dir = Path(tmp) / "OpenBGR.iconset"
        iconset_dir.mkdir(parents=True, exist_ok=True)

        base_img = icon_render.render_icon(1024)
        try:
            for sz in (16, 32, 128, 256, 512):
                with base_img.resize((sz, sz), Image.Resampling.LANCZOS) as img_1x:
                    img_1x.save(iconset_dir / f"icon_{sz}x{sz}.png")
                with base_img.resize((sz * 2, sz * 2), Image.Resampling.LANCZOS) as img_2x:
                    img_2x.save(iconset_dir / f"icon_{sz}x{sz}@2x.png")
        finally:
            base_img.close()

        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset_dir), "-o", str(icns_path)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def generate_windows_ico(ico_path: Path) -> bool:
    """Generates a multi-size Windows `OpenBGR.ico` via Pillow and `icon_render`."""
    try:
        import sys

        sys.path.insert(0, str(ROOT_DIR))
        from openbgr import icon_render
    except ImportError:
        return False

    try:
        base_img = icon_render.render_icon(256)
        base_img.save(
            ico_path,
            format="ICO",
            sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
        )
        base_img.close()
        return ico_path.is_file()
    except Exception:
        return False


def generate_linux_png(png_path: Path) -> bool:
    """Generates a 512x512 `icon.png` for the Linux bundle via Pillow and `icon_render`."""
    try:
        import sys

        sys.path.insert(0, str(ROOT_DIR))
        from openbgr import icon_render
    except ImportError:
        return False

    try:
        base_img = icon_render.render_icon(512)
        base_img.save(png_path, format="PNG")
        base_img.close()
        return png_path.is_file()
    except Exception:
        return False


# -- DMG window art ------------------------------------------------------------
# Mirrors the app's blank-splash viewport: the transparency checkerboard
# (--checker-a/--checker-b), a dashed hairline dropzone frame (--border-strong),
# and letter-spaced monospace captions (--mono) on the carbon base.
DMG_WINDOW_W = 660
DMG_WINDOW_H = 420
DMG_ICON_SIZE = 96
DMG_ICON_POS = {"OpenBGR.app": (190, 196), "Applications": (470, 196)}

_CHECKER_A = (22, 22, 26)  # --checker-a #16161a
_CHECKER_B = (14, 14, 17)  # --checker-b #0e0e11
_BORDER = (63, 63, 70)  # --border-strong #3f3f46
_MUTED = (142, 142, 147)  # --muted #8e8e93
_TEXT = (250, 250, 250)  # --text #fafafa


def _dmg_mono_font(size: int, bold: bool = False):
    from PIL import ImageFont

    for path in ("/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Courier.ttc"):
        try:
            if Path(path).exists():
                return ImageFont.truetype(path, size, index=1 if bold else 0)
        except Exception:
            continue
    return ImageFont.load_default()


def _draw_tracked_text(draw, x, y, text, font, fill, tracking, anchor="la") -> None:
    """Draws letter-spaced mono text; anchor: 'la' left, 'ma' center, 'ra' right."""
    widths = [draw.textlength(ch, font=font) for ch in text]
    total = sum(widths) + tracking * max(0, len(text) - 1)
    cx = x - total / 2 if anchor == "ma" else (x - total if anchor == "ra" else x)
    for ch, w in zip(text, widths, strict=False):
        draw.text((cx, y), ch, font=font, fill=fill)
        cx += w + tracking


def _dashed_line(draw, p1, p2, fill, width, dash, gap) -> None:
    x1, y1 = p1
    x2, y2 = p2
    length = math.hypot(x2 - x1, y2 - y1)
    if not length:
        return
    ux, uy = (x2 - x1) / length, (y2 - y1) / length
    d = 0.0
    while d < length:
        e = min(d + dash, length)
        draw.line([(x1 + ux * d, y1 + uy * d), (x1 + ux * e, y1 + uy * e)], fill=fill, width=width)
        d = e + gap


def generate_dmg_background(bg_dir: Path) -> bool:
    """Renders the splash-style checkerboard DMG window art (`background.png` + `@2x`)."""
    try:
        import sys

        sys.path.insert(0, str(ROOT_DIR))
        from PIL import Image, ImageDraw
    except ImportError:
        return False

    S = 2
    W = DMG_WINDOW_W
    H = DMG_WINDOW_H + 40  # extra checkerboard rows below the frame: bottom-edge bleed
    img = Image.new("RGB", (W * S, H * S), _CHECKER_B)
    draw = ImageDraw.Draw(img)

    cell = 10 * S
    for row in range((H * S) // cell):
        for col in range((W * S) // cell + 1):
            if (row + col) % 2 == 0:
                x0, y0 = col * cell, row * cell
                draw.rectangle([x0, y0, x0 + cell, y0 + cell], fill=_CHECKER_A)

    inset = 16 * S
    for p1, p2 in (
        ((inset, inset), (W * S - inset, inset)),
        ((W * S - inset, inset), (W * S - inset, DMG_WINDOW_H * S - inset)),
        ((W * S - inset, DMG_WINDOW_H * S - inset), (inset, DMG_WINDOW_H * S - inset)),
        ((inset, DMG_WINDOW_H * S - inset), (inset, inset)),
    ):
        _dashed_line(draw, p1, p2, _BORDER, S, 6 * S, 4 * S)

    font_caption = _dmg_mono_font(11 * S)
    font_title = _dmg_mono_font(12 * S)
    _draw_tracked_text(
        draw,
        W * S // 2,
        118 * S,
        f"OpenBGR v{APP_VERSION}",
        font_title,
        _TEXT,
        1 * S,
        anchor="ma",
    )

    # Hairline arrow bridging the gap between the app icon and Applications
    arrow_y = 196 * S
    ax1, ax2 = 262 * S, 400 * S
    draw.line([(ax1, arrow_y), (ax2 - 12 * S, arrow_y)], fill=_MUTED, width=S)
    draw.polygon(
        [(ax2 - 12 * S, arrow_y - 5 * S), (ax2, arrow_y), (ax2 - 12 * S, arrow_y + 5 * S)],
        fill=_MUTED,
    )

    _draw_tracked_text(
        draw,
        W * S // 2,
        292 * S,
        "Drag into Applications to install",
        font_caption,
        (255, 255, 255),
        2 * S,
        anchor="ma",
    )

    img.save(bg_dir / "background@2x.png")
    with img.resize((W, H), Image.Resampling.LANCZOS) as img_1x:
        img_1x.save(bg_dir / "background.png")
    img.close()
    return True


def _style_dmg_volume(tmp_dir: str, has_background: bool) -> None:
    """Persists icon positions, window bounds and background into the volume's .DS_Store."""
    bg_line = (
        '    set background picture of opts to file ".background:background.png"'
        if has_background
        else ""
    )
    positions = "\n".join(
        f'    set position of item "{name}" of container_window to {{{x}, {y}}}'
        for name, (x, y) in DMG_ICON_POS.items()
    )
    script = f"""tell application "Finder"
  activate
  tell disk "OpenBGR"
    open
    delay 1
    set container_window to container window
    set current view of container_window to icon view
    set toolbar visible of container_window to false
    set statusbar visible of container_window to false
    set bounds of container_window to {{300, 120, {300 + DMG_WINDOW_W}, {120 + DMG_WINDOW_H + 28}}}
    set opts to icon view options of container_window
    set arrangement of opts to not arranged
    set icon size of opts to {DMG_ICON_SIZE}
    set text size of opts to 12
{bg_line}
{positions}
    set extension hidden of item "OpenBGR.app" of container_window to true
    update without registering applications
    delay 2
    close
    delay 1
    open
    delay 1
    update without registering applications
    delay 1
    close
  end tell
end tell
"""
    script_path = Path(tmp_dir) / "style_dmg.applescript"
    script_path.write_text(script, encoding="utf-8")
    result = subprocess.run(
        ["osascript", str(script_path)], check=False, capture_output=True, text=True
    )
    if result.returncode != 0:
        print(
            f"[Release] Warning: Finder styling failed (DMG still valid): {result.stderr.strip()}"
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
    _prune_macos_payload(payload_dir)
    generate_macos_icns(resources_dir / "OpenBGR.icns")

    info_plist = f"""<?xml version="1.0" encoding="UTF-8"?>
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
    <string>{APP_VERSION}</string>
    <key>CFBundleVersion</key>
    <string>{APP_VERSION}</string>
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

        # Splash-style window art. The custom volume icon (.VolumeIcon.icns) is
        # deliberately NOT staged here: Finder consumes the file and clears the
        # custom-icon bit while styling, so it is re-copied onto the mounted
        # volume afterwards instead.
        bg_dir = stage_dir / ".background"
        bg_dir.mkdir()
        has_background = generate_dmg_background(bg_dir)
        if not has_background:
            bg_dir.rmdir()

        # Finder window styling is stored in the volume's .DS_Store, which can
        # only be written on a read-write image: UDRW -> attach -> AppleScript
        # -> detach -> compress to read-only UDZO.
        rw_dmg = Path(stage_tmp) / "OpenBGR-rw.dmg"
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
                "UDRW",
                "-fs",
                "HFS+",
                str(rw_dmg),
            ],
            check=True,
        )

        subprocess.run(["hdiutil", "detach", "/Volumes/OpenBGR"], check=False, capture_output=True)
        attach = subprocess.run(
            [
                "hdiutil",
                "attach",
                "-readwrite",
                "-noverify",
                "-mountpoint",
                "/Volumes/OpenBGR",
                str(rw_dmg),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        if attach.returncode == 0 and Path("/Volumes/OpenBGR").is_dir():
            try:
                _style_dmg_volume(stage_tmp, has_background)
                icns_src = resources_dir / "OpenBGR.icns"
                if icns_src.exists():
                    shutil.copy2(icns_src, "/Volumes/OpenBGR/.VolumeIcon.icns")
                    if shutil.which("SetFile"):
                        subprocess.run(["SetFile", "-a", "C", "/Volumes/OpenBGR"], check=False)
            finally:
                subprocess.run(["sync"], check=False)
                for _ in range(5):
                    d = subprocess.run(
                        ["hdiutil", "detach", "/Volumes/OpenBGR"],
                        check=False,
                        capture_output=True,
                    )
                    if d.returncode == 0:
                        break
                    time.sleep(1)
                else:
                    subprocess.run(["hdiutil", "detach", "-force", "/Volumes/OpenBGR"], check=False)
        else:
            print("[Release] Warning: could not mount read-write image; DMG will be unstyled")

        subprocess.run(
            [
                "hdiutil",
                "convert",
                str(rw_dmg),
                "-format",
                "UDZO",
                "-imagekey",
                "zlib-level=9",
                "-o",
                str(dmg_path),
            ],
            check=True,
        )

    shutil.rmtree(app_bundle)
    print(f"[Release] Built macOS disk image : {dmg_path}")
    return dmg_path


def _find_csc() -> str | None:
    """Finds the .NET Framework C# compiler used for the tiny Windows launcher."""
    if found := shutil.which("csc"):
        return found
    candidates = [
        r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
        r"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe",
    ]
    return next((p for p in candidates if os.path.exists(p)), None)


def _prune_payload(stage_dir: Path, paths: tuple[str, ...]) -> None:
    """Removes platform-irrelevant files and Python bytecode caches from a payload."""
    for rel in paths:
        target = stage_dir / rel
        if target.is_symlink() or target.is_file():
            target.unlink(missing_ok=True)
        elif target.is_dir():
            shutil.rmtree(target)
    for path in list(stage_dir.rglob("__pycache__")):
        shutil.rmtree(path)


def _prune_macos_payload(stage_dir: Path) -> None:
    """Keeps only the files needed by the bundled macOS app."""
    _prune_payload(
        stage_dir,
        (
            "start.sh",
            "start.bat",
            "Start Mac.command",
            "scripts/install_linux_integration.sh",
            "scripts/install_windows_context_menu.bat",
            "scripts/uninstall_windows_context_menu.bat",
            "scripts/make_dev_bundle.py",
        ),
    )


def _prune_windows_payload(stage_dir: Path) -> None:
    """Keeps only the files needed by the Windows installer and portable ZIP."""
    _prune_payload(
        stage_dir,
        (
            "start.sh",
            "Start Mac.command",
            "scripts/context_process.sh",
            "scripts/install_linux_integration.sh",
            "scripts/install_macos_quick_action.py",
            "scripts/make_dev_bundle.py",
        ),
    )


def _prune_linux_payload(stage_dir: Path) -> None:
    """Keeps only the files needed by the Linux archive."""
    _prune_payload(
        stage_dir,
        (
            "start.bat",
            "Start Mac.command",
            "scripts/install_macos_quick_action.py",
            "scripts/install_windows_context_menu.bat",
            "scripts/uninstall_windows_context_menu.bat",
            "scripts/make_dev_bundle.py",
        ),
    )


def _find_iscc() -> str | None:
    """Finds Inno Setup's command-line compiler (`ISCC.exe`)."""
    if found := shutil.which("iscc") or shutil.which("ISCC"):
        return found
    candidates = [
        r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
        r"C:\Program Files\Inno Setup 6\ISCC.exe",
        r"C:\ProgramData\chocolatey\lib\innosetup\tools\ISCC.exe",
    ]
    return next((p for p in candidates if os.path.exists(p)), None)


def _compile_windows_launcher(exe_file: Path, ico_file: Path) -> bool:
    """Compiles the zero-dependency C# `OpenBGR.exe` launcher on Windows hosts."""
    csc_exe = _find_csc()
    if not csc_exe:
        return False
    cs_file = exe_file.with_suffix(".cs")
    cs_file.write_text(
        (ROOT_DIR / "scripts" / "OpenBGR.cs").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    csc_cmd = [
        csc_exe,
        "/target:winexe",
        "/reference:System.Windows.Forms.dll",
        "/reference:System.Drawing.dll",
        f"/out:{exe_file}",
    ]
    if ico_file.is_file():
        csc_cmd.append(f"/win32icon:{ico_file}")
    csc_cmd.append(str(cs_file))
    result = subprocess.run(csc_cmd, check=False, capture_output=True, text=True)
    cs_file.unlink(missing_ok=True)
    if result.returncode != 0 or not exe_file.is_file():
        print(f"[Release] Warning: OpenBGR.exe compilation failed: {result.stderr.strip()}")
        return False
    return True


def build_windows_installer(win_stage: Path) -> Path | None:
    """
    Compiles the thin `dist/OpenBGR-Setup.exe` Inno Setup installer from `win_stage`
    when running on Windows with `ISCC.exe` available. No Python or PyTorch runtime
    is embedded, so compilation completes in seconds.
    """
    if platform.system() != "Windows":
        return None
    iscc = _find_iscc()
    if not iscc:
        print("[Release] Skipping Windows installer: Inno Setup 6 (ISCC.exe) not found")
        return None

    setup_path = DIST_DIR / "OpenBGR-Setup.exe"
    setup_path.unlink(missing_ok=True)
    iscc_cmd = [
        iscc,
        "/Qp",
        f"/DMyAppVersion={APP_VERSION}",
        f"/DSourceDir={win_stage}",
        f"/DOutputDir={DIST_DIR}",
        "/DOutputBaseFilename=OpenBGR-Setup",
        str(ROOT_DIR / "scripts" / "OpenBGR.iss"),
    ]
    subprocess.run(iscc_cmd, check=True)
    print(f"[Release] Built Windows installer: {setup_path}")
    return setup_path


def build_windows_release() -> Path:
    """
    Builds `dist/OpenBGR-Windows.zip` and, on Windows hosts with Inno Setup 6,
    the thin `dist/OpenBGR-Setup.exe` installer (both containing the compiled
    `OpenBGR.exe` first-run bootstrapper and application payload).
    """
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    win_stage = DIST_DIR / "OpenBGR-Windows"
    if win_stage.exists():
        shutil.rmtree(win_stage)

    copy_project_payload(win_stage)
    _prune_windows_payload(win_stage)
    ico_file = win_stage / "OpenBGR.ico"
    generate_windows_ico(ico_file)
    _compile_windows_launcher(win_stage / "OpenBGR.exe", ico_file)

    zip_path = DIST_DIR / "OpenBGR-Windows.zip"
    if zip_path.exists():
        zip_path.unlink()

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in win_stage.rglob("*"):
            if file_path.is_file():
                arcname = Path("OpenBGR") / file_path.relative_to(win_stage)
                zf.write(file_path, arcname)

    print(f"[Release] Built Windows archive  : {zip_path}")
    build_windows_installer(win_stage)
    shutil.rmtree(win_stage)
    return zip_path


def build_linux_release() -> Path:
    """Builds `dist/OpenBGR-Linux.tar.gz` with a `.desktop` launcher entry."""
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    linux_stage = DIST_DIR / "OpenBGR-Linux"
    if linux_stage.exists():
        shutil.rmtree(linux_stage)

    copy_project_payload(linux_stage)
    _prune_linux_payload(linux_stage)
    generate_linux_png(linux_stage / "icon.png")
    make_executable(linux_stage / "start.sh")

    desktop_entry = """[Desktop Entry]
Type=Application
Name=OpenBGR
Comment=Local AI Background Removal Studio
Exec=sh -c 'cd "$(dirname "$1")" && shift && exec ./start.sh "$@"' _ %k %F
Icon=openbgr
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

    shutil.rmtree(linux_stage)
    print(f"[Release] Built Linux tarball    : {tar_path}")
    return tar_path


if __name__ == "__main__":
    sys_name = platform.system()
    if sys_name == "Darwin":
        build_macos_dmg()
    build_windows_release()
    build_linux_release()
