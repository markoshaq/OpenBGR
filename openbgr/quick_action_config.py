"""
Quick Action / context-menu persisted configuration (`~/.openbgr/quick_action.json`)
and per-platform install/detection of the OS right-click integration.
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
from pathlib import Path
from typing import Any

from .config import (
    BASE_DIR,
    DEFAULT_QUICK_ACTION_CONFIG,
    QUICK_ACTION_CONFIG_PATH,
    TIERS,
    logger,
    normalize_tier_key,
)


def sanitize_quick_action_config(raw: Any) -> dict[str, Any]:
    """Validates a Quick Action config dict against allowed values and falls back to defaults."""
    src = raw if isinstance(raw, dict) else {}
    raw_tier = str(src.get("tier", "general") or "general").strip().lower()
    norm_t = normalize_tier_key(raw_tier)
    tier_val = norm_t if norm_t in TIERS else "general"

    save_mode = str(src.get("save_mode", "same_folder") or "same_folder").strip().lower()
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
    cfg_path = QUICK_ACTION_CONFIG_PATH
    try:
        if cfg_path.is_file():
            raw = json.loads(cfg_path.read_text(encoding="utf-8"))
            return sanitize_quick_action_config(raw)
    except Exception as exc:
        logger.warning("[QuickAction] Failed to read %s: %s", cfg_path, exc)
    return dict(DEFAULT_QUICK_ACTION_CONFIG)


def save_quick_action_config(cfg: dict[str, Any]) -> dict[str, Any]:
    """Writes a sanitized Quick Action config to `~/.openbgr/quick_action.json`."""
    clean = sanitize_quick_action_config(cfg)
    cfg_path = QUICK_ACTION_CONFIG_PATH
    try:
        cfg_path.parent.mkdir(parents=True, exist_ok=True)
        cfg_path.write_text(json.dumps(clean, indent=2), encoding="utf-8")
    except Exception as exc:
        logger.warning("[QuickAction] Failed to write %s: %s", cfg_path, exc)
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
    nautilus = Path.home() / ".local/share/nautilus/scripts/Remove Background with OpenBGR"
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
                    "Installed Finder Quick Action." if install else "Removed Finder Quick Action."
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
            env = {
                **os.environ,
                "OPENBGR_PY": sys.executable,
                "OPENBGR_NO_PAUSE": "1",
            }
            res = subprocess.run(
                ["cmd.exe", "/c", str(script)],
                capture_output=True,
                text=True,
                timeout=20,
                env=env,
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
                "Installed desktop context menu." if install else "Removed desktop context menu."
            )
        return False, (res.stderr or res.stdout or "Failed to update desktop context menu.").strip()
    except Exception as exc:
        return False, str(exc)
