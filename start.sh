#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is not installed. Download Python 3.10+ from https://www.python.org/downloads/"
  exit 1
fi

if [ ! -d ".venv" ]; then
  echo "[1/2] Creating local Python virtual environment (.venv)..."
  python3 -m venv .venv
fi

if [ ! -f ".venv/.installed" ]; then
  echo "[2/2] Installing dependencies (one-time setup)..."
  ./.venv/bin/pip install --upgrade pip -q
  ./.venv/bin/pip install -r requirements.txt
  touch .venv/.installed
fi

exec ./.venv/bin/python app.py
