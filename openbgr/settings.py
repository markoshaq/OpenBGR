"""
Persisted application settings (`~/.openbgr/settings.json`) and the
offline-mode switch that blocks every outbound Hugging Face request.

Kept dependency-free on purpose: `openbgr/__init__` imports this module on
every package load (including the bare system interpreter used by the Linux
installer), so it must not pull in torch or huggingface_hub at module level.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

APP_CONFIG_DIR = Path.home() / ".openbgr"
SETTINGS_PATH = APP_CONFIG_DIR / "settings.json"

# Launch-time environment flags that force offline mode regardless of the
# persisted setting. Evaluated once at import: `set_offline_mode` itself
# exports HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE while applying the switch, so
# re-reading the live environment afterwards could not distinguish a value
# the user provided from one the app wrote.
_OFFLINE_ENV_VARS = ("OPENBGR_OFFLINE", "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE")
_TRUE_VALUES = {"1", "true", "yes", "on"}
ENV_FORCED_OFFLINE = any(
    os.environ.get(name, "").strip().lower() in _TRUE_VALUES for name in _OFFLINE_ENV_VARS
)


def env_forces_offline() -> bool:
    """True when a launch-time env var forces offline mode for this process."""
    return ENV_FORCED_OFFLINE


def load_settings() -> dict[str, Any]:
    """Reads `~/.openbgr/settings.json`; returns defaults on any failure."""
    try:
        if SETTINGS_PATH.is_file():
            raw = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                return {"offline_mode": bool(raw.get("offline_mode"))}
    except Exception:
        pass
    return {"offline_mode": False}


def save_settings(cfg: dict[str, Any]) -> dict[str, Any]:
    """Writes a sanitized settings dict to `~/.openbgr/settings.json`."""
    clean = {"offline_mode": bool(cfg.get("offline_mode"))}
    try:
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS_PATH.write_text(json.dumps(clean, indent=2), encoding="utf-8")
    except OSError:
        pass
    return clean


def offline_mode_enabled() -> bool:
    """True when outbound network access is blocked (env-forced or persisted)."""
    return ENV_FORCED_OFFLINE or bool(load_settings().get("offline_mode"))


def sync_offline_env() -> None:
    """
    Exports HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE when offline mode is on.
    Called from `openbgr/__init__` so the vars exist before huggingface_hub
    and transformers snapshot them at their own import time.
    """
    if offline_mode_enabled():
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"


def apply_offline_mode(enabled: bool) -> None:
    """
    Propagates the switch to every layer that could open a socket mid-session:
    the HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE env vars, huggingface_hub's live
    constant, and its cached sessions so newly created sessions mount the
    OfflineAdapter that refuses outgoing HTTP.
    """
    if enabled:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
    elif not ENV_FORCED_OFFLINE:
        os.environ.pop("HF_HUB_OFFLINE", None)
        os.environ.pop("TRANSFORMERS_OFFLINE", None)
    try:
        import huggingface_hub.constants as hf_constants

        hf_constants.HF_HUB_OFFLINE = enabled or ENV_FORCED_OFFLINE
        from huggingface_hub.utils._http import reset_sessions

        reset_sessions()
    except Exception:
        pass


def set_offline_mode(enabled: bool) -> bool:
    """Persists the switch, applies it to the process, returns effective state."""
    cfg = load_settings()
    cfg["offline_mode"] = bool(enabled)
    save_settings(cfg)
    apply_offline_mode(bool(enabled))
    return offline_mode_enabled()
