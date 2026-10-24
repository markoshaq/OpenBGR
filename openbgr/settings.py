"""
Persisted application settings (`~/.openbgr/settings.json`) and the
offline-mode switch that blocks every outbound Hugging Face request.

Kept dependency-free on purpose: `openbgr/__init__` imports this module on
every package load (including the bare system interpreter used by the Linux
installer), so it must not pull in torch or huggingface_hub at module level.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent.parent
APP_CONFIG_DIR = Path.home() / ".openbgr"
SETTINGS_PATH = APP_CONFIG_DIR / "settings.json"


def _read_project_version() -> str:
    """
    Reads `version` from `pyproject.toml` via `tomllib` (3.11+) or regex
    fallback so the version is defined in one place without pulling in third-
    party packages. Returns "0.0.0-dev" when `pyproject.toml` is missing.
    """
    pyproject_path = BASE_DIR / "pyproject.toml"
    try:
        raw_text = pyproject_path.read_text(encoding="utf-8")
        try:
            import tomllib  # type: ignore[import-not-found]

            parsed = tomllib.loads(raw_text)
            ver = parsed.get("project", {}).get("version")
            if isinstance(ver, str) and ver:
                return ver
        except Exception:
            pass
        m = re.search(r'^version\s*=\s*"([^"]+)"', raw_text, re.MULTILINE)
        if m:
            return m.group(1)
    except OSError:
        pass
    try:
        from importlib.metadata import version as pkg_version

        return pkg_version("openbgr")
    except Exception:
        return "0.0.0-dev"


APP_VERSION = _read_project_version()

# Per-session tokens guarding mutating `/api/*` endpoints:
# - `WEB_API_TOKEN` is injected into the served `index.html` (`GET /`) so the
#   studio UI can call browser-facing endpoints, while raw-path IPC endpoints
#   (`/api/open-files`, `/api/quick-action`) refuse it.
# - `API_TOKEN` is persisted to `~/.openbgr/session_token` (0600) so local OS
#   processes with filesystem access (Quick Action delegation, open-files
#   forwarding, local CLI/curl scripts) can authenticate to all endpoints.
API_TOKEN_HEADER = "x-openbgr-token"
API_TOKEN_PATH = APP_CONFIG_DIR / "session_token"
API_TOKEN = secrets.token_urlsafe(32)
WEB_API_TOKEN = secrets.token_urlsafe(32)

TIER_KEYS: tuple[str, ...] = (
    "lite",
    "general",
    "hr",
    "portrait",
    "matting",
    "dynamic",
)

TIER_ALIASES: dict[str, str] = {
    "low": "lite",
    "mid": "general",
    "full": "general",
    "high": "hr",
}

# File types accepted from OS open-file events, Open With forwarding, and
# clipboard path drops. Shared by `desktop_bridge` and `desktop_clipboard`,
# which must not import each other (bridge mixes the clipboard class in).
IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"})

# Default and minimum desktop window sizes, shared by the pywebview window
# (`app.py`) and the system-browser `--app=` fallback (`desktop_window.py`).
DEFAULT_WINDOW_SIZE = (1380, 860)
MIN_WINDOW_SIZE = (980, 640)


def normalize_tier_key(tier: str) -> str:
    """Resolves legacy preset names (`low`, `mid`, `high`) to canonical model keys."""
    cleaned = (tier or "").strip().lower()
    return TIER_ALIASES.get(cleaned, cleaned)


def persist_api_token() -> None:
    """Writes the session token to `~/.openbgr/` (0600) for trusted local clients."""
    try:
        APP_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        # Create the file mode-0600 from the start: write_text() + chmod would
        # leave a window where a permissive umask exposes the token to other
        # local processes. The chmod still runs for files left over with a
        # looser mode from an older version or a manual touch.
        fd = os.open(API_TOKEN_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(API_TOKEN)
        os.chmod(API_TOKEN_PATH, 0o600)
    except OSError as exc:
        logging.getLogger("openbgr").warning(
            "[Config] Failed to persist the session token to %s (%s); Quick "
            "Action and open-files delegation will not authenticate.",
            API_TOKEN_PATH,
            exc,
        )


def read_api_token() -> str:
    """Reads the running server's session token; empty when none is available."""
    try:
        return API_TOKEN_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


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


# One-shot flag so a corrupt settings.json warns once rather than on every
# call (offline_mode_enabled reads the file per request).
_SETTINGS_LOAD_WARNED = False


def load_settings() -> dict[str, Any]:
    """Reads `~/.openbgr/settings.json`; returns defaults on any failure."""
    global _SETTINGS_LOAD_WARNED
    if not SETTINGS_PATH.is_file():
        return {"offline_mode": False}
    try:
        raw = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            return {"offline_mode": bool(raw.get("offline_mode"))}
        raise ValueError("settings root is not an object")
    except Exception as exc:
        if not _SETTINGS_LOAD_WARNED:
            _SETTINGS_LOAD_WARNED = True
            logging.getLogger("openbgr").warning(
                "[Settings] Could not read %s (%s); using defaults.", SETTINGS_PATH, exc
            )
    return {"offline_mode": False}


def save_settings(cfg: dict[str, Any]) -> dict[str, Any]:
    """Writes a sanitized settings dict to `~/.openbgr/settings.json`."""
    clean = {"offline_mode": bool(cfg.get("offline_mode"))}
    try:
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS_PATH.write_text(json.dumps(clean, indent=2), encoding="utf-8")
    except OSError as exc:
        logging.getLogger("openbgr").warning(
            "[Settings] Failed to persist settings to %s: %s", SETTINGS_PATH, exc
        )
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


def apply_offline_mode(enabled: bool) -> bool:
    """
    Propagates the switch to every layer that could open a socket mid-session:
    the HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE env vars, huggingface_hub's live
    constant, and its cached sessions so newly created sessions mount the
    OfflineAdapter that refuses outgoing HTTP. Returns True when every layer
    applied; False means cached HF connections may persist (already logged).
    """
    if enabled:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
    elif not ENV_FORCED_OFFLINE:
        os.environ.pop("HF_HUB_OFFLINE", None)
        os.environ.pop("TRANSFORMERS_OFFLINE", None)
    applied = True
    try:
        import huggingface_hub.constants as hf_constants

        hf_constants.HF_HUB_OFFLINE = enabled or ENV_FORCED_OFFLINE
    except Exception as exc:
        applied = False
        logging.getLogger("openbgr").warning(
            "[Settings] Could not update huggingface_hub offline state: %s", exc
        )
    try:
        from huggingface_hub.utils._http import reset_sessions

        reset_sessions()
    except ImportError:
        applied = False
        logging.getLogger("openbgr").warning(
            "[Settings] huggingface_hub reset_sessions is unavailable in this "
            "version; open HF connections may persist until they close."
        )
    except Exception as exc:
        applied = False
        logging.getLogger("openbgr").warning(
            "[Settings] Failed to reset cached HF sessions: %s", exc
        )
    return applied


def set_offline_mode(enabled: bool) -> bool:
    """Persists the switch, applies it to the process, returns effective state."""
    cfg = load_settings()
    cfg["offline_mode"] = bool(enabled)
    save_settings(cfg)
    apply_offline_mode(bool(enabled))
    return offline_mode_enabled()
