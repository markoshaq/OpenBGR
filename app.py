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
import logging
import os
import platform
import signal
import sys
import threading
from typing import Any

from openbgr.server_probe import (
    delegate_quick_action_to_server,
    forward_open_files_to_server,
    is_openbgr_server,
    server_listening,
    server_port,
    wait_for_port_free,
    wait_for_server,
)
from openbgr.settings import (
    APP_VERSION,
    DEFAULT_WINDOW_SIZE,
    MIN_WINDOW_SIZE,
    TIER_KEYS,
    normalize_tier_key,
)


def __getattr__(name: str) -> Any:
    """
    Resolves `app` (`uvicorn app:app`) lazily so `--help`, warm-server Quick
    Action delegation, and `Open With` file forwarding exit before importing
    PyTorch, torchvision, transformers, or FastAPI.
    """
    if name == "app":
        from openbgr.api import app as _fastapi_app

        return _fastapi_app
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def run_cli(*args: Any, **kwargs: Any) -> int:
    """Lazy wrapper around `openbgr.quick_action.run_cli`."""
    from openbgr.quick_action import run_cli as _run_cli

    return _run_cli(*args, **kwargs)


def run_quick_action(*args: Any, **kwargs: Any) -> dict[str, Any]:
    """Lazy wrapper around `openbgr.quick_action.run_quick_action`."""
    from openbgr.quick_action import run_quick_action as _run_quick_action

    return _run_quick_action(*args, **kwargs)


def _cancel_if_loaded() -> None:
    """Requests cancellation only when `openbgr.models` has already been imported."""
    models_mod = sys.modules.get("openbgr.models")
    if models_mod is not None:
        models_mod.MANAGER.request_cancel()


def _graceful_exit(signum: int, _frame: Any) -> None:
    """
    Aborts active jobs and exits immediately with the conventional signal
    status (128 + signum) so a killed process does not report success.
    `unload()` is deliberately not called: `get_or_load` holds the model lock
    across the whole download, so waiting on it here could hang SIGINT for an
    entire first-run download. `os._exit` lets the OS reclaim device memory
    instantly.
    """
    _cancel_if_loaded()
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
    log = logging.getLogger("openbgr")
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
                        _cancel_if_loaded()
                        os._exit(128 + sig)
            except Exception as exc:
                # A broken pipe must not kill the app: headless mode still has
                # the Python-level handlers, and desktop mode degrades to the
                # pre-watchdog behavior (signals swallowed), not data loss.
                log.warning("[Desktop] Signal watchdog stopped (%s).", exc)

        threading.Thread(target=_watch, daemon=True).start()
    except Exception as exc:
        log.warning(
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
        "-V",
        "--version",
        action="version",
        version=f"OpenBGR {APP_VERSION}",
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
            + ", ".join(sorted(TIER_KEYS))
            + " (legacy aliases accepted; default: hardware-recommended tier)."
        ),
    )
    parser.add_argument(
        "--format",
        default=None,
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
        if norm_tier not in TIER_KEYS:
            parser.error(
                f"invalid --tier value '{args.tier}' (choose from: {', '.join(sorted(TIER_KEYS))})"
            )
        args.tier = norm_tier

    if args.quick_action:
        cli_only_passed = (
            args.tier is not None
            or args.output is not None
            or args.format is not None
            or args.matting
            or not args.defringe
            or not args.despill
        )
        if cli_only_passed:
            parser.error(
                "--quick-action uses saved Quick Action preferences; "
                "do not combine it with --cli processing flags (use --cli instead)."
            )
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
                fmt=args.format or "png",
            )
        )

    port = int(server_port())
    host = "127.0.0.1"
    url = f"http://{host}:{port}"

    from openbgr.config import LOG_FILE_PATH, logger

    if os.environ.pop("OPENBGR_RESTARTING", None) == "1" and not wait_for_port_free(
        host, port, timeout_s=5.0
    ):
        logger.warning(
            "[Server] Port %s is still held by the previous instance; "
            "the new server may fail to bind.",
            port,
        )

    # If an OpenBGR instance is already running, forward 'Open With' files
    # to it over localhost and exit cleanly before importing the ML stack.
    # A single-shot probe costs nothing when nothing is listening; the old
    # full-second poll added ~1 s to every cold 'Open With' launch.
    if (
        args.files
        and server_listening(host, port, timeout_s=0.3)
        and is_openbgr_server(url, timeout_s=2.0)
        and forward_open_files_to_server(url, args.files)
    ):
        raise SystemExit(0)

    import uvicorn

    from openbgr.api import app as fastapi_app
    from openbgr.desktop_bridge import queue_open_files
    from openbgr.desktop_window import open_fallback_app_window

    if args.files:
        queue_open_files(args.files)

    signal.signal(signal.SIGINT, _graceful_exit)
    signal.signal(signal.SIGTERM, _graceful_exit)
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, _graceful_exit)
    _start_signal_watchdog()

    # Light banner only: the compute/default-model line is logged by the
    # server's background warmup thread once torch is actually imported, so
    # the window is never delayed by hardware detection.
    logger.info("-" * 68)
    logger.info("  OpenBGR - LOCAL AI SEGMENTATION STUDIO")
    logger.info("  Interface : %s", url)
    logger.info("  Logs      : %s", LOG_FILE_PATH)
    logger.info("-" * 68)

    # Headless / server-only mode when NO_BROWSER=1 or OPENBGR_BROWSER=1 is set
    if os.environ.get("NO_BROWSER") == "1":
        uvicorn.run(
            fastapi_app,
            host=host,
            port=port,
            log_level="warning",
            log_config=None,
            access_log=False,
        )
    elif os.environ.get("OPENBGR_BROWSER") == "1":
        threading.Timer(1.0, lambda: open_fallback_app_window(url)).start()
        uvicorn.run(
            fastapi_app,
            host=host,
            port=port,
            log_level="warning",
            log_config=None,
            access_log=False,
        )
    else:
        reused, server_thread = _start_or_reuse_server(host, port, url)
        _run_desktop_window(url, host, port, reused, server_thread)


# Shown in the desktop window while the server binds, so the window is never
# gated on the ML stack import. Navigated to the studio by `_navigate_when_ready`.
_STARTING_HTML = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; background: #09090b; }
  body { display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; }
  .mark { text-align: center; color: #fafafa; letter-spacing: 0.35em;
          font-size: 15px; font-weight: 600; }
  .sub { margin-top: 10px; letter-spacing: 0.12em; font-size: 11px;
         font-weight: 400; color: #52525b; }
</style>
</head>
<body>
  <div class="mark">OPENBGR<div class="sub">STARTING LOCAL ENGINE</div></div>
</body>
</html>"""

_SERVER_ERROR_HTML = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; background: #09090b; color: #fafafa;
               font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; }
  body { display: flex; align-items: center; justify-content: center; }
  .box { max-width: 440px; text-align: center; }
  h1 { font-size: 14px; letter-spacing: 0.25em; }
  p { color: #a1a1aa; font-size: 13px; line-height: 1.6; }
  code { color: #fbbf24; }
</style>
</head>
<body>
  <div class="box">
    <h1>SERVER DID NOT START</h1>
    <p>The local engine could not serve on port <code>__PORT__</code>. The port
    may already be in use by another application: close it or set
    <code>PORT</code> to a free port and try again. Details are in
    <code>~/.openbgr/openbgr.log</code>.</p>
  </div>
</body>
</html>"""


def _start_or_reuse_server(host: str, port: int, url: str) -> tuple[bool, threading.Thread | None]:
    """
    Reuses a live OpenBGR instance when one is already listening on the port;
    otherwise starts Uvicorn on a daemon thread and returns without waiting:
    the desktop window opens immediately on a placeholder page and navigates
    to `url` once the socket accepts (see `_navigate_when_ready`). Raises
    SystemExit when the port is held by a foreign application.
    """
    import uvicorn

    from openbgr.api import app as fastapi_app
    from openbgr.config import logger

    if server_listening(host, port, timeout_s=0.3):
        if not is_openbgr_server(url, timeout_s=3.0):
            logger.error("[Server] Port %s is already in use by another application.", port)
            logger.error("[Server] Close it or set PORT=<free port> and try again.")
            raise SystemExit(1)
        logger.info("[Server] Reusing existing OpenBGR server at %s.", url)
        return True, None

    # Start FastAPI server in a background daemon thread and open native desktop window
    server_thread = threading.Thread(
        target=lambda: uvicorn.run(
            fastapi_app,
            host=host,
            port=port,
            log_level="warning",
            log_config=None,
            access_log=False,
        ),
        daemon=True,
    )
    server_thread.start()
    return False, server_thread


def _navigate_when_ready(window: Any, target_url: str, host: str, port: int) -> None:
    """
    Loader thread started by `webview.start`: waits for the Uvicorn socket,
    verifies it is an OpenBGR server (a foreign application may have taken the
    port and failed our bind), and navigates the placeholder window to the
    studio. On failure it loads an error page instead of a dead splash.
    """
    from openbgr.config import logger

    if wait_for_server(host, port, timeout_s=20.0):
        if is_openbgr_server(f"http://{host}:{port}", timeout_s=5.0):
            try:
                window.load_url(target_url)
            except Exception:
                logger.exception("[Desktop] Failed to navigate to %s.", target_url)
            return
        logger.error("[Server] Port %s is already in use by another application.", port)
    else:
        logger.error("[Server] Uvicorn did not accept connections in time; see the log.")
    try:
        window.load_html(_SERVER_ERROR_HTML.replace("__PORT__", str(port)))
    except Exception:
        pass


def _run_desktop_window(
    url: str,
    host: str,
    port: int,
    reused: bool,
    server_thread: threading.Thread | None,
) -> None:
    """
    Opens the native pywebview window (with menus, icon, and OS 'Open With'
    handlers) and blocks in its run loop until the user closes it. Falls back
    to a plain browser window when the native window cannot be created.
    """
    from openbgr.config import ensure_app_icon, logger
    from openbgr.desktop_bridge import DesktopApi, set_desktop_api
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

    try:
        set_macos_app_name("OpenBGR")
        import webview

        webview.settings["SHOW_DEFAULT_MENUS"] = False
        api_bridge = DesktopApi()
        set_desktop_api(api_bridge)
        install_macos_open_documents_handler()
        install_macos_open_files_delegate()
        # WinForms loads the window icon via System.Drawing.Icon, which only
        # accepts .ico; macOS, Linux, and the browser fallback take PNG.
        icon_path = ensure_app_icon("ico" if platform.system() == "Windows" else "png")

        window_kwargs: dict[str, Any] = {}
        saved_geometry = load_window_state()
        if saved_geometry.get("width") and saved_geometry.get("height"):
            window_kwargs["width"] = max(MIN_WINDOW_SIZE[0], saved_geometry["width"])
            window_kwargs["height"] = max(MIN_WINDOW_SIZE[1], saved_geometry["height"])
            if saved_geometry.get("x") is not None:
                window_kwargs["x"] = saved_geometry["x"]
            if saved_geometry.get("y") is not None:
                window_kwargs["y"] = saved_geometry["y"]
        else:
            window_kwargs["width"] = DEFAULT_WINDOW_SIZE[0]
            window_kwargs["height"] = DEFAULT_WINDOW_SIZE[1]

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
            url=window_url if reused else None,
            html=None if reused else _STARTING_HTML,
            min_size=MIN_WINDOW_SIZE,
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
        if not reused:
            # Window-first: the placeholder is up; navigate to the studio as
            # soon as the server socket accepts, so the window is never gated
            # on the ML stack import happening inside the server thread.
            start_kwargs["func"] = _navigate_when_ready
            start_kwargs["args"] = (window, window_url, host, port)

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
        # The fallback browser needs a live URL: wait out the server start
        # (the loader that normally navigates never ran in this path).
        if server_thread is not None:
            wait_for_server(host, port, timeout_s=20.0)
        open_fallback_app_window(url)
        # Keep the daemon server thread alive; without this, main() returns
        # and the browser window opens a dead URL (Ctrl+C exits the join).
        if server_thread is not None:
            server_thread.join()


if __name__ == "__main__":
    main()
