"""
Native OS bridges used by Quick Action runs: clipboard writes, save/folder
dialogs, and notification dispatch (including the bundled macOS notifier
`.app` that gives banners the OpenBGR squircle icon and title).
"""

from __future__ import annotations

import os
import platform
import plistlib
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from PIL import Image

from .config import (
    APP_CONFIG_DIR,
    BASE_DIR,
    NOTIFIER_APP_PATH,
    NOTIFIER_ICNS_PATH,
    ensure_app_icon,
    logger,
)


def _osascript_quote(text: Any) -> str:
    """Escapes a string for interpolation inside an AppleScript double-quoted literal."""
    return str(text).replace("\\", "\\\\").replace('"', '\\"')


def _powershell_quote(text: Any) -> str:
    """Escapes a string for interpolation inside a PowerShell single-quoted literal."""
    return str(text).replace("'", "''")


def copy_png_bytes_to_clipboard(raw_bytes: bytes) -> dict[str, Any]:
    """
    Writes raw 32-bit RGBA PNG bytes directly to the native OS clipboard across
    macOS (NSPasteboard), Windows (.NET Clipboard), and Linux (wl-copy/xclip).
    """
    try:
        sys_name = platform.system()

        if sys_name == "Darwin":
            import AppKit  # type: ignore
            import Foundation  # type: ignore

            pb = AppKit.NSPasteboard.generalPasteboard()
            pb.clearContents()
            ns_data = Foundation.NSData.dataWithBytes_length_(raw_bytes, len(raw_bytes))
            ok = pb.setData_forType_(ns_data, AppKit.NSPasteboardTypePNG)
            return {"copied": bool(ok)}

        if sys_name == "Windows":
            try:
                import clr  # type: ignore

                clr.AddReference("System.Windows.Forms")
                clr.AddReference("System.Drawing")
                import System.Drawing as Drawing  # type: ignore
                import System.IO as SysIO  # type: ignore
                import System.Threading as SysThreading  # type: ignore
                import System.Windows.Forms as WinForms  # type: ignore

                err_holder: list[str] = []

                def _set_win_clip() -> None:
                    """Sets both PNG stream and bitmap clipboard formats (must run on an STA thread)."""
                    try:
                        ms = SysIO.MemoryStream(raw_bytes)
                        bmp = Drawing.Bitmap(ms)
                        data_obj = WinForms.DataObject()
                        data_obj.SetData("PNG", False, ms)
                        data_obj.SetImage(bmp)
                        WinForms.Clipboard.SetDataObject(data_obj, True)
                    except Exception as e:
                        err_holder.append(str(e))

                t = SysThreading.Thread(SysThreading.ThreadStart(_set_win_clip))
                t.SetApartmentState(SysThreading.ApartmentState.STA)
                t.Start()
                t.Join(3000)
                if err_holder:
                    return {"copied": False, "error": err_holder[0]}
                return {"copied": True}
            except ImportError:
                with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
                    tf.write(raw_bytes)
                    tmp_png = tf.name
                try:
                    ps = (
                        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; "
                        f"$p = '{_powershell_quote(tmp_png)}'; "
                        "$bytes = [System.IO.File]::ReadAllBytes($p); "
                        "$ms = New-Object System.IO.MemoryStream(,$bytes); "
                        "$bmp = New-Object System.Drawing.Bitmap($ms); "
                        "$do = New-Object System.Windows.Forms.DataObject; "
                        "$do.SetData('PNG', $false, $ms); "
                        "$do.SetImage($bmp); "
                        "[System.Windows.Forms.Clipboard]::SetDataObject($do, $true)"
                    )
                    proc = subprocess.run(
                        ["powershell", "-NoProfile", "-Sta", "-Command", ps],
                        capture_output=True,
                        timeout=6,
                    )
                    if proc.returncode == 0:
                        return {"copied": True}
                finally:
                    Path(tmp_png).unlink(missing_ok=True)
                return {"copied": False, "error": "Windows clipboard write failed."}

        for cmd in (
            ["wl-copy", "--type", "image/png"],
            ["xclip", "-selection", "clipboard", "-t", "image/png", "-i"],
        ):
            if shutil.which(cmd[0]):
                proc = subprocess.run(
                    cmd,
                    input=raw_bytes,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                    timeout=4,
                )
                if proc.returncode == 0:
                    return {"copied": True}

        return {"copied": False, "error": "No native clipboard utility found."}
    except Exception as exc:
        return {"copied": False, "error": str(exc)}


def _run_dialog_command(cmd: list[str], timeout: int = 180) -> Path | None:
    """Runs a native file/folder dialog helper, returning the chosen path or None."""
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    chosen = res.stdout.strip()
    return Path(chosen) if res.returncode == 0 and chosen else None


def choose_save_path_native(default_name: str, start_dir: Path) -> Path | None:
    """Pops a native OS Save-As dialog brought to the foreground."""
    sys_name = platform.system()
    try:
        if sys_name == "Darwin":
            script = (
                'tell application "System Events"\n'
                "  activate\n"
                '  POSIX path of (choose file name with prompt "Save cutout as:" '
                f'default name "{_osascript_quote(default_name)}" '
                f'default location (POSIX file "{_osascript_quote(start_dir)}"))\n'
                "end tell"
            )
            return _run_dialog_command(["osascript", "-e", script])
        if sys_name == "Windows":
            ps = (
                "Add-Type -AssemblyName System.Windows.Forms; "
                "$f = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}; "
                "$d = New-Object System.Windows.Forms.SaveFileDialog; "
                f"$d.FileName = '{_powershell_quote(default_name)}'; "
                f"$d.InitialDirectory = '{_powershell_quote(start_dir)}'; "
                "$d.Filter = 'Image Files (*.png;*.webp;*.jpg)|*.png;*.webp;*.jpg|All files (*.*)|*.*'; "
                "if ($d.ShowDialog($f) -eq 'OK') { $d.FileName }; "
                "$f.Dispose()"
            )
            return _run_dialog_command(["powershell", "-NoProfile", "-Sta", "-Command", ps])
        zenity = shutil.which("zenity")
        if zenity:
            return _run_dialog_command(
                [
                    zenity,
                    "--file-selection",
                    "--save",
                    "--confirm-overwrite",
                    f"--filename={start_dir / default_name}",
                ]
            )
        kdialog = shutil.which("kdialog")
        if kdialog:
            return _run_dialog_command(
                [
                    kdialog,
                    "--title",
                    "Save cutout as:",
                    "--getsavefilename",
                    str(start_dir / default_name),
                ]
            )
    except Exception as exc:
        logger.warning("[QuickAction] Save dialog failed: %s", exc)
    return None


def choose_output_folder_native(start_dir: Path, count: int) -> Path | None:
    """Pops a single native OS Choose-Folder dialog when saving multiple Quick Action cutouts."""
    sys_name = platform.system()
    prompt = f"Choose destination folder for {count} cutouts:"
    try:
        if sys_name == "Darwin":
            script = (
                'tell application "System Events"\n'
                "  activate\n"
                f'  POSIX path of (choose folder with prompt "{_osascript_quote(prompt)}" '
                f'default location (POSIX file "{_osascript_quote(start_dir)}"))\n'
                "end tell"
            )
            return _run_dialog_command(["osascript", "-e", script])
        if sys_name == "Windows":
            ps = (
                "Add-Type -AssemblyName System.Windows.Forms; "
                "$f = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}; "
                "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
                f"$d.Description = '{_powershell_quote(prompt)}'; "
                f"$d.SelectedPath = '{_powershell_quote(start_dir)}'; "
                "if ($d.ShowDialog($f) -eq 'OK') { $d.SelectedPath }; "
                "$f.Dispose()"
            )
            return _run_dialog_command(["powershell", "-NoProfile", "-Sta", "-Command", ps])
        zenity = shutil.which("zenity")
        if zenity:
            return _run_dialog_command(
                [
                    zenity,
                    "--file-selection",
                    "--directory",
                    f"--title={prompt}",
                    f"--filename={start_dir}/",
                ]
            )
        kdialog = shutil.which("kdialog")
        if kdialog:
            return _run_dialog_command(
                [
                    kdialog,
                    "--title",
                    prompt,
                    "--getexistingdirectory",
                    str(start_dir),
                ]
            )
    except Exception as exc:
        logger.warning("[QuickAction] Folder dialog failed: %s", exc)
    return None


def ensure_macos_notifier_app() -> Path | None:
    """
    Builds (once) a lightweight background AppleScript droplet bundle in
    `~/.openbgr/OpenBGRNotifier.app` stamped with the OpenBGR squircle `.icns`
    and `LSUIElement=True` so macOS Notification Center banners display the
    OpenBGR title and rounded squircle icon without bouncing in the Dock.

    The notification text is delivered as a temp file opened with the droplet
    (`on open argv`): `open --args` -> `on run argv` never reaches the run
    handler on recent macOS releases, while the odoc/droplet path still works.
    """
    if platform.system() != "Darwin":
        return None
    try:
        droplet_bin = NOTIFIER_APP_PATH / "Contents" / "MacOS" / "droplet"
        applet_icns = NOTIFIER_APP_PATH / "Contents" / "Resources" / "applet.icns"
        if droplet_bin.is_file() and applet_icns.is_file():
            return NOTIFIER_APP_PATH

        APP_CONFIG_DIR.mkdir(parents=True, exist_ok=True)

        # Ensure we have the squircle .icns in ~/.openbgr/OpenBGR.icns
        if not NOTIFIER_ICNS_PATH.is_file():
            for cand in (
                BASE_DIR / ".venv" / "OpenBGR.app" / "Contents" / "Resources" / "OpenBGR.icns",
                BASE_DIR / "dist" / "OpenBGR.app" / "Contents" / "Resources" / "OpenBGR.icns",
                Path("/Applications/OpenBGR.app/Contents/Resources/OpenBGR.icns"),
            ):
                if cand.is_file():
                    shutil.copy2(cand, NOTIFIER_ICNS_PATH)
                    break
        if not NOTIFIER_ICNS_PATH.is_file():
            from . import icon_render

            with tempfile.TemporaryDirectory() as tmp:
                iconset = Path(tmp) / "OpenBGR.iconset"
                iconset.mkdir(parents=True, exist_ok=True)
                base_img = icon_render.render_icon(1024)
                try:
                    for sz in (16, 32, 128, 256, 512):
                        with base_img.resize((sz, sz), Image.Resampling.LANCZOS) as img_1x:
                            img_1x.save(iconset / f"icon_{sz}x{sz}.png")
                        with base_img.resize((sz * 2, sz * 2), Image.Resampling.LANCZOS) as img_2x:
                            img_2x.save(iconset / f"icon_{sz}x{sz}@2x.png")
                finally:
                    base_img.close()
                subprocess.run(
                    [
                        "iconutil",
                        "-c",
                        "icns",
                        str(iconset),
                        "-o",
                        str(NOTIFIER_ICNS_PATH),
                    ],
                    check=False,
                    capture_output=True,
                    timeout=15,
                )

        if NOTIFIER_APP_PATH.exists():
            shutil.rmtree(NOTIFIER_APP_PATH)

        osa_src = (
            "on open argv\n"
            "  repeat with f in argv\n"
            "    try\n"
            "      set fp to POSIX path of f\n"
            '      set msg to do shell script "cat " & quoted form of fp\n'
            '      display notification msg with title "OpenBGR"\n'
            '      do shell script "rm -f " & quoted form of fp\n'
            "    end try\n"
            "  end repeat\n"
            "end open\n"
            "on run\n"
            "  try\n"
            '    do shell script "open -b com.markoshaq.openbgr || open -b com.openbgr.dev || true"\n'
            "  end try\n"
            "end run\n"
        )
        subprocess.run(
            ["osacompile", "-o", str(NOTIFIER_APP_PATH), "-e", osa_src],
            check=True,
            capture_output=True,
            timeout=30,
        )
        if NOTIFIER_ICNS_PATH.is_file():
            shutil.copy2(NOTIFIER_ICNS_PATH, applet_icns)

        plist_path = NOTIFIER_APP_PATH / "Contents" / "Info.plist"
        with open(plist_path, "rb") as fh:
            plist = plistlib.load(fh)
        plist["CFBundleName"] = "OpenBGR"
        plist["CFBundleDisplayName"] = "OpenBGR"
        plist["CFBundleIdentifier"] = "com.markoshaq.openbgr.notifier"
        plist["LSUIElement"] = True
        plist["CFBundleIconFile"] = "applet"
        # CFBundleIconName resolves the banner icon from Assets.car, which
        # osacompile builds with the generic Script Editor scroll; drop both
        # so macOS falls back to applet.icns (the OpenBGR squircle).
        plist.pop("CFBundleIconName", None)
        with open(plist_path, "wb") as fh:
            plistlib.dump(plist, fh)
        assets_car = NOTIFIER_APP_PATH / "Contents" / "Resources" / "Assets.car"
        if assets_car.exists():
            assets_car.unlink()

        subprocess.run(
            [
                "codesign",
                "--force",
                "--deep",
                "--sign",
                "-",
                str(NOTIFIER_APP_PATH),
            ],
            check=False,
            capture_output=True,
            timeout=30,
        )
        return NOTIFIER_APP_PATH
    except Exception as exc:
        logger.warning("[QuickAction] Failed to build macOS notifier app: %s", exc)
        return None


def format_quick_action_notification(
    succeeded_names: list[str], failed_count: int = 0
) -> str | None:
    """
    Formats the completion notification message:
    - 1 image  : `Background removed for "image.png"`
    - N images : `Background removed for N images.`
    """
    ok = len(succeeded_names)
    if ok == 1 and failed_count == 0:
        return f'Background removed for "{succeeded_names[0]}"'
    if ok > 1 and failed_count == 0:
        return f"Background removed for {ok} images."
    if ok > 0 and failed_count > 0:
        label = f'"{succeeded_names[0]}"' if ok == 1 else f"{ok} images"
        return f"Background removed for {label} ({failed_count} failed)."
    if ok == 0 and failed_count > 0:
        return (
            "Failed to remove background."
            if failed_count == 1
            else f"Failed to remove background for {failed_count} images."
        )
    return None


def send_openbgr_notification(message: str) -> None:
    """Dispatches a native OS notification with title `OpenBGR` and the squircle icon."""
    if not message:
        return
    sys_name = platform.system()
    try:
        if sys_name == "Darwin":
            notifier = ensure_macos_notifier_app()
            if notifier is not None and notifier.exists():
                # Prune message files left behind by notifications that never
                # posted (droplet launch failed); 60s guards in-flight posts.
                cutoff = time.time() - 60
                for stale in APP_CONFIG_DIR.glob(".notify-*.txt"):
                    try:
                        if stale.stat().st_mtime < cutoff:
                            stale.unlink()
                    except OSError:
                        pass
                try:
                    fd, msg_path = tempfile.mkstemp(
                        prefix=".notify-", suffix=".txt", dir=APP_CONFIG_DIR
                    )
                    with os.fdopen(fd, "w", encoding="utf-8") as fh:
                        fh.write(message)
                    subprocess.run(
                        ["open", "-a", str(notifier), msg_path],
                        check=False,
                        capture_output=True,
                        timeout=10,
                    )
                except Exception:
                    try:
                        Path(msg_path).unlink(missing_ok=True)
                    except (UnboundLocalError, OSError):
                        pass
                return
            subprocess.run(
                [
                    "osascript",
                    "-e",
                    f'display notification "{_osascript_quote(message)}" with title "OpenBGR"',
                ],
                check=False,
                capture_output=True,
                timeout=10,
            )
            return
        if sys_name == "Windows":
            win_icon = ensure_app_icon() or ""
            ps = (
                "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; "
                "$n = New-Object System.Windows.Forms.NotifyIcon; "
                f"$ico = '{_powershell_quote(win_icon)}'; "
                "if ($ico -and (Test-Path $ico)) { "
                "  $bmp = [System.Drawing.Bitmap]::FromFile($ico); "
                "  $n.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon()) "
                "} else { "
                "  $n.Icon = [System.Drawing.SystemIcons]::Application "
                "}; "
                "$n.BalloonTipTitle = 'OpenBGR'; "
                f"$n.BalloonTipText = '{_powershell_quote(message)}'; "
                "$n.Visible = $true; "
                "$n.ShowBalloonTip(5000); "
                "Start-Sleep -Seconds 6; "
                "$n.Dispose()"
            )
            subprocess.Popen(
                ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return
        if sys_name == "Linux" and shutil.which("notify-send"):
            icon_path = ensure_app_icon()
            cmd = ["notify-send", "--app-name=OpenBGR"]
            if icon_path:
                cmd.append(f"--icon={icon_path}")
            cmd.extend(["OpenBGR", message])
            subprocess.run(cmd, check=False, capture_output=True, timeout=5)
    except Exception as exc:
        logger.warning("[QuickAction] Notification failed: %s", exc)
