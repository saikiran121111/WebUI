@echo off
setlocal EnableExtensions
REM ============================================================================
REM setup-engine.bat — Hybrid Decision Engine bootstrap (Windows).
REM
REM 100% project-local containment: the venv, pip cache, HF cache, temp dir,
REM Needle engine + weights, LFM2.5 GGUF and llama.cpp binaries ALL live
REM strictly inside ./.decision-engine/. Nothing touches ~/.cache or AppData.
REM
REM Run from anywhere: paths are resolved relative to this script's folder.
REM ============================================================================

set "DE=%~dp0"
set "HF_HOME=%DE%.cache\hf"
set "HF_HUB_CACHE=%DE%.cache\hf\hub"
set "PIP_CACHE_DIR=%DE%.cache\pip"
set "TMP=%DE%.cache\tmp"
set "TEMP=%DE%.cache\tmp"
set "TMPDIR=%DE%.cache\tmp"
set "PYTHONUSERBASE=%DE%.cache\python-user"
set "NEEDLE_TELEMETRY=0"
set "DO_NOT_TRACK=1"

echo [1/6] Creating directories...
mkdir "%DE%.cache\pip" 2>nul
mkdir "%DE%.cache\hf" 2>nul
mkdir "%DE%.cache\tmp" 2>nul
mkdir "%DE%bin" 2>nul
mkdir "%DE%models\needle3" 2>nul
mkdir "%DE%models\lfm2.5" 2>nul

echo [2/6] Python venv (inside .decision-engine)...
if not exist "%DE%.venv\Scripts\python.exe" python -m venv "%DE%.venv"
if errorlevel 1 exit /b 1
set "PY=%DE%.venv\Scripts\python.exe"

echo [3/6] Installing Python deps (pip cache inside .decision-engine)...
"%PY%" -m pip install --upgrade pip
if errorlevel 1 exit /b 1
REM llama-cpp-python is intentionally NOT installed (no Windows/cp314 wheels);
REM LFM2.5 runs through the official llama.cpp llama-server binary in bin/.
"%PY%" -m pip install cactus-needle huggingface_hub fastapi "uvicorn[standard]" pydantic
if errorlevel 1 exit /b 1

echo [4/6] Needle 3 engine + weights (fetched into .decision-engine, then placed inside the installed needle package dir, which wins over ~/.cache)...
"%DE%.venv\Scripts\needle.exe" fetch --out "%DE%.cache\needle-engine"
if errorlevel 1 exit /b 1
"%DE%.venv\Scripts\needle.exe" download needle3 --out "%DE%models\needle3"
if errorlevel 1 exit /b 1
xcopy /Y /I /S "%DE%.cache\needle-engine\*" "%DE%.venv\Lib\site-packages\needle\" >nul
if errorlevel 1 exit /b 1
copy /Y "%DE%models\needle3\needle3.cact" "%DE%.venv\Lib\site-packages\needle\" >nul
if errorlevel 1 exit /b 1

echo [5/6] LFM2.5-1.2B-Instruct GGUF (Q4_K_M, HF cache inside .decision-engine)...
"%DE%.venv\Scripts\hf.exe" download LiquidAI/LFM2.5-1.2B-Instruct-GGUF --include "*Q4_K_M.gguf" --local-dir "%DE%models\lfm2.5"
if errorlevel 1 exit /b 1

echo [6/6] llama.cpp llama-server binary (CPU x64)...
if not exist "%DE%bin\llama-server.exe" (
  curl -L --fail -o "%DE%.cache\tmp\llama.zip" "https://github.com/ggml-org/llama.cpp/releases/download/b11719/llama-b11719-bin-win-cpu-x64.zip"
  if errorlevel 1 exit /b 1
  REM Use venv Python's zipfile: system tar may resolve to GNU tar, which
  REM mis-parses drive-letter paths ("Cannot connect to D:").
  "%PY%" -m zipfile -e "%DE%.cache\tmp\llama.zip" "%DE%bin"
  if errorlevel 1 exit /b 1
)

echo Sanity check...
"%PY%" -c "import needle, fastapi, uvicorn, pydantic; print('decision-engine deps OK')"
if errorlevel 1 exit /b 1
dir /b "%DE%models\needle3\needle3.cact"
dir /b "%DE%models\lfm2.5\*Q4_K_M.gguf"
dir /b "%DE%bin\llama-server.exe"
echo Decision Engine setup complete.
endlocal
