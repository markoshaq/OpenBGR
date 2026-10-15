#!/usr/bin/env bash
# =============================================================================
# REMOVEBG — Zero-Config Bootstrapper for macOS & Linux
# =============================================================================
# 1. Uses existing .venv if already provisioned (<1s startup).
# 2. Auto-provisions Python 3.12 via `uv` if Python 3.10+ is not installed.
# 3. Auto-detects NVIDIA GPUs on Linux (`nvidia-smi`) to install CUDA PyTorch.
# =============================================================================
set -e
cd "$(dirname "$0")"

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

# Fast path: environment is already installed
if [ -f ".venv/.installed" ] && [ -x ".venv/bin/python" ]; then
  exec ./.venv/bin/python app.py
fi

echo "--------------------------------------------------------------------"
echo "  REMOVEBG // FIRST-TIME LOCAL SETUP"
echo "--------------------------------------------------------------------"

# Check if Python 3.10+ is available; if not, bootstrap via uv
HAS_PY310=0
if command -v python3 >/dev/null 2>&1; then
  PY_OK=$(python3 -c 'import sys; print(int(sys.version_info >= (3, 10)))' 2>/dev/null || echo 0)
  if [ "$PY_OK" = "1" ]; then
    HAS_PY310=1
  fi
fi

if [ ! -d ".venv" ]; then
  if command -v uv >/dev/null 2>&1; then
    echo "[1/2] Creating virtual environment with uv..."
    uv venv .venv --python 3.12
  elif [ "$HAS_PY310" = "1" ]; then
    echo "[1/2] Creating virtual environment (.venv)..."
    python3 -m venv .venv
  else
    echo "[1/2] Python 3.10+ not found. Installing standalone Python via uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
    uv venv .venv --python 3.12
  fi
fi

if [ ! -f ".venv/.installed" ]; then
  echo "[2/2] Installing AI engine dependencies (one-time setup)..."
  if command -v uv >/dev/null 2>&1; then
    if [ "$(uname -s)" = "Linux" ] && command -v nvidia-smi >/dev/null 2>&1; then
      echo "      NVIDIA GPU detected — installing CUDA-accelerated PyTorch..."
      uv pip install --python .venv/bin/python torch torchvision --index-url https://download.pytorch.org/whl/cu124
    fi
    uv pip install --python .venv/bin/python -r requirements.txt
  else
    ./.venv/bin/pip install --upgrade pip -q
    if [ "$(uname -s)" = "Linux" ] && command -v nvidia-smi >/dev/null 2>&1; then
      echo "      NVIDIA GPU detected — installing CUDA-accelerated PyTorch..."
      ./.venv/bin/pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
    fi
    ./.venv/bin/pip install -r requirements.txt
  fi
  touch .venv/.installed
fi

exec ./.venv/bin/python app.py
