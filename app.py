# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "torch>=2.5.0",
#   "torchvision>=0.20.0",
#   "transformers>=4.45.0,<5.0.0",
#   "huggingface-hub>=0.25.0",
#   "timm>=1.0.0",
#   "kornia>=0.7.0",
#   "einops>=0.8.0",
#   "scipy>=1.14.0",
#   "pillow>=10.4.0",
#   "fastapi>=0.115.0",
#   "uvicorn>=0.30.0",
#   "python-multipart>=0.0.9",
#   "pywebview>=5.0",
# ]
# ///
"""
OpenBGR - Local Background Removal Studio
=========================================

A self-hosted FastAPI inference engine for background removal powered by BiRefNet
(Bilateral Reference Network for High-Resolution Dichotomous Image Segmentation).

The core implementation lives in the `openbgr` package:
- `openbgr.config`       : Runtime paths, hardware auto-detection, model tier registry.
- `openbgr.models`       : Thread-safe `ModelManager`, HF cache inspection, FP16 compaction.
- `openbgr.pipeline`     : Defringe, color-spill suppression, RGBA composition, neural segmentation.
- `openbgr.quick_action` : OS Quick Action config, native dialogs, notifications, CLI runner.
- `openbgr.desktop`      : Native `pywebview` bridge (`DesktopApi`), window state, Cocoa menus.
- `openbgr.api`          : FastAPI application and HTTP endpoints.

This module serves as the CLI / desktop / Uvicorn entrypoint (`python app.py`,
`uvicorn app:app`) and re-exports the public API for backward compatibility.
"""

from __future__ import annotations

import argparse
import os
import platform
import signal
import threading
from typing import Any

import uvicorn
from huggingface_hub import snapshot_download, try_to_load_from_cache

from openbgr import desktop as _desktop_mod
from openbgr.api import (
    api_cancel,
    api_get_quick_action_config,
    api_install_model,
    api_job_progress,
    api_open_cache_dir,
    api_open_logs_dir,
    api_quick_action_install,
    api_refine,
    api_remove_bg,
    api_run_quick_action,
    api_save,
    api_save_quick_action_config,
    api_status,
    api_uninstall_model,
    app,
    lifespan,
    no_cache_static,
    serve_favicon,
    serve_index,
)
from openbgr.config import (
    APP_CONFIG_DIR,
    APP_ICON_PATH,
    APP_VERSION,
    BASE_DIR,
    DEFAULT_QUICK_ACTION_CONFIG,
    DEVICE,
    DEVICE_LABEL,
    DTYPE,
    HOST_RAM_GB,
    HR_RESOLUTION,
    IMAGENET_MEAN,
    IMAGENET_STD,
    LEGACY_MATTING_REPO,
    MODELS,
    NOTIFIER_APP_PATH,
    NOTIFIER_ICNS_PATH,
    PRECISION_LABEL,
    QUICK_ACTION_CONFIG_PATH,
    RECOMMENDED_TIER,
    STATIC_DIR,
    SYSTEM_MEMORY_GB,
    TIER_ALIASES,
    TIERS,
    WINDOW_STATE_PATH,
    _dir_tree_bytes,
    detect_compute_device,
    ensure_app_icon,
    format_device_label,
    get_app_disk_bytes,
    get_host_ram_gb,
    get_system_memory_gb,
    logger,
    normalize_tier_key,
    open_folder_in_file_manager,
    select_recommended_tier,
)
from openbgr.desktop import (
    _PENDING_OPEN_FILES,
    _PENDING_OPEN_LOCK,
    DesktopApi,
    attach_window_state_persistence,
    build_native_menus,
    configure_macos_native_window_and_menus,
    ensure_window_on_screen,
    install_macos_open_documents_handler,
    install_macos_open_files_delegate,
    is_openbgr_server,
    load_window_state,
    open_fallback_app_window,
    queue_open_files,
    set_desktop_api,
    set_macos_app_name,
    wait_for_server,
)
from openbgr.models import (
    MANAGER,
    ModelManager,
    compact_model_cache_fp16,
    compute_dynamic_size,
    get_model_cache_dir,
    get_model_disk_bytes,
    get_preprocess_transform,
    is_model_cached_locally,
)
from openbgr.pipeline import (
    _JOB_ID_SEQ,
    _LAST_JOB,
    _LAST_JOB_LOCK,
    compose_rgba,
    decontaminate_edge_colors,
    segment_foreground,
    suppress_color_spill,
)
from openbgr.quick_action import (
    _choose_output_folder_native,
    _choose_save_path_native,
    _default_output_path,
    _osascript_quote,
    _powershell_quote,
    _resolve_cli_output,
    _with_output_suffix,
    copy_png_bytes_to_clipboard,
    cutout_filename_for,
    encode_cutout_image,
    ensure_macos_notifier_app,
    format_quick_action_notification,
    is_quick_action_installed,
    load_quick_action_config,
    run_cli,
    run_quick_action,
    sanitize_quick_action_config,
    save_quick_action_config,
    send_openbgr_notification,
    set_quick_action_installed,
)

__all__ = [
    "APP_CONFIG_DIR",
    "APP_ICON_PATH",
    "APP_VERSION",
    "BASE_DIR",
    "DEFAULT_QUICK_ACTION_CONFIG",
    "DEVICE",
    "DEVICE_LABEL",
    "DTYPE",
    "DesktopApi",
    "HOST_RAM_GB",
    "HR_RESOLUTION",
    "IMAGENET_MEAN",
    "IMAGENET_STD",
    "LEGACY_MATTING_REPO",
    "MANAGER",
    "MODELS",
    "ModelManager",
    "NOTIFIER_APP_PATH",
    "NOTIFIER_ICNS_PATH",
    "PRECISION_LABEL",
    "QUICK_ACTION_CONFIG_PATH",
    "RECOMMENDED_TIER",
    "STATIC_DIR",
    "SYSTEM_MEMORY_GB",
    "TIERS",
    "TIER_ALIASES",
    "WINDOW_STATE_PATH",
    "_JOB_ID_SEQ",
    "_LAST_JOB",
    "_LAST_JOB_LOCK",
    "_PENDING_OPEN_FILES",
    "_PENDING_OPEN_LOCK",
    "_choose_output_folder_native",
    "_choose_save_path_native",
    "_default_output_path",
    "_dir_tree_bytes",
    "_osascript_quote",
    "_powershell_quote",
    "_resolve_cli_output",
    "_with_output_suffix",
    "api_cancel",
    "api_get_quick_action_config",
    "api_install_model",
    "api_job_progress",
    "api_open_cache_dir",
    "api_open_logs_dir",
    "api_quick_action_install",
    "api_refine",
    "api_remove_bg",
    "api_run_quick_action",
    "api_save",
    "api_save_quick_action_config",
    "api_status",
    "api_uninstall_model",
    "app",
    "attach_window_state_persistence",
    "build_native_menus",
    "compact_model_cache_fp16",
    "compose_rgba",
    "compute_dynamic_size",
    "configure_macos_native_window_and_menus",
    "copy_png_bytes_to_clipboard",
    "cutout_filename_for",
    "decontaminate_edge_colors",
    "detect_compute_device",
    "encode_cutout_image",
    "ensure_app_icon",
    "ensure_macos_notifier_app",
    "ensure_window_on_screen",
    "format_device_label",
    "format_quick_action_notification",
    "get_app_disk_bytes",
    "get_host_ram_gb",
    "get_model_cache_dir",
    "get_model_disk_bytes",
    "get_preprocess_transform",
    "get_system_memory_gb",
    "install_macos_open_documents_handler",
    "install_macos_open_files_delegate",
    "is_model_cached_locally",
    "is_openbgr_server",
    "is_quick_action_installed",
    "lifespan",
    "load_quick_action_config",
    "load_window_state",
    "main",
    "no_cache_static",
    "normalize_tier_key",
    "open_fallback_app_window",
    "open_folder_in_file_manager",
    "queue_open_files",
    "run_cli",
    "run_quick_action",
    "sanitize_quick_action_config",
    "save_quick_action_config",
    "segment_foreground",
    "select_recommended_tier",
    "send_openbgr_notification",
    "serve_favicon",
    "serve_index",
    "set_desktop_api",
    "set_macos_app_name",
    "set_quick_action_installed",
    "snapshot_download",
    "suppress_color_spill",
    "try_to_load_from_cache",
    "wait_for_server",
]


def _graceful_exit(_signum: int, _frame: Any) -> None:
    """Immediately aborts active jobs, unloads GPU memory, and exits with zero zombie threads."""
    MANAGER.request_cancel()
    MANAGER.unload()
    os._exit(0)


def _start_signal_watchdog() -> None:
    """
    When the native desktop window is open, the main thread is parked inside
    Cocoa's run loop (`webview.start()`), so Python-level signal handlers
    never execute and SIGTERM would be silently swallowed. `set_wakeup_fd`
    pushes signal numbers into a pipe at C level; this daemon thread blocks
    on the pipe and hard-exits on SIGINT/SIGTERM/SIGHUP regardless of what
    the main thread is doing.
    """
    try:
        import select

        r_fd, w_fd = os.pipe()
        os.set_blocking(r_fd, False)
        os.set_blocking(w_fd, False)
        signal.set_wakeup_fd(w_fd)
        lethal = {signal.SIGINT, signal.SIGTERM}
        if hasattr(signal, "SIGHUP"):
            lethal.add(signal.SIGHUP)

        def _watch() -> None:
            """Blocks on the wakeup pipe and force-exits on a lethal signal."""
            try:
                while True:
                    select.select([r_fd], [], [])
                    data = os.read(r_fd, 64)
                    if data and any(b in lethal for b in data):
                        MANAGER.request_cancel()
                        MANAGER.unload()
                        os._exit(0)
            except Exception:
                os._exit(0)

        threading.Thread(target=_watch, daemon=True).start()
    except Exception:
        pass


def build_arg_parser() -> argparse.ArgumentParser:
    """Builds the CLI / desktop launcher argument parser."""
    parser = argparse.ArgumentParser(
        prog="OpenBGR",
        description=(
            "Local AI background removal studio. With file arguments (or via the "
            "OS 'Open With' mechanism) the app opens and loads the images; with "
            "--cli it processes them headlessly and exits."
        ),
    )
    parser.add_argument(
        "files",
        nargs="*",
        help="Image files to open in the GUI (or to process when --cli is given).",
    )
    parser.add_argument(
        "--cli",
        action="store_true",
        help="Process the given image files headlessly and exit (no window).",
    )
    parser.add_argument(
        "--quick-action",
        action="store_true",
        help="Process the given image files using the user's Quick Action settings and exit.",
    )
    parser.add_argument(
        "-o",
        "--output",
        nargs="?",
        const="ASK",
        default=None,
        metavar="PATH",
        help=(
            "CLI output: a file (single input) or directory (multi input). "
            "Omit to write '<name>-cutout.png' beside each source, or pass -o "
            "with no value to prompt with a native Save dialog."
        ),
    )
    parser.add_argument(
        "--tier",
        default=None,
        metavar="TIER",
        help=(
            "Model preset for --cli: "
            + ", ".join(sorted(TIERS.keys()))
            + " (legacy aliases accepted; default: hardware-recommended tier)."
        ),
    )
    parser.add_argument(
        "--format",
        default="png",
        choices=["png", "webp", "jpg", "mask"],
        help="Output format for --cli (png, webp, jpg, mask).",
    )
    parser.add_argument(
        "--matting",
        action="store_true",
        help="Use the soft-alpha matting pipeline for --cli.",
    )
    parser.add_argument(
        "--no-defringe",
        dest="defringe",
        action="store_false",
        default=True,
        help="Disable edge color defringing for --cli.",
    )
    parser.add_argument(
        "--no-despill",
        dest="despill",
        action="store_false",
        default=True,
        help="Disable color-spill suppression for --cli.",
    )
    return parser


def main(argv: list[str] | None = None) -> None:
    """Entrypoint for CLI, Quick Action, and native desktop / browser studio modes."""
    parser = build_arg_parser()
    args, _unknown = parser.parse_known_args(argv)

    if args.tier is not None:
        norm_tier = normalize_tier_key(args.tier)
        if norm_tier not in TIERS:
            parser.error(
                f"invalid --tier value '{args.tier}' "
                f"(choose from: {', '.join(sorted(TIERS.keys()))})"
            )
        args.tier = norm_tier

    if args.quick_action:
        res = run_quick_action(args.files)
        raise SystemExit(0 if res.get("ok") or res.get("cancelled") else 1)

    if args.cli:
        raise SystemExit(
            run_cli(
                args.files,
                args.output,
                args.tier,
                args.defringe,
                args.despill,
                args.matting,
                fmt=args.format,
            )
        )

    if args.files:
        queue_open_files(args.files)

    signal.signal(signal.SIGINT, _graceful_exit)
    signal.signal(signal.SIGTERM, _graceful_exit)
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, _graceful_exit)
    _start_signal_watchdog()

    port = int(os.environ.get("PORT", "7860"))
    host = "127.0.0.1"
    url = f"http://{host}:{port}"

    logger.info("-" * 68)
    logger.info("  OpenBGR - LOCAL AI SEGMENTATION STUDIO")
    logger.info("  Compute   : %s (%s)", DEVICE_LABEL, PRECISION_LABEL)
    logger.info(
        "  Default   : %s (%s)",
        TIERS[RECOMMENDED_TIER]["label"],
        TIERS[RECOMMENDED_TIER]["sublabel"],
    )
    logger.info("  Interface : %s", url)
    logger.info("-" * 68)

    # Headless / server-only mode when NO_BROWSER=1 or OPENBGR_BROWSER=1 is set
    if os.environ.get("NO_BROWSER") == "1":
        uvicorn.run(app, host=host, port=port, log_level="warning")
    elif os.environ.get("OPENBGR_BROWSER") == "1":
        threading.Timer(1.0, lambda: open_fallback_app_window(url)).start()
        uvicorn.run(app, host=host, port=port, log_level="warning")
    else:
        # Start FastAPI server in a background daemon thread and open native desktop window
        server_thread = threading.Thread(
            target=lambda: uvicorn.run(app, host=host, port=port, log_level="warning"),
            daemon=True,
        )
        server_thread.start()
        if wait_for_server(host, port):
            if not is_openbgr_server(url):
                logger.error("[Server] Port %s is already in use by another application.", port)
                logger.error("[Server] Close it or set PORT=<free port> and try again.")
                raise SystemExit(1)
        elif not server_thread.is_alive():
            logger.error("[Server] Uvicorn failed to start; see errors above.")
            raise SystemExit(1)

        try:
            set_macos_app_name("OpenBGR")
            import webview

            webview.settings["SHOW_DEFAULT_MENUS"] = False
            api_bridge = DesktopApi()
            _desktop_mod.set_desktop_api(api_bridge)
            install_macos_open_documents_handler()
            install_macos_open_files_delegate()
            icon_path = ensure_app_icon()

            window_kwargs: dict[str, Any] = {}
            saved_geometry = load_window_state()
            if saved_geometry.get("width") and saved_geometry.get("height"):
                window_kwargs["width"] = max(980, saved_geometry["width"])
                window_kwargs["height"] = max(640, saved_geometry["height"])
                if saved_geometry.get("x") is not None:
                    window_kwargs["x"] = saved_geometry["x"]
                if saved_geometry.get("y") is not None:
                    window_kwargs["y"] = saved_geometry["y"]
            else:
                window_kwargs["width"] = 1380
                window_kwargs["height"] = 860

            window = webview.create_window(
                title="OpenBGR",
                url=url,
                min_size=(980, 640),
                background_color="#09090b",
                js_api=api_bridge,
                **window_kwargs,
            )
            api_bridge.window = window
            attach_window_state_persistence(window)
            ensure_window_on_screen(window)
            configure_macos_native_window_and_menus(window)

            # On macOS and Linux, attach the native OS menu bar; on Windows,
            # WinForms MenuStrip clashes with WebView2 DockStyle.Fill, so Windows
            # uses the themed in-app Studio Menu Bar in the top header.
            native_menus = None
            if platform.system() != "Windows":
                try:
                    native_menus = build_native_menus(window)
                except Exception as menu_exc:
                    logger.warning("[Desktop] Native menu bar unavailable (%s).", menu_exc)
                    native_menus = None

            start_kwargs: dict[str, Any] = {}
            if native_menus:
                start_kwargs["menu"] = native_menus
            if icon_path:
                start_kwargs["icon"] = icon_path

            webview.start(**start_kwargs)
            # When the native desktop window is closed by the user, release
            # device memory and terminate the process tree immediately so no
            # background server or worker threads remain running.
            MANAGER.request_cancel()
            MANAGER.unload()
            os._exit(0)
        except Exception as exc:
            logger.warning("[Desktop] Native window unavailable (%s); opening app window...", exc)
            open_fallback_app_window(url)
            # Keep the daemon server thread alive; without this, main() returns
            # and the browser window opens a dead URL (Ctrl+C exits the join).
            server_thread.join()


if __name__ == "__main__":
    main()
