"""
OS Quick Action / context-menu configuration, native Save/Folder dialogs,
clipboard integration, notification dispatch, and headless CLI runner.
"""

from __future__ import annotations

import io
import json
import os
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Optional

from PIL import Image

from .config import (
    APP_CONFIG_DIR,
    BASE_DIR,
    DEFAULT_QUICK_ACTION_CONFIG,
    NOTIFIER_APP_PATH,
    NOTIFIER_ICNS_PATH,
    QUICK_ACTION_CONFIG_PATH,
    RECOMMENDED_TIER,
    TIERS,
    ensure_app_icon,
    normalize_tier_key,
)
from .models import MANAGER
from .pipeline import segment_foreground


def _resolve_app_symbol(name: str, fallback: Any) -> Any:
    """Honors `unittest.mock.patch.object(app, name, ...)` when called via `app`."""
    app_mod = sys.modules.get("app")
    if app_mod is not None and hasattr(app_mod, name):
        return getattr(app_mod, name)
    return fallback


def sanitize_quick_action_config(raw: Any) -> dict[str, Any]:
    """Validates a Quick Action config dict against allowed values and falls back to defaults."""
    src = raw if isinstance(raw, dict) else {}
    raw_tier = str(src.get("tier", "auto") or "auto").strip().lower()
    if raw_tier != "auto":
        norm_t = normalize_tier_key(raw_tier)
        tier_val = norm_t if norm_t in TIERS else "auto"
    else:
        tier_val = "auto"

    save_mode = (
        str(src.get("save_mode", "same_folder") or "same_folder").strip().lower()
    )
    if save_mode not in ("same_folder", "ask"):
        save_mode = "same_folder"

    fmt = str(src.get("format", "png") or "png").strip().lower()
    if fmt not in ("png", "webp", "jpg", "mask"):
        fmt = "png"

    def _to_bool(val: Any, fallback: bool) -> bool:
        if isinstance(val, bool):
            return val
        if isinstance(val, (int, float)):
            return bool(val)
        if isinstance(val, str):
            return val.strip().lower() in ("1", "true", "yes", "on")
        return fallback

    return {
        "tier": tier_val,
        "save_mode": save_mode,
        "format": fmt,
        "edge_refine": _to_bool(src.get("edge_refine"), True),
        "copy_clipboard": _to_bool(src.get("copy_clipboard"), False),
        "notify": _to_bool(src.get("notify"), True),
    }


def load_quick_action_config() -> dict[str, Any]:
    """Reads `~/.openbgr/quick_action.json` and returns a sanitized Quick Action config."""
    cfg_path: Path = _resolve_app_symbol(
        "QUICK_ACTION_CONFIG_PATH", QUICK_ACTION_CONFIG_PATH
    )
    try:
        if cfg_path.is_file():
            raw = json.loads(cfg_path.read_text(encoding="utf-8"))
            return sanitize_quick_action_config(raw)
    except Exception:
        pass
    return dict(DEFAULT_QUICK_ACTION_CONFIG)


def save_quick_action_config(cfg: dict[str, Any]) -> dict[str, Any]:
    """Writes a sanitized Quick Action config to `~/.openbgr/quick_action.json`."""
    clean = sanitize_quick_action_config(cfg)
    cfg_path: Path = _resolve_app_symbol(
        "QUICK_ACTION_CONFIG_PATH", QUICK_ACTION_CONFIG_PATH
    )
    try:
        cfg_path.parent.mkdir(parents=True, exist_ok=True)
        cfg_path.write_text(json.dumps(clean, indent=2), encoding="utf-8")
    except Exception:
        pass
    return clean


def is_quick_action_installed() -> bool:
    """Checks whether the OS right-click Quick Action / context menu is currently installed."""
    sys_name = platform.system()
    if sys_name == "Darwin":
        wf = (
            Path.home()
            / "Library"
            / "Services"
            / "Remove Background with OpenBGR.workflow"
            / "Contents"
            / "document.wflow"
        )
        return wf.is_file()
    if sys_name == "Windows":
        try:
            res = subprocess.run(
                [
                    "reg",
                    "query",
                    r"HKCU\Software\Classes\SystemFileAssociations\image\shell\OpenBGR.RemoveBG\command",
                ],
                capture_output=True,
                timeout=5,
            )
            return res.returncode == 0
        except Exception:
            return False
    kde = Path.home() / ".local/share/kio/servicemenus/openbgr-removebg.desktop"
    nautilus = (
        Path.home()
        / ".local/share/nautilus/scripts/Remove Background with OpenBGR"
    )
    return kde.is_file() or nautilus.is_file()


def set_quick_action_installed(install: bool = True) -> tuple[bool, str]:
    """Runs the platform Quick Action / context-menu installer or uninstaller."""
    sys_name = platform.system()
    try:
        if sys_name == "Darwin":
            script = BASE_DIR / "scripts" / "install_macos_quick_action.py"
            cmd = [sys.executable, str(script)] + ([] if install else ["--remove"])
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
            if res.returncode == 0:
                return True, (
                    "Installed Finder Quick Action."
                    if install
                    else "Removed Finder Quick Action."
                )
            return False, (
                res.stderr or res.stdout or "Failed to update Finder Quick Action."
            ).strip()
        if sys_name == "Windows":
            bat_name = (
                "install_windows_context_menu.bat"
                if install
                else "uninstall_windows_context_menu.bat"
            )
            script = BASE_DIR / "scripts" / bat_name
            res = subprocess.run(
                ["cmd.exe", "/c", str(script)],
                capture_output=True,
                text=True,
                timeout=20,
            )
            if res.returncode == 0:
                return True, (
                    "Installed Explorer context menu."
                    if install
                    else "Removed Explorer context menu."
                )
            return False, (
                res.stderr or res.stdout or "Failed to update Explorer context menu."
            ).strip()
        script = BASE_DIR / "scripts" / "install_linux_integration.sh"
        cmd = ["bash", str(script)] + ([] if install else ["--remove"])
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        if res.returncode == 0:
            return True, (
                "Installed desktop context menu."
                if install
                else "Removed desktop context menu."
            )
        return False, (
            res.stderr or res.stdout or "Failed to update desktop context menu."
        ).strip()
    except Exception as exc:
        return False, str(exc)


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
            ns_data = Foundation.NSData.dataWithBytes_length_(
                raw_bytes, len(raw_bytes)
            )
            ok = pb.setData_forType_(ns_data, AppKit.NSPasteboardTypePNG)
            return {"copied": bool(ok)}

        if sys_name == "Windows":
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

        for cmd in (
            ["wl-copy", "--type", "image/png"],
            ["xclip", "-selection", "clipboard", "-t", "image/png", "-i"],
        ):
            if shutil.which(cmd[0]):
                proc = subprocess.run(
                    cmd, input=raw_bytes, check=False, timeout=4
                )
                if proc.returncode == 0:
                    return {"copied": True}

        return {"copied": False, "error": "No native clipboard utility found."}
    except Exception as exc:
        return {"copied": False, "error": str(exc)}


def cutout_filename_for(fmt: str = "png") -> tuple[str, str]:
    """Returns `(suffix_tag, ext)` for a given export format."""
    fmt_clean = (fmt or "png").strip().lower()
    if fmt_clean == "mask":
        return "mask", "png"
    if fmt_clean in ("webp", "jpg", "png"):
        return "cutout", fmt_clean
    return "cutout", "png"


def _default_output_path(
    src: Path, fmt: str = "png", dest_dir: Optional[Path] = None
) -> Path:
    """Returns `<stem>-cutout.<ext>` in `dest_dir` (or beside `src`), uniquified with `-N`."""
    tag, ext = cutout_filename_for(fmt)
    folder = dest_dir if dest_dir is not None else src.parent
    candidate = folder / f"{src.stem}-{tag}.{ext}"
    n = 1
    while candidate.exists():
        candidate = folder / f"{src.stem}-{tag}-{n}.{ext}"
        n += 1
    return candidate


def encode_cutout_image(rgba_img: Image.Image, fmt: str = "png") -> bytes:
    """Encodes a 32-bit RGBA cutout PIL image into PNG, WebP, JPEG (white matte), or 8-bit Mask PNG."""
    fmt_clean = (fmt or "png").strip().lower()
    buf = io.BytesIO()
    try:
        if fmt_clean == "mask":
            alpha = rgba_img.getchannel("A")
            try:
                alpha.save(buf, format="PNG", compress_level=1)
            finally:
                alpha.close()
        elif fmt_clean == "webp":
            rgba_img.save(buf, format="WEBP", lossless=True, quality=100)
        elif fmt_clean == "jpg":
            bg = Image.new("RGB", rgba_img.size, (255, 255, 255))
            alpha = rgba_img.getchannel("A")
            try:
                bg.paste(rgba_img, mask=alpha)
                bg.save(buf, format="JPEG", quality=95, subsampling=0)
            finally:
                alpha.close()
                bg.close()
        else:
            rgba_img.save(buf, format="PNG", compress_level=1)
        return buf.getvalue()
    finally:
        buf.close()


def _osascript_quote(text: Any) -> str:
    """Escapes a string for interpolation inside an AppleScript double-quoted literal."""
    return str(text).replace("\\", "\\\\").replace('"', '\\"')


def _powershell_quote(text: Any) -> str:
    """Escapes a string for interpolation inside a PowerShell single-quoted literal."""
    return str(text).replace("'", "''")


def _with_output_suffix(path: Path, ext: str) -> Path:
    """Appends `.<ext>` when the chosen output path has no file extension."""
    if not path.suffix:
        return path.with_name(f"{path.name}.{ext}")
    return path


def _choose_save_path_native(
    default_name: str, start_dir: Path
) -> Optional[Path]:
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
            res = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True,
                text=True,
                timeout=180,
            )
            chosen = res.stdout.strip()
            return Path(chosen) if res.returncode == 0 and chosen else None
        if sys_name == "Windows":
            ps = (
                "Add-Type -AssemblyName System.Windows.Forms; "
                "$d = New-Object System.Windows.Forms.SaveFileDialog; "
                f"$d.FileName = '{_powershell_quote(default_name)}'; "
                f"$d.InitialDirectory = '{_powershell_quote(start_dir)}'; "
                "$d.Filter = 'Image Files (*.png;*.webp;*.jpg)|*.png;*.webp;*.jpg|All files (*.*)|*.*'; "
                "if ($d.ShowDialog() -eq 'OK') { $d.FileName }"
            )
            res = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps],
                capture_output=True,
                text=True,
                timeout=180,
            )
            chosen = res.stdout.strip()
            return Path(chosen) if res.returncode == 0 and chosen else None
        zenity = shutil.which("zenity")
        if zenity:
            res = subprocess.run(
                [
                    zenity,
                    "--file-selection",
                    "--save",
                    "--confirm-overwrite",
                    f"--filename={start_dir / default_name}",
                ],
                capture_output=True,
                text=True,
                timeout=180,
            )
            chosen = res.stdout.strip()
            return Path(chosen) if res.returncode == 0 and chosen else None
    except Exception:
        pass
    return None


def _choose_output_folder_native(
    start_dir: Path, count: int
) -> Optional[Path]:
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
            res = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True,
                text=True,
                timeout=180,
            )
            chosen = res.stdout.strip()
            return Path(chosen) if res.returncode == 0 and chosen else None
        if sys_name == "Windows":
            ps = (
                "Add-Type -AssemblyName System.Windows.Forms; "
                "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
                f"$d.Description = '{_powershell_quote(prompt)}'; "
                f"$d.SelectedPath = '{_powershell_quote(start_dir)}'; "
                "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }"
            )
            res = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps],
                capture_output=True,
                text=True,
                timeout=180,
            )
            chosen = res.stdout.strip()
            return Path(chosen) if res.returncode == 0 and chosen else None
        zenity = shutil.which("zenity")
        if zenity:
            res = subprocess.run(
                [
                    zenity,
                    "--file-selection",
                    "--directory",
                    f"--title={prompt}",
                    f"--filename={start_dir}/",
                ],
                capture_output=True,
                text=True,
                timeout=180,
            )
            chosen = res.stdout.strip()
            return Path(chosen) if res.returncode == 0 and chosen else None
    except Exception:
        pass
    return None


def ensure_macos_notifier_app() -> Optional[Path]:
    """
    Builds (once) a lightweight background AppleScript applet bundle in
    `~/.openbgr/OpenBGRNotifier.app` stamped with the OpenBGR squircle `.icns`
    and `LSUIElement=True` so macOS Notification Center banners display the
    OpenBGR title and rounded squircle icon without bouncing in the Dock.
    """
    if platform.system() != "Darwin":
        return None
    try:
        applet_bin = NOTIFIER_APP_PATH / "Contents" / "MacOS" / "applet"
        applet_icns = (
            NOTIFIER_APP_PATH / "Contents" / "Resources" / "applet.icns"
        )
        if applet_bin.is_file() and applet_icns.is_file():
            return NOTIFIER_APP_PATH

        APP_CONFIG_DIR.mkdir(parents=True, exist_ok=True)

        # Ensure we have the squircle .icns in ~/.openbgr/OpenBGR.icns
        if not NOTIFIER_ICNS_PATH.is_file():
            for cand in (
                BASE_DIR
                / ".venv"
                / "OpenBGR.app"
                / "Contents"
                / "Resources"
                / "OpenBGR.icns",
                BASE_DIR
                / "dist"
                / "OpenBGR.app"
                / "Contents"
                / "Resources"
                / "OpenBGR.icns",
                Path("/Applications/OpenBGR.app/Contents/Resources/OpenBGR.icns"),
            ):
                if cand.is_file():
                    shutil.copy2(cand, NOTIFIER_ICNS_PATH)
                    break
        if not NOTIFIER_ICNS_PATH.is_file():
            sys.path.insert(0, str(BASE_DIR))
            import icon_render

            with tempfile.TemporaryDirectory() as tmp:
                iconset = Path(tmp) / "OpenBGR.iconset"
                iconset.mkdir(parents=True, exist_ok=True)
                base_img = icon_render.render_icon(1024)
                for sz in (16, 32, 128, 256, 512):
                    base_img.resize((sz, sz), Image.Resampling.LANCZOS).save(
                        iconset / f"icon_{sz}x{sz}.png"
                    )
                    base_img.resize(
                        (sz * 2, sz * 2), Image.Resampling.LANCZOS
                    ).save(iconset / f"icon_{sz}x{sz}@2x.png")
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
            "on run argv\n"
            "  if (count of argv) > 0 then\n"
            '    display notification (item 1 of argv) with title "OpenBGR"\n'
            "  end if\n"
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
        with open(plist_path, "wb") as fh:
            plistlib.dump(plist, fh)

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
    except Exception:
        return None


def format_quick_action_notification(
    succeeded_names: list[str], failed_count: int = 0
) -> Optional[str]:
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
                subprocess.run(
                    ["open", "-a", str(notifier), "--args", message],
                    check=False,
                    capture_output=True,
                    timeout=10,
                )
                return
            subprocess.run(
                [
                    "osascript",
                    "-e",
                    f'display notification "{_osascript_quote(message)}" '
                    'with title "OpenBGR"',
                ],
                check=False,
                capture_output=True,
                timeout=10,
            )
            return
        if sys_name == "Linux" and shutil.which("notify-send"):
            icon_path = ensure_app_icon()
            cmd = ["notify-send", "--app-name=OpenBGR"]
            if icon_path:
                cmd.append(f"--icon={icon_path}")
            cmd.extend(["OpenBGR", message])
            subprocess.run(cmd, check=False, capture_output=True, timeout=5)
    except Exception:
        pass


def _resolve_cli_output(
    src: Path, output: Optional[str], input_count: int, fmt: str = "png"
) -> Optional[Path]:
    """Maps `-o` semantics: omitted → sibling cutout; bare `-o` → Save dialog; else file/dir."""
    tag, ext = cutout_filename_for(fmt)
    if output is None:
        return _default_output_path(src, fmt=fmt)
    if output == "ASK":
        choose_fn = _resolve_app_symbol(
            "_choose_save_path_native", _choose_save_path_native
        )
        chosen = choose_fn(f"{src.stem}-{tag}.{ext}", src.parent)
        return _with_output_suffix(chosen, ext) if chosen is not None else None
    dest = Path(output).expanduser()
    if dest.is_dir() or input_count > 1 or str(output).endswith(("/", os.sep)):
        dest.mkdir(parents=True, exist_ok=True)
        return _default_output_path(src, fmt=fmt, dest_dir=dest)
    return _with_output_suffix(dest, ext)


def run_quick_action(inputs: list[str]) -> dict[str, Any]:
    """
    Processes 1 or more images selected via the OS Quick Action / context menu
    using the user's persisted Quick Action settings (`~/.openbgr/quick_action.json`):
    model preset, save location (same folder or file/folder dialog), output format,
    edge refinement, optional clipboard copy, and native OpenBGR notification.
    """
    load_cfg_fn = _resolve_app_symbol(
        "load_quick_action_config", load_quick_action_config
    )
    cfg = load_cfg_fn()
    tier_key = (
        RECOMMENDED_TIER
        if cfg["tier"] == "auto"
        else normalize_tier_key(cfg["tier"])
    )
    use_matting = tier_key == "matting"
    edge_refine = bool(cfg.get("edge_refine", True))
    fmt = str(cfg.get("format", "png") or "png")
    save_mode = str(cfg.get("save_mode", "same_folder") or "same_folder")
    copy_clip = bool(cfg.get("copy_clipboard", False))
    notify = bool(cfg.get("notify", True))

    valid_sources: list[Path] = []
    failed = 0
    for src_str in inputs:
        p = Path(src_str).expanduser()
        if p.is_file():
            valid_sources.append(p)
        else:
            failed += 1

    if not valid_sources:
        return {"ok": False, "succeeded": [], "outputs": [], "failed": failed}

    # When multiple images are selected and save_mode is "ask", prompt once for
    # the destination folder so the user isn't shown N separate Save dialogs.
    batch_dest_dir: Optional[Path] = None
    if save_mode == "ask" and len(valid_sources) > 1:
        choose_folder_fn = _resolve_app_symbol(
            "_choose_output_folder_native", _choose_output_folder_native
        )
        batch_dest_dir = choose_folder_fn(
            valid_sources[0].parent, len(valid_sources)
        )
        if batch_dest_dir is None:
            return {
                "ok": True,
                "cancelled": True,
                "succeeded": [],
                "outputs": [],
                "failed": 0,
            }

    succeeded_names: list[str] = []
    outputs_written: list[str] = []
    seg_fn = _resolve_app_symbol("segment_foreground", segment_foreground)
    choose_save_fn = _resolve_app_symbol(
        "_choose_save_path_native", _choose_save_path_native
    )
    clip_fn = _resolve_app_symbol(
        "copy_png_bytes_to_clipboard", copy_png_bytes_to_clipboard
    )
    notify_fn = _resolve_app_symbol(
        "send_openbgr_notification", send_openbgr_notification
    )

    for src in valid_sources:
        pil_img: Optional[Image.Image] = None
        result_img: Optional[Image.Image] = None
        try:
            pil_img = Image.open(src)
            pil_img.load()
            result_img, _elapsed_ms, _tier_cfg, _job_id = seg_fn(
                pil_img,
                tier_key,
                edge_refine,
                edge_refine,
                use_matting,
            )

            if save_mode == "ask":
                if len(valid_sources) == 1:
                    tag, ext = cutout_filename_for(fmt)
                    chosen = choose_save_fn(
                        f"{src.stem}-{tag}.{ext}", src.parent
                    )
                    if chosen is None:
                        return {
                            "ok": True,
                            "cancelled": True,
                            "succeeded": succeeded_names,
                            "outputs": outputs_written,
                            "failed": failed,
                        }
                    out_path = _with_output_suffix(chosen, ext)
                else:
                    out_path = _default_output_path(
                        src, fmt=fmt, dest_dir=batch_dest_dir
                    )
            else:
                out_path = _default_output_path(src, fmt=fmt)

            encoded_bytes = encode_cutout_image(result_img, fmt=fmt)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(encoded_bytes)

            if copy_clip and len(valid_sources) == 1:
                clip_bytes = (
                    encoded_bytes
                    if fmt == "png"
                    else encode_cutout_image(result_img, fmt="png")
                )
                clip_fn(clip_bytes)

            succeeded_names.append(src.name)
            outputs_written.append(str(out_path))
        except Exception as exc:
            print(f"[QuickAction] Failed {src.name}: {exc}")
            failed += 1
        finally:
            if result_img is not None:
                result_img.close()
            if pil_img is not None:
                pil_img.close()

    if notify:
        msg = format_quick_action_notification(succeeded_names, failed)
        if msg:
            notify_fn(msg)

    # Release cached MPS/CUDA blocks between batches; the model stays loaded so
    # subsequent runs are still warm, but idle memory pressure stays low.
    try:
        MANAGER.flush_device_memory()
    except Exception:
        pass

    return {
        "ok": failed == 0 and len(succeeded_names) > 0,
        "succeeded": succeeded_names,
        "outputs": outputs_written,
        "failed": failed,
    }


def run_cli(
    inputs: list[str],
    output: Optional[str],
    tier: Optional[str],
    defringe: bool,
    despill: bool,
    matting: bool,
    fmt: str = "png",
) -> int:
    """
    Headless background removal for CLI / scripting use. Loads the requested
    BiRefNet tier, runs the same `segment_foreground` pipeline the web UI uses,
    and writes full-resolution cutouts. No server or window.
    """
    if not inputs:
        print("[CLI] No input files given.")
        return 2
    seg_fn = _resolve_app_symbol("segment_foreground", segment_foreground)
    rc = 0
    for src_str in inputs:
        src = Path(src_str).expanduser()
        if not src.is_file():
            print(f"[CLI] Skipping (not a file): {src}")
            rc = 1
            continue
        pil_img: Optional[Image.Image] = None
        try:
            pil_img = Image.open(src)
            pil_img.load()
            result_img, elapsed_ms, tier_cfg, _job_id = seg_fn(
                pil_img,
                tier or RECOMMENDED_TIER,
                defringe,
                despill,
                matting,
            )
            try:
                out_path = _resolve_cli_output(
                    src, output, len(inputs), fmt=fmt
                )
                if out_path is None:
                    print(f"[CLI] Save cancelled for {src.name}")
                    continue
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_bytes(encode_cutout_image(result_img, fmt=fmt))
                print(
                    f"[CLI] {src.name} -> {out_path} "
                    f"({elapsed_ms:.0f} ms, {tier_cfg['label']})"
                )
            finally:
                result_img.close()
        except InterruptedError:
            print(f"[CLI] Cancelled: {src.name}")
            rc = 1
        except Exception as exc:
            print(f"[CLI] Failed {src.name}: {exc}")
            rc = 1
        finally:
            if pil_img is not None:
                pil_img.close()
    return rc
