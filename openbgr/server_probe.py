"""
Local-server probes used at launch: single-instance forwarding, port
readiness/ownership checks, and open-files handoff to a running server.
"""

from __future__ import annotations

import json
import socket
import time
from pathlib import Path

from .config import API_TOKEN_HEADER, read_api_token


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
    """
    import urllib.error
    import urllib.request

    deadline = time.perf_counter() + timeout_s
    while time.perf_counter() < deadline:
        try:
            with urllib.request.urlopen(f"{url}/api/status", timeout=3) as res:
                payload = json.loads(res.read().decode("utf-8"))
                return isinstance(payload, dict) and "tiers" in payload
        except urllib.error.HTTPError:
            return False
        except Exception:
            time.sleep(0.15)
    return False
