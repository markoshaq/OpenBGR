"""
Local-server probes used at launch: single-instance forwarding, port
readiness/ownership checks, and open-files handoff to a running server.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import time
from pathlib import Path
from typing import Any

from .settings import API_TOKEN_HEADER, IMAGE_EXTENSIONS, read_api_token


def server_port() -> str:
    """Port the OpenBGR server listens on: `OPENBGR_PORT`, then generic `PORT`."""
    return os.environ.get("OPENBGR_PORT") or os.environ.get("PORT") or "7860"


def server_listening(host: str, port: int, timeout_s: float = 0.3) -> bool:
    """
    Single-shot TCP connect probe: True only when something accepts right now.
    A refused connection fails in microseconds on loopback, so cold-start
    callers pay nothing (unlike `wait_for_server`, which retries to its
    deadline because it legitimately waits for a server that is coming up).
    """
    try:
        with socket.create_connection((host, port), timeout=timeout_s):
            return True
    except OSError:
        return False


def wait_for_server(host: str, port: int, timeout_s: float = 15.0) -> bool:
    """Polls until the local Uvicorn TCP socket is accepting connections."""
    deadline = time.perf_counter() + timeout_s
    while time.perf_counter() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.25):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def wait_for_port_free(host: str, port: int, timeout_s: float = 5.0) -> bool:
    """Polls until `(host, port)` stops accepting TCP connections (e.g. during app restart)."""
    deadline = time.perf_counter() + timeout_s
    while time.perf_counter() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.2):
                time.sleep(0.1)
        except OSError:
            return True
    return False


def forward_open_files_to_server(url: str, paths: list[str]) -> bool:
    """
    Forwards image paths to an already-running local OpenBGR server via
    `POST /api/open-files` so 'Open With' on Windows/Linux/CLI opens tabs in
    the existing window instead of colliding on the server port.
    """
    import urllib.parse
    import urllib.request

    resolved = [str(Path(p).expanduser().resolve()) for p in paths if p]
    if not resolved:
        return False
    try:
        data = urllib.parse.urlencode([("files", p) for p in resolved]).encode("utf-8")
        req = urllib.request.Request(f"{url}/api/open-files", data=data, method="POST")
        token = read_api_token()
        if token:
            req.add_header(API_TOKEN_HEADER, token)
        with urllib.request.urlopen(req, timeout=5) as res:
            payload = json.loads(res.read().decode("utf-8"))
            return bool(isinstance(payload, dict) and payload.get("ok"))
    except Exception:
        return False


def is_openbgr_server(url: str, timeout_s: float = 10.0) -> bool:
    """
    Verifies that whatever is listening on the port is actually OpenBGR's API;
    guards against opening a foreign service when the port is already in use.

    Probes `/api/progress` rather than `/api/status`: the progress endpoint is
    runtime-free, so it answers instantly even while a freshly started server
    is still importing torch in its warmup thread (a `/api/status` probe would
    block on that warmup and delay the desktop window by the whole import).
    A connection refusal means nothing is listening, so no retry can help:
    return immediately instead of polling to the deadline (which used to cost
    every cold Quick Action ~1.5 s).
    """
    import urllib.error
    import urllib.request

    # Mirrors `openbgr.models._VALID_PHASES`; duplicated because this module
    # must stay stdlib-only.
    phases = {"idle", "download", "load", "inference"}
    deadline = time.perf_counter() + timeout_s
    while time.perf_counter() < deadline:
        try:
            with urllib.request.urlopen(f"{url}/api/progress", timeout=3) as res:
                payload = json.loads(res.read().decode("utf-8"))
                return isinstance(payload, dict) and payload.get("phase") in phases
        except urllib.error.HTTPError:
            return False
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, ConnectionRefusedError):
                return False
            time.sleep(0.15)
        except Exception:
            time.sleep(0.15)
    return False


def delegate_quick_action_to_server(inputs: list[str]) -> dict[str, Any] | None:
    """
    If an OpenBGR server is already listening on localhost, delegates the Quick
    Action batch over HTTP so Windows context-menu invocations and CLI calls
    reuse the warm GPU/MPS model with zero cold-start overhead.

    Kept in `server_probe` (stdlib-only) so warm-server delegation exits
    before importing PyTorch, torchvision, or transformers.
    """
    import urllib.error
    import urllib.parse
    import urllib.request

    # Same image filter as `queue_open_files`: right-clicking a non-image (or
    # a path that no longer exists) must not POST junk to a warm server.
    resolved = [
        str(Path(p).expanduser().resolve())
        for p in inputs
        if Path(p).expanduser().is_file()
        and Path(p).expanduser().suffix.lower() in IMAGE_EXTENSIONS
    ]
    if not resolved:
        return None
    api = f"http://127.0.0.1:{server_port()}"
    # Refused connections fail instantly, so this costs nothing on a cold
    # start; a live server answers on the first attempt either way.
    if not server_listening("127.0.0.1", int(server_port())):
        return None
    try:
        if not is_openbgr_server(api, timeout_s=1.5):
            return None
        data = urllib.parse.urlencode([("files", p) for p in resolved]).encode("utf-8")
        req = urllib.request.Request(f"{api}/api/quick-action", data=data, method="POST")
        token = read_api_token()
        if token:
            req.add_header(API_TOKEN_HEADER, token)
        with urllib.request.urlopen(req, timeout=300) as res:
            payload = json.loads(res.read().decode("utf-8"))
            if isinstance(payload, dict) and ("ok" in payload or "cancelled" in payload):
                return payload
    except urllib.error.HTTPError:
        # The server answered with an error status; nothing is left running
        # server-side, so a local rerun cannot duplicate outputs.
        return None
    except Exception:
        # A timeout or dropped connection after the POST leaves the batch
        # running server-side (it runs detached via asyncio.to_thread), so a
        # local rerun would duplicate every output file. Re-probe once: a live
        # server owns the job; only a dead one makes local fallback safe.
        if is_openbgr_server(api, timeout_s=1.5):
            logging.getLogger("openbgr").info(
                "[QuickAction] Lost the delegated run's response; the server is still processing it."
            )
            return {"ok": True, "delegated": True}
        return None
    return None
