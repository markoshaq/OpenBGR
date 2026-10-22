"""
OpenBGR - Local Background Removal Studio
=========================================

A self-hosted FastAPI inference engine for background removal powered by BiRefNet
(Bilateral Reference Network for High-Resolution Dichotomous Image Segmentation).

The core implementation lives in the `openbgr` package (see `openbgr/__init__.py`
for the module map). This file serves as the CLI / desktop / Uvicorn entrypoint
(`python app.py`, `uvicorn app:app`).
"""

from __future__ import annotations

import argparse
import os
import platform
import signal
import threading
from typing import Any

import uvicorn

from openbgr.api import app
from openbgr.config import (
    DEVICE_LABEL,
    LOG_FILE_PATH,
    PRECISION_LABEL,
    RECOMMENDED_TIER,
    TIERS,
    ensure_app_icon,
    logger,
    normalize_tier_key,
)
from openbgr.desktop_bridge import DesktopApi, queue_open_files, set_desktop_api
from openbgr.desktop_cocoa import (
    configure_macos_native_window_and_menus,
    install_macos_open_documents_handler,
    install_macos_open_files_delegate,
    set_macos_app_name,
)
from openbgr.desktop_menus import build_native_menus
from openbgr.desktop_window import (
    attach_window_state_persistence,
    ensure_window_on_screen,
    load_window_state,
    open_fallback_app_window,
)
from openbgr.models import MANAGER
from openbgr.quick_action import (
    delegate_quick_action_to_server,
    run_cli,
    run_quick_action,
)
from openbgr.server_probe import (
    forward_open_files_to_server,
    is_openbgr_server,
    wait_for_port_free,
    wait_for_server,
)


def _graceful_exit(signum: int, _frame: Any) -> None:
    """
    Aborts active jobs and exits immediately with the conventional signal
    status (128 + signum) so a killed process does not report success.
    `unload()` is deliberately not called: `get_or_load` holds the model lock
    across the whole download, so waiting on it here could hang SIGINT for an
    entire first-run download. `os._exit` lets the OS reclaim device memory
    instantly.
    """
    MANAGER.request_cancel()
    os._exit(128 + signum)


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
                    if not data:
                        return  # pipe closed; stop instead of spinning
                    sig = next((b for b in data if b in lethal), None)
                    if sig is not None:
                        MANAGER.request_cancel()
                        os._exit(128 + sig)
            except Exception as exc:
                # A broken pipe must not kill the app: headless mode still has
                # the Python-level handlers, and desktop mode degrades to the
                # pre-watchdog behavior (signals swallowed), not data loss.
                logger.warning("[Desktop] Signal watchdog stopped (%s).", exc)

        threading.Thread(target=_watch, daemon=True).start()
    except Exception as exc:
        logger.warning(
            "[Desktop] Signal watchdog unavailable (%s); SIGINT/SIGTERM may be "
            "swallowed while the native window is open.",
            exc,
        )


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
    args, unknown = parser.parse_known_args(argv)
    # Finder still appends a legacy `-psn_<a>_<b>` process-serial flag to .app
    # launches; anything else unrecognized is a typo worth failing loudly on
    # rather than silently ignoring (e.g. `--clii` opening the GUI).
    unknown = [a for a in unknown if not a.startswith("-psn_")]
    if unknown:
        parser.error(f"unrecognized arguments: {' '.join(unknown)}")

    if args.tier is not None:
        norm_tier = normalize_tier_key(args.tier)
        if norm_tier not in TIERS:
            parser.error(
                f"invalid --tier value '{args.tier}' "
                f"(choose from: {', '.join(sorted(TIERS.keys()))})"
            )
        args.tier = norm_tier

    if args.quick_action:
        delegated = delegate_quick_action_to_server(args.files)
        res = delegated if delegated is not None else run_quick_action(args.files)
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

    port = int(os.environ.get("PORT", "7860"))
    host = "127.0.0.1"
    url = f"http://{host}:{port}"

    if os.environ.pop("OPENBGR_RESTARTING", None) == "1":
        wait_for_port_free(host, port, timeout_s=5.0)

    if args.files:
        # If an OpenBGR instance is already running, forward 'Open With' files
        # to it over localhost and exit cleanly instead of colliding on the port.
        if wait_for_server(host, port, timeout_s=0.15) and is_openbgr_server(url, timeout_s=2.0):
            if forward_open_files_to_server(url, args.files):
                logger.info("[Desktop] Forwarded %d file(s) to running instance.", len(args.files))
                raise SystemExit(0)
        queue_open_files(args.files)

    signal.signal(signal.SIGINT, _graceful_exit)
    signal.signal(signal.SIGTERM, _graceful_exit)
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, _graceful_exit)
    _start_signal_watchdog()

    logger.info("-" * 68)
    logger.info("  OpenBGR - LOCAL AI SEGMENTATION STUDIO")
    logger.info("  Compute   : %s (%s)", DEVICE_LABEL, PRECISION_LABEL)
    logger.info(
        "  Default   : %s (%s)",
        TIERS[RECOMMENDED_TIER]["label"],
        TIERS[RECOMMENDED_TIER]["sublabel"],
    )
    logger.info("  Interface : %s", url)
    logger.info("  Logs      : %s", LOG_FILE_PATH)
    logger.info("-" * 68)

    # Headless / server-only mode when NO_BROWSER=1 or OPENBGR_BROWSER=1 is set
    if os.environ.get("NO_BROWSER") == "1":
        uvicorn.run(app, host=host, port=port, log_level="warning", log_config=None)
    elif os.environ.get("OPENBGR_BROWSER") == "1":
        threading.Timer(1.0, lambda: open_fallback_app_window(url)).start()
        uvicorn.run(app, host=host, port=port, log_level="warning", log_config=None)
    else:
        _run_desktop_window(url, _ensure_server(host, port, url))


def _ensure_server(host: str, port: int, url: str) -> threading.Thread | None:
    """
    Returns a running OpenBGR server for `url`, reusing an existing instance or
    starting Uvicorn on a daemon thread. Returns None when a live instance is
    reused; raises SystemExit when the port is held by another application or
    the server fails to start.
    """
    if wait_for_server(host, port, timeout_s=0.15):
        if not is_openbgr_server(url, timeout_s=3.0):
            logger.error("[Server] Port %s is already in use by another application.", port)
            logger.error("[Server] Close it or set PORT=<free port> and try again.")
            raise SystemExit(1)
        logger.info("[Server] Reusing existing OpenBGR server at %s.", url)
        return None

    # Start FastAPI server in a background daemon thread and open native desktop window
    server_thread = threading.Thread(
        target=lambda: uvicorn.run(app, host=host, port=port, log_level="warning", log_config=None),
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
    return server_thread


def _run_desktop_window(url: str, server_thread: threading.Thread | None) -> None:
    """
    Opens the native pywebview window (with menus, icon, and OS 'Open With'
    handlers) and blocks in its run loop until the user closes it. Falls back
    to a plain browser window when the native window cannot be created.
    """
    try:
        set_macos_app_name("OpenBGR")
        import webview

        webview.settings["SHOW_DEFAULT_MENUS"] = False
        api_bridge = DesktopApi()
        set_desktop_api(api_bridge)
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

        # On macOS and Linux, attach the native OS menu bar; on Windows,
        # WinForms MenuStrip clashes with WebView2 DockStyle.Fill, so Windows
        # uses the themed in-app Studio Menu Bar in the top header.
        native_menus = None
        if platform.system() != "Windows":
            try:
                native_menus = build_native_menus(api_bridge)
            except Exception as menu_exc:
                logger.warning("[Desktop] Native menu bar unavailable (%s).", menu_exc)
                native_menus = None
        api_bridge.native_menus = bool(native_menus)
        window_url = f"{url}/?native_menus=1" if native_menus else url

        window = webview.create_window(
            title="OpenBGR",
            url=window_url,
            min_size=(980, 640),
            background_color="#09090b",
            js_api=api_bridge,
            **window_kwargs,
        )
        api_bridge.window = window
        attach_window_state_persistence(window)
        ensure_window_on_screen(window)
        configure_macos_native_window_and_menus(window)

        start_kwargs: dict[str, Any] = {}
        if native_menus:
            start_kwargs["menu"] = native_menus
        if icon_path:
            start_kwargs["icon"] = icon_path

        webview.start(**start_kwargs)
        # When the native desktop window is closed by the user, terminate
        # the process tree immediately so no background server or worker
        # threads remain running. As in _graceful_exit, skip unload():
        # it can block on a whole first-run model download, and process
        # teardown reclaims device memory anyway.
        logger.info("[Desktop] Window closed; shutting down.")
        MANAGER.request_cancel()
        os._exit(0)
    except Exception as exc:
        logger.warning("[Desktop] Native window unavailable (%s); opening app window...", exc)
        open_fallback_app_window(url)
        # Keep the daemon server thread alive; without this, main() returns
        # and the browser window opens a dead URL (Ctrl+C exits the join).
        if server_thread is not None:
            server_thread.join()


if __name__ == "__main__":
    main()
