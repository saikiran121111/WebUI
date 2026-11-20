<#
  prepare-ocr-runtime.ps1 - the AUTHORIZED, explicit OCR runtime preparation step.

  Ordinary startup never runs this. It creates the project-local isolated OCR
  environment (the OCR dependency set conflicts with the main backend venv, which is why
  it is a separate interpreter wired into the OCR worker launcher), installs the pinned
  CPU-only engines, and records a manifest with the exact resolved versions.

  Everything it writes stays inside the repository: venv, uv cache, staging, manifest.
  It never changes HOME/USERPROFILE globally and never touches an existing external cache.

  Sources (resolved 2026-11-16, not invented):
    x64 CPU PaddlePaddle wheel index: https://www.paddlepaddle.org.cn/packages/stable/cpu/
      paddlepaddle-3.2.1-cp312-cp312-win_amd64.whl is listed there
    PaddleOCR-VL 1.6 model card: https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6
      requires PaddlePaddle >= 3.2.1 and paddleocr[doc-parser] >= 3.6.0
    Pipeline docs: https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/PaddleOCR-VL.html
      (Python 3.9-3.13 supported; x64 CPU is a supported device; CPU is documented as
      NOT recommended for production speed - measured here rather than assumed)
    Tesseract: see scripts/prepare-tesseract-runtime.ps1 (separate, already prepared)
#>
param(
    [string]$PythonVersion = "3.12",
    [string]$PaddlePaddle = "3.2.1",
    [string]$PaddleOCR = "3.6.0",
    # protobuf is pinned explicitly, not left to the resolver. Measured 2026-11-17: the resolver
    # landed on 6.33.4, while sentencepiece 0.2.3's sentencepiece_model_pb2.py carries gencode
    # 7.36.1, and PaddleX imports that stub while building the PaddleOCR-VL tokenizer ->
    # "VersionError: ... gencode 7.36.1 runtime 6.33.4" minutes into an exclusive OCR window.
    # paddlepaddle 3.2.1 declares protobuf>=3.20.2 with no upper bound; 7.36.2 is what the main
    # backend venv already runs on this host.
    [string]$Protobuf = "7.36.2",
    [switch]$Force,
    [switch]$ManifestOnly,
    [switch]$Probe
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $repo "python-backend\.venv-ocr"
$cache = Join-Path $repo ".data\cache\uv"
$staging = Join-Path $repo ".data\tmp\ocr-setup"
$manifest = Join-Path $repo ".data\models\ocr\ocr-runtime.json"
New-Item -ItemType Directory -Force -Path $cache, $staging, (Split-Path -Parent $manifest) | Out-Null
$env:UV_CACHE_DIR = $cache
$env:PIP_CACHE_DIR = $cache

if ((Test-Path (Join-Path $venv "Scripts\python.exe")) -and -not $Force) {
    Write-Output "venv exists: $venv (use -Force to recreate)"
} else {
    if ($Force -and (Test-Path $venv)) { Remove-Item -LiteralPath $venv -Recurse -Force }
    & uv venv $venv --python $PythonVersion
    if ($LASTEXITCODE -ne 0) { Write-Error "uv venv failed: $LASTEXITCODE"; exit $LASTEXITCODE }
}
$py = Join-Path $venv "Scripts\python.exe"

# -ManifestOnly re-records an environment that ALREADY exists, without importing paddle.
# Importing the framework is a cold multi-gigabyte load, and this script runs on laptops
# that are already out of RAM; the distribution set is evidence the installer itself
# wrote to disk (*.dist-info / `uv pip freeze`), so it needs no interpreter at all.
# Pass -Probe to additionally record a real paddle.device probe.
if ($ManifestOnly) {
    if (-not (Test-Path $py)) { Write-Output "no OCR venv at $venv - run this script without -ManifestOnly first"; exit 2 }
    if ($Probe) {
        $devProbeRaw = & $py -c "import json,paddle; print(json.dumps({'paddle':paddle.__version__,'compiled_with_cuda':bool(getattr(paddle,'is_compiled_with_cuda',lambda:False)()),'device':str(paddle.device.get_device()),'commit':getattr(paddle,'commit',''),'build_cpu':bool(getattr(paddle.version,'is_compiled_with_mkldnn',lambda:False)())}))"
        if ($LASTEXITCODE -ne 0) { Write-Output "paddle import probe failed: $LASTEXITCODE"; exit $LASTEXITCODE }
        $devProbe = $devProbeRaw | ConvertFrom-Json
    } else {
        # NOTE: `$probe` is the -Probe switch parameter (PowerShell variables are
        # case-insensitive), so the recorded value must use a different name.
        $devProbe = [PSCustomObject]@{
            paddle = ""
            compiled_with_cuda = $false
            device = "not_probed"
            commit = ""
            build_cpu = $false
            note = "written without importing the framework (no RAM cost). CPU placement is enforced at run time by the OCR worker passing device=cpu and echoing paddle.device back to the parent, which refuses a non-CPU echo; re-run with -Probe to record a static probe."
        }
    }
    $freezeM = uv pip freeze --python $py
    [PSCustomObject]@{
        prepared_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        recorded_by = "prepare-ocr-runtime.ps1 -ManifestOnly"
        venv = ".venv-ocr"
        interpreter = $py.Substring($repo.Length + 1)
        python = (& $py --version).ToString()
        uv = (uv --version)
        uv_cache_dir = ".data/cache/uv"
        paddlepaddle_pin = $PaddlePaddle
        paddle_index = "https://www.paddlepaddle.org.cn/packages/stable/cpu/"
        paddleocr_pin = $PaddleOCR
        protobuf_pin = $Protobuf
        device_probe = $devProbe
        freeze = $freezeM
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifest -Encoding UTF8
    Write-Output "MANIFEST $manifest"
    Write-Output ($devProbe | ConvertTo-Json -Depth 4 -Compress)
    exit 0
}

& uv pip install --python $py "paddlepaddle==$PaddlePaddle" --index-url "https://www.paddlepaddle.org.cn/packages/stable/cpu/"
if ($LASTEXITCODE -ne 0) { Write-Output "paddlepaddle install failed: $LASTEXITCODE"; exit $LASTEXITCODE }

& uv pip install --python $py "paddleocr[doc-parser]==$PaddleOCR"
if ($LASTEXITCODE -ne 0) { Write-Output "paddleocr install failed: $LASTEXITCODE"; exit $LASTEXITCODE }

# Explicit ABI pin, AFTER the resolver runs, so a transitive choice cannot quietly put an older
# protobuf under the generated stubs. The gencode/runtime floor is re-checked by readiness
# (ruke_ml.models.ocr_runtime.gencode_floor), so a wrong value here fails fast, not in a window.
& uv pip install --python $py "protobuf==$Protobuf"
if ($LASTEXITCODE -ne 0) { Write-Output "protobuf install failed: $LASTEXITCODE"; exit $LASTEXITCODE }

# Device truth: the manifest must record the device the installed build will actually use.
# (`$probe` is the -Probe switch parameter - PowerShell names are case-insensitive.)
$devProbeRaw = & $py -c "import json,paddle; print(json.dumps({'paddle':paddle.__version__,'compiled_with_cuda':bool(getattr(paddle,'is_compiled_with_cuda',lambda:False)()),'device':str(paddle.device.get_device()),'commit':getattr(paddle,'commit',''),'build_cpu':bool(getattr(paddle.version,'is_compiled_with_mkldnn',lambda:False)())}))"
if ($LASTEXITCODE -ne 0) { Write-Output "paddle import probe failed: $LASTEXITCODE"; exit $LASTEXITCODE }
# `uv venv` creates an environment WITHOUT pip (that is the point of a uv-managed env),
# so the resolved-version record must come from uv itself.
$freeze = uv pip freeze --python $py

[PSCustomObject]@{
    prepared_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    venv = ".venv-ocr"
    python = (& $py --version).ToString()
    uv = (uv --version)
    uv_cache_dir = ".data/cache/uv"
    paddlepaddle_pin = $PaddlePaddle
    paddle_index = "https://www.paddlepaddle.org.cn/packages/stable/cpu/"
    paddleocr_pin = $PaddleOCR
    protobuf_pin = $Protobuf
    device_probe = ($devProbeRaw | ConvertFrom-Json)
    freeze = $freeze
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifest -Encoding UTF8
Write-Output "MANIFEST $manifest"
Write-Output $devProbeRaw
