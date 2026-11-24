<#
  prepare-ocr-runtime.ps1 - the AUTHORIZED, explicit OCR runtime preparation step.

  Ordinary startup never runs this. It creates the project-local isolated OCR
  environment (the OCR dependency set conflicts with the main backend venv, which is why
  it is a separate interpreter wired into the OCR worker launcher), installs the pinned
  GPU-first engines (CPU wheel as the recorded fallback), and records a manifest with the
  exact resolved versions and a real paddle.device probe.

  Everything it writes stays inside the repository: venv, uv cache, staging, manifest.
  It never changes HOME/USERPROFILE globally and never touches an existing external cache.

  Sources (resolved 2026-11-22, not invented):
    CUDA 12.6 PaddlePaddle wheel index: https://www.paddlepaddle.org.cn/packages/stable/cu126/
      paddlepaddle_gpu-3.2.1-cp312-cp312-win_amd64.whl is listed there; this is the index
      the PaddleOCR-VL model card's own install command names. Windows GPU builds require
      CUDA capability > 7.5 and a driver >= 550.54.14 for cu126 (this host: RTX 3060
      sm_86, driver 621.35 - checked 2026-11-22).
    x64 CPU PaddlePaddle wheel index (the documented FALLBACK):
      https://www.paddlepaddle.org.cn/packages/stable/cpu/
      paddlepaddle-3.2.1-cp312-cp312-win_amd64.whl is listed there. The release law is
      "GPU preferred, CPU when the GPU can't safely proceed", so a CPU-fallback venv is a
      SUPPORTED shape and the manifest records paddle_build = "cpu-fallback".
    PaddleOCR-VL 1.6 model card: https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6
      requires PaddlePaddle >= 3.2.1 and paddleocr[doc-parser] >= 3.6.0
    Pipeline docs: https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/PaddleOCR-VL.html
      (Python 3.9-3.13 supported; GPU and x64 CPU are supported devices)
    Tesseract: see scripts/prepare-tesseract-runtime.ps1 (separate, already prepared)

  NOTE on safetensors: the model card's "special safetensors" wheel is for the PaddleOCR-VL
  SERVER path. The paddleocr[doc-parser] pipeline path is measured working on this host with
  stock safetensors 0.7.0 (F78 scanned-page runs), so this script does not install the
  nightly CDN wheel; readiness re-checks the real dependency ABI (gencode_floor) anyway.
#>
param(
    [string]$PythonVersion = "3.12",
    [string]$PaddlePaddle = "3.2.1",
    [string]$PaddleIndex = "https://www.paddlepaddle.org.cn/packages/stable/cu126/",
    [string]$PaddleIndexFallback = "https://www.paddlepaddle.org.cn/packages/stable/cpu/",
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
            note = "written without importing the framework (no RAM cost). Placement is enforced at run time: the OCR worker passes the planned device and echoes paddle.device back to the parent, which refuses any echo that contradicts the plan; re-run with -Probe to record a static probe."
        }
    }
    $freezeM = uv pip freeze --python $py
    # The manifest records the build that is REALLY installed, not the one requested: the
    # GPU-first install falls back to the CPU index, and ocr_runtime validates through
    # PADDLE_FALLBACK_DIST. Match uv's normalization (names lowercased, runs of -._ -> _).
    $gpuM = @($freezeM | Where-Object { $_ -match '^paddlepaddle[_-]gpu==' })
    $cpuM = @($freezeM | Where-Object { $_ -match '^paddlepaddle==' })
    $buildM = if ($gpuM.Count -gt 0) { "gpu" } elseif ($cpuM.Count -gt 0) { "cpu-fallback" } else { "none" }
    [PSCustomObject]@{
        prepared_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        recorded_by = "prepare-ocr-runtime.ps1 -ManifestOnly"
        venv = ".venv-ocr"
        interpreter = $py.Substring($repo.Length + 1)
        python = (& $py --version).ToString()
        uv = (uv --version)
        uv_cache_dir = ".data/cache/uv"
        paddlepaddle_pin = $PaddlePaddle
        paddle_build = $buildM
        paddle_index = $(if ($buildM -eq "cpu-fallback") { $PaddleIndexFallback } else { $PaddleIndex })
        paddle_index_fallback = $PaddleIndexFallback
        paddleocr_pin = $PaddleOCR
        protobuf_pin = $Protobuf
        device_probe = $devProbe
        freeze = $freezeM
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifest -Encoding UTF8
    Write-Output "MANIFEST $manifest"
    Write-Output ($devProbe | ConvertTo-Json -Depth 4 -Compress)
    exit 0
}

# GPU-first (B5 final decision 2026-11-22): fetch the CUDA 12.6 wheel from the model card's
# own index. If the wheel cannot be resolved on this host the release law is "CPU when the
# GPU can't safely proceed", so fall back to the CPU index and RECORD that in the manifest -
# a CPU-fallback venv validates through ocr_runtime.PADDLE_FALLBACK_DIST, never as a broken
# runtime. The build recorded below is the one that actually installed.
$paddleBuild = "gpu"
$paddleIndexUsed = $PaddleIndex
& uv pip install --python $py "paddlepaddle-gpu==$PaddlePaddle" --index-url $PaddleIndex
if ($LASTEXITCODE -ne 0) {
    Write-Output "GPU paddle wheel unavailable on this host (exit $LASTEXITCODE): falling back to the CPU index per the release law"
    $paddleBuild = "cpu-fallback"
    $paddleIndexUsed = $PaddleIndexFallback
    & uv pip install --python $py "paddlepaddle==$PaddlePaddle" --index-url $PaddleIndexFallback
    if ($LASTEXITCODE -ne 0) { Write-Output "paddlepaddle CPU fallback install failed: $LASTEXITCODE"; exit $LASTEXITCODE }
}

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
    paddle_build = $paddleBuild
    paddle_index = $paddleIndexUsed
    paddle_index_fallback = $PaddleIndexFallback
    paddleocr_pin = $PaddleOCR
    protobuf_pin = $Protobuf
    device_probe = ($devProbeRaw | ConvertFrom-Json)
    freeze = $freeze
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifest -Encoding UTF8
Write-Output "MANIFEST $manifest"
Write-Output $devProbeRaw
