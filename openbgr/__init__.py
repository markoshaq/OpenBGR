"""
OpenBGR - Local Background Removal Studio package.

Submodules:
- `openbgr.config`        : Runtime paths, hardware auto-detection, model tier registry.
- `openbgr.icon_render`   : Squircle app-icon renderer (Pillow-only, no torch).
- `openbgr.models`        : Thread-safe `ModelManager`, HF cache inspection, FP16 compaction.
- `openbgr.pipeline`      : Defringe, color-spill suppression, RGBA composition, neural segmentation.
- `openbgr.quick_action`        : Quick Action / headless CLI runner and cutout encoding.
- `openbgr.quick_action_config` : Persisted Quick Action settings + OS integration install.
- `openbgr.quick_action_native` : Native clipboard, dialogs, and notification dispatch.
- `openbgr.desktop_bridge`  : `pywebview` JS↔Python bridge (`DesktopApi`), pending open-files.
- `openbgr.desktop_window`  : Window geometry persistence and chromeless browser fallback.
- `openbgr.desktop_menus`   : Native OS menu bar construction (macOS / Linux GTK).
- `openbgr.desktop_cocoa`   : macOS-only Cocoa integration (app name, menus, 'odoc' handlers).
- `openbgr.server_probe`    : Local-server port probes and single-instance forwarding.
- `openbgr.api`             : FastAPI application and HTTP endpoints.
"""

from __future__ import annotations


def __getattr__(name: str) -> object:
    """
    Resolves `__version__` lazily so `import openbgr.icon_render` stays cheap:
    it must not pull in `openbgr.config` (and therefore torch) when invoked
    from the bare system interpreter by the Linux integration installer.
    """
    if name == "__version__":
        from .config import APP_VERSION

        return APP_VERSION
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
