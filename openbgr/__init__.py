"""
OpenBGR — Local Background Removal Studio package.

Submodules:
- `openbgr.config`       : Runtime paths, hardware auto-detection, model tier registry.
- `openbgr.models`       : Thread-safe `ModelManager`, HF cache inspection, FP16 compaction.
- `openbgr.pipeline`     : Defringe, color-spill suppression, RGBA composition, neural segmentation.
- `openbgr.quick_action` : OS Quick Action config, native dialogs, notifications, CLI runner.
- `openbgr.desktop`      : Native `pywebview` bridge (`DesktopApi`), window state, Cocoa menus.
- `openbgr.api`          : FastAPI application and HTTP endpoints.
"""

from __future__ import annotations

from .config import APP_VERSION

__version__ = APP_VERSION
