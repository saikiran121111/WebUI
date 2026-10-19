#!/usr/bin/env bash
# ============================================================================
# setup-engine.sh — Hybrid Decision Engine bootstrap (POSIX).
#
# 100% project-local containment: the venv, pip cache, HF cache, temp dir,
# LFM2.5 GGUF and llama.cpp binaries ALL live strictly inside
# ./.decision-engine/. Nothing touches ~/.cache.
# ============================================================================
set -euo pipefail

DE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export HF_HOME="$DE/.cache/hf"
export HF_HUB_CACHE="$DE/.cache/hf/hub"
export PIP_CACHE_DIR="$DE/.cache/pip"
export TMPDIR="$DE/.cache/tmp"
export PYTHONUSERBASE="$DE/.cache/python-user"
export DO_NOT_TRACK=1

mkdir -p "$DE/.cache/pip" "$DE/.cache/hf" "$DE/.cache/tmp" "$DE/bin" \
         "$DE/models/lfm2.5"

echo "[1/4] Python venv (inside .decision-engine)..."
[ -x "$DE/.venv/bin/python" ] || python3 -m venv "$DE/.venv"
PY="$DE/.venv/bin/python"

echo "[2/4] Installing Python deps (pip cache inside .decision-engine)..."
# llama-cpp-python is intentionally NOT installed; LFM2.5 runs through the
# official llama.cpp llama-server binary in bin/.
"$PY" -m pip install --upgrade pip
"$PY" -m pip install huggingface_hub fastapi "uvicorn[standard]" pydantic

echo "[3/4] LFM2.5-1.2B-Instruct GGUF (Q4_K_M, HF cache inside .decision-engine)..."
"$DE/.venv/bin/hf" download LiquidAI/LFM2.5-1.2B-Instruct-GGUF \
  --include "*Q4_K_M.gguf" --local-dir "$DE/models/lfm2.5"

echo "[4/4] llama.cpp llama-server binary..."
if [ ! -f "$DE/bin/llama-server" ]; then
  ARCH=$(uname -m); OS=$(uname -s)
  case "$OS" in
    Darwin) ZIP="llama-b11719-bin-macos-arm64.zip" ;;
    *)      ZIP="llama-b11719-bin-ubuntu-x64.zip" ;;
  esac
  curl -L --fail -o "$DE/.cache/tmp/llama.zip" \
    "https://github.com/ggml-org/llama.cpp/releases/download/b11719/$ZIP"
  tar -xf "$DE/.cache/tmp/llama.zip" -C "$DE/bin"
fi

"$PY" -c "import fastapi, uvicorn, pydantic; print('decision-engine deps OK')"
ls "$DE/models/lfm2.5/"*Q4_K_M.gguf "$DE/bin/"llama-server*
echo "Decision Engine setup complete."
