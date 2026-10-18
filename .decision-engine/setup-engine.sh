#!/usr/bin/env bash
# ============================================================================
# setup-engine.sh — Hybrid Decision Engine bootstrap (POSIX).
#
# 100% project-local containment: the venv, pip cache, HF cache, temp dir,
# Needle engine + weights, LFM2.5 GGUF and llama.cpp binaries ALL live
# strictly inside ./.decision-engine/. Nothing touches ~/.cache.
# ============================================================================
set -euo pipefail

DE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export HF_HOME="$DE/.cache/hf"
export HF_HUB_CACHE="$DE/.cache/hf/hub"
export PIP_CACHE_DIR="$DE/.cache/pip"
export TMPDIR="$DE/.cache/tmp"
export PYTHONUSERBASE="$DE/.cache/python-user"
export NEEDLE_TELEMETRY=0
export DO_NOT_TRACK=1

mkdir -p "$DE/.cache/pip" "$DE/.cache/hf" "$DE/.cache/tmp" "$DE/bin" \
         "$DE/models/needle3" "$DE/models/lfm2.5"

echo "[2/6] Python venv (inside .decision-engine)..."
[ -x "$DE/.venv/bin/python" ] || python3 -m venv "$DE/.venv"
PY="$DE/.venv/bin/python"

echo "[3/6] Installing Python deps (pip cache inside .decision-engine)..."
# llama-cpp-python is intentionally NOT installed; LFM2.5 runs through the
# official llama.cpp llama-server binary in bin/.
"$PY" -m pip install --upgrade pip
"$PY" -m pip install cactus-needle huggingface_hub fastapi "uvicorn[standard]" pydantic

echo "[4/6] Needle 3 engine + weights (placed inside the installed needle package dir, which wins over ~/.cache)..."
"$DE/.venv/bin/needle" fetch --out "$DE/.cache/needle-engine"
"$DE/.venv/bin/needle" download needle3 --out "$DE/models/needle3"
SITE="$("$PY" -c 'import needle,os;print(os.path.dirname(needle.__file__))')"
cp -r "$DE/.cache/needle-engine/." "$SITE/"
cp "$DE/models/needle3/needle3.cact" "$SITE/"

echo "[5/6] LFM2.5-1.2B-Instruct GGUF (Q4_K_M, HF cache inside .decision-engine)..."
"$DE/.venv/bin/hf" download LiquidAI/LFM2.5-1.2B-Instruct-GGUF \
  --include "*Q4_K_M.gguf" --local-dir "$DE/models/lfm2.5"

echo "[6/6] llama.cpp llama-server binary..."
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

"$PY" -c "import needle, fastapi, uvicorn, pydantic; print('decision-engine deps OK')"
ls "$DE/models/needle3/needle3.cact" "$DE/models/lfm2.5/"*Q4_K_M.gguf "$DE/bin/"llama-server*
echo "Decision Engine setup complete."
