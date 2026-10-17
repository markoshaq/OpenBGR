#!/usr/bin/env bash
# =============================================================================
# OpenBGR - Headless context-menu helper (macOS Quick Action / Linux services)
# =============================================================================
# Processes 1 or more selected images using the user's Quick Action settings in
# ~/.openbgr/quick_action.json (model preset, save destination, output format,
# edge refinement, clipboard copy, and native OpenBGR notification).
#
# Fast path: if an OpenBGR server is already running on 127.0.0.1:7860, all
# selected file paths are dispatched to POST /api/quick-action in a single
# request so the warm GPU/MPS model is reused with zero cold-start overhead.
# Otherwise, `app.py --quick-action "$@"` runs once for all selected files and
# exits cleanly when finished.
# =============================================================================
set -u

DIR="$(cd "$(dirname "$0")/.." && pwd)"
API="http://127.0.0.1:${OPENBGR_PORT:-${PORT:-7860}}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.cargo/bin:/Library/Frameworks/Python.framework/Versions/Current/bin:$PATH"

pick_python() {
  local p
  for p in \
    "$DIR/.venv/bin/python" \
    "$HOME/.openbgr/venv/bin/python" \
    "$DIR/.venv/Scripts/python.exe" \
  ; do
    if [ -x "$p" ]; then
      printf '%s' "$p"
      return 0
    fi
  done
  command -v python3 2>/dev/null || return 1
}

server_alive() {
  curl -sm 2 "$API/api/status" 2>/dev/null | grep -q '"tiers"'
}

# Filter to existing regular files while preserving order.
files=()
for f in "$@"; do
  [ -f "$f" ] && files+=("$f")
done
[ "${#files[@]}" -eq 0 ] && exit 0

# Fast path: delegate the batch to the already-running local OpenBGR server.
if server_alive; then
  curl_args=(-sSfm 300 -X POST "$API/api/quick-action")
  for f in "${files[@]}"; do
    curl_args+=(--data-urlencode "files=$f")
  done
  if curl "${curl_args[@]}" >/dev/null 2>&1; then
    exit 0
  fi
fi

# Cold path: one-shot process for all selected files.
# Order of preference:
#   1. Packaged macOS app launcher (auto-provisions ~/.openbgr/venv on first
#      use, so the Quick Action works even if the GUI was never opened)
#   2. Local venv python (dev checkout / previously provisioned install)
#   3. start.sh bootstrapper (provisions a Linux release extract on first use)
BUNDLE_EXE="$DIR/../MacOS/OpenBGR"
if [ -x "$BUNDLE_EXE" ]; then
  exec "$BUNDLE_EXE" --quick-action "${files[@]}"
fi

PY="$(pick_python)" || PY=""
if [ -n "$PY" ]; then
  if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] && command -v arch >/dev/null 2>&1; then
    exec arch -arm64 "$PY" "$DIR/app.py" --quick-action "${files[@]}"
  fi
  exec "$PY" "$DIR/app.py" --quick-action "${files[@]}"
fi

if [ -f "$DIR/start.sh" ]; then
  exec bash "$DIR/start.sh" --quick-action "${files[@]}"
fi
exit 1
