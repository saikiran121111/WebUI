<#
.SYNOPSIS
  Prepares and validates the PROJECT-LOCAL Tesseract runtime used as the
  documents.ocr recovery fallback. Nothing is installed system-wide, nothing is
  written to the registry, and HOME / USERPROFILE / CODEX_HOME are never changed.

.DESCRIPTION
  Verified sources (read 2026-11-16, assets resolved from those pages, not invented):
    UB Mannheim Windows build page .... https://github.com/UB-Mannheim/tesseract/wiki
    setup asset on that page .......... tesseract-ocr-w64-setup-5.5.3.20260724.exe
    quality language data ............. https://github.com/tesseract-ocr/tessdata_best
    install docs ...................... https://tesseract-ocr.github.io/tessdoc/Installation.html

  The digests below are OURS: computed with Get-FileHash after the real downloads
  of session F16 (see .data/tools/tesseract/ocr-assets.json). They are a
  reproducibility pin, not an upstream-published checksum. osd.traineddata comes
  from the setup package; no separate osd download URL is claimed.

  Layout (all inside the project):
    .data/tools/tesseract/                        tesseract.exe + its runtime DLLs
    .data/tools/tesseract/tessdata/               language data used at runtime
    .data/tools/tesseract/tessdata_installed_fast/  the flavour the installer shipped (kept, never deleted)
    .data/tmp/tesseract-stage/                    bounded download staging

.PARAMETER VerifyOnly
  Do not download or install. Validate the existing project-local runtime:
  version, --list-langs coverage, and a REAL image-to-text run over a rasterised
  page of docs/overnight/fixtures/d1/pdfs/d1_scanned.pdf scored against words
  listed in docs/overnight/fixtures/d1/answer-key.json.

.PARAMETER Force
  Re-download and re-install even if the runtime is already present.

.PARAMETER KeepInstaller
  Keep the staged setup executable instead of removing it after install.

.PARAMETER SkipEngSwap
  Leave the installer's tessdata_fast eng.traineddata in place instead of
  promoting the quality-oriented tessdata_best flavour.
#>
param(
  [switch]$VerifyOnly,
  [switch]$Force,
  [switch]$KeepInstaller,
  [switch]$SkipEngSwap,
  [int]$Dpi = 200
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $repo '.data\tools\tesseract'
$tessdata = Join-Path $tools 'tessdata'
$exe = Join-Path $tools 'tesseract.exe'
$stage = Join-Path $repo '.data\tmp\tesseract-stage'
$verify = Join-Path $repo '.data\tmp\tesseract-verify'
$manifest = Join-Path $tools 'ocr-assets.json'

$pins = [ordered]@{
  installerUrl = 'https://github.com/tesseract-ocr/tesseract/releases/download/5.5.3/tesseract-ocr-w64-setup-5.5.3.20260724.exe'
  installerName = 'tesseract-ocr-w64-setup-5.5.3.20260724.exe'
  installerBytes = 26573224
  installerSha256 = 'BEE9E3434BD94FD65387D9BE28CD467A41F61B1275383B55B0F59A1331270AE4'
  engUrl = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/main/eng.traineddata'
  engBytes = 15400601
  engSha256 = '8280AED0782FE27257A68EA10FE7EF324CA0F8D85BD2FD145D1C2B560BCB66BA'
}

$result = [ordered]@{
  mode = if ($VerifyOnly) { 'verify-only' } else { 'prepare' }
  project_local_only = $true
  steps = @()
  warnings = @()
  installed_languages = @()
  version = ''
  real_ocr_run = $null
  ready = $false
}
function Add-Step($name, $status, $detail) {
  $script:result.steps += [ordered]@{ step = $name; status = $status; detail = $detail }
  Write-Host ("[{0}] {1} - {2}" -f $status.ToUpperInvariant(), $name, $detail)
}
function Add-Warning($text) { $script:result.warnings += $text; Write-Host ("WARNING: {0}" -f $text) }

New-Item -ItemType Directory -Force -Path $stage | Out-Null

function Get-Staged($url, $fileName, $expectedBytes, $expectedSha) {
  $dest = Join-Path $stage $fileName
  if ((Test-Path $dest) -and ((Get-Item $dest).Length -eq $expectedBytes) -and
      ((Get-FileHash -Algorithm SHA256 -LiteralPath $dest).Hash -eq $expectedSha)) {
    Add-Step 'download' 'skip' "$fileName already staged and hash-verified"
    return $dest
  }
  $drive = $dest.Substring(0, 1)
  $disk = (Get-PSDrive -Name $drive).Free
  if ($disk -lt ($expectedBytes * 3)) {
    throw "insufficient free disk on ${drive}: drive - only $([math]::Round($disk/1MB,1)) MiB free for $fileName"
  }
  $lastError = ''
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Write-Host ("attempt {0}/3: {1}" -f $attempt, $url)
      # Bounded retries. Byte-range resume is not used: PS 5.1 Invoke-WebRequest
      # restarts the body, so the retry count and the size/hash gate are the guard.
      Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 300 -OutFile $dest
      $lastError = ''
      break
    }
    catch {
      $lastError = $_.Exception.Message
      Write-Host ("download attempt {0} failed: {1}" -f $attempt, $lastError)
      Start-Sleep -Seconds (5 * $attempt)
    }
  }
  if ($lastError -ne '') { throw "download failed after 3 bounded attempts: $lastError" }
  if (-not (Test-Path $dest)) { throw "download produced no file: $fileName" }
  $bytes = (Get-Item $dest).Length
  $head = Get-Content -Encoding Byte -TotalCount 4 -LiteralPath $dest
  $headHex = (($head | ForEach-Object { $_.ToString('x2') }) -join '')
  if ($fileName -like '*.exe') {
    # Reject an HTML error page or an archive that was renamed to .exe.
    if ($headHex -ne '4d5a') { Add-Warning "$fileName starts with $headHex, not an MZ header - refusing to treat a non-executable as an installer"; throw 'bad magic number for an executable' }
    Add-Step 'magic' 'ok' "$fileName is a portable executable (MZ)"
  } else {
    Add-Step 'magic' 'ok' "$fileName first four bytes $headHex (a traineddata container header, not an executable - no MZ expected)"
  }
  if ($bytes -ne $expectedBytes) { throw "$fileName size $bytes != pinned $expectedBytes" }
  $sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $dest).Hash
  if ($sha.ToUpperInvariant() -ne $expectedSha.ToUpperInvariant()) { throw "$fileName sha256 $sha != pinned $expectedSha" }
  Add-Step 'download+verify' 'ok' "$fileName $bytes bytes, sha256 $sha (our pin), MZ header"
  return $dest
}

function Invoke-Tesseract($argv) {
  # tesseract writes progress ("Estimating resolution as ...") to stderr. Under
  # $ErrorActionPreference = 'Stop' PowerShell turns native-stderr output into a
  # terminating error, so the preference is narrowed for this call only.
  return Invoke-Captured $exe $argv
}

function Invoke-Captured($path, $argv) {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $path @argv 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  return @{ exit = $code; text = (($out | ForEach-Object { "$_" }) -join "`n") }
}

function Test-ExistingRuntime {
  if (-not (Test-Path $exe)) { return $false }
  $v = Invoke-Tesseract @('--version')
  if ($v.exit -ne 0) { Add-Warning "tesseract --version exited $($v.exit) from the project directory: $($v.text)"; return $false }
  $result.version = ($v.text -split "`n")[0].Trim()
  Add-Step 'executable' 'ok' "$exe -> $($result.version) (run in place; its DLLs resolve from the project directory)"
  $langs = Invoke-Tesseract @('--list-langs', '--tessdata-dir', $tessdata)
  $listed = @()
  foreach ($line in ($langs.text -split "`n")) {
    $t = $line.Trim()
    if ($t -eq '') { continue }
    if ($t.StartsWith('List of')) { continue }
    if ($t.StartsWith('Tesseract Open Source')) { continue }
    $listed += $t
  }
  $result.installed_languages = $listed
  Add-Step 'language coverage' 'ok' ("installed: {0} - reported live from --list-langs, no other language is claimed" -f ($listed -join ', '))
  return $true
}

function Test-RealOcrRun {
  $pdf = Join-Path $repo 'docs\overnight\fixtures\d1\pdfs\d1_scanned.pdf'
  $keyFile = Join-Path $repo 'docs\overnight\fixtures\d1\answer-key.json'
  if (-not (Test-Path $pdf) -or -not (Test-Path $keyFile)) {
    Add-Warning 'd1 fixture or answer key missing - the real image-to-text verification could not run'
    return
  }
  New-Item -ItemType Directory -Force -Path $verify | Out-Null
  $pageImage = Join-Path $verify 'd1_scanned_p1.ppm'
  $venvPy = Join-Path $repo 'python-backend\.venv\Scripts\python.exe'
  if (-not (Test-Path $venvPy)) { $venvPy = Join-Path $repo 'python-backend\.venv-ocr\Scripts\python.exe' }
  # pypdfium2 is already a runtime dependency; Pillow is not, so the page is written
  # as a binary PPM (tesseract reads PPM natively) using numpy, which is installed.
  $renderSrc = @'
import pypdfium2, numpy as np
doc = pypdfium2.PdfDocument(r'__PDF__')
bmp = doc[0].render(scale=__DPI__ / 72.0)
w, h, ch = bmp.width, bmp.height, bmp.n_channels
arr = np.frombuffer(bytes(bmp.buffer), dtype=np.uint8).reshape((h, w, ch))
rgb = arr[:, :, [2, 1, 0]] if ch == 4 else arr[:, :, :3]
with open(r'__OUT__', 'wb') as handle:
    handle.write(b'P6\n%d %d\n255\n' % (w, h))
    handle.write(np.ascontiguousarray(rgb).tobytes())
print('rasterised', w, 'x', h, 'channels', ch)
'@
  $renderSrc = $renderSrc.Replace('__PDF__', $pdf).Replace('__DPI__', "$Dpi").Replace('__OUT__', $pageImage)
  $tmpPy = Join-Path $verify 'render_page.py'
  [IO.File]::WriteAllText($tmpPy, $renderSrc, (New-Object System.Text.UTF8Encoding($false)))
  $renderRun = Invoke-Captured $venvPy @($tmpPy)
  if ($renderRun.exit -ne 0) { Add-Warning "rasteriser exited $($renderRun.exit): $($renderRun.text)" }
  if ((-not (Test-Path $pageImage)) -or ((Get-Item $pageImage).Length -lt 1000)) {
    Add-Warning "rasterisation failed - no usable page image at $pageImage"
    return
  }
  $outBase = Join-Path $verify 'p1'
  $run = Invoke-Tesseract @($pageImage, $outBase, '-l', 'eng', '--tessdata-dir', $tessdata)
  $outTxt = "$outBase.txt"
  if ($run.exit -ne 0 -or -not (Test-Path $outTxt)) {
    Add-Warning "real image-to-text run failed (exit $($run.exit)): $($run.text)"
    return
  }
  $text = Get-Content -Raw -LiteralPath $outTxt
  $keyDoc = (Get-Content -Raw -LiteralPath $keyFile) | ConvertFrom-Json
  $sentence = $keyDoc.fixtures.'d1_scanned.pdf'.expected_per_page.'1'
  if ($sentence) {
    $all = @($sentence -split '\s+' | Where-Object { $_ -ne '' } | Select-Object -First 20)
  } else {
    $all = @()
  }
  $probeWords = @('Section', 'aquifer', 'basin', 'yields', 'million', 'cubic', 'metres', 'salinity', 'Kandla', 'gauge', 'March', '2019', 'committee', 'Downstream', 'attributed')
  if ($all.Count -ge 10) { $probeWords = $all }
  $hits = @($probeWords | Where-Object { $text.Contains($_) })
  $missed = @($probeWords | Where-Object { -not $text.Contains($_) })
  $tessWords = @($text -split '\s+' | Where-Object { $_ -ne '' })
  $need = [math]::Max(1, [int][math]::Ceiling($probeWords.Count * 0.8))
  $result.real_ocr_run = [ordered]@{
    image = $pageImage
    dpi = $Dpi
    language = 'eng'
    recognised_words = $tessWords.Count
    key_words_matched = $hits.Count
    key_words_total = $probeWords.Count
    required = $need
    missed = $missed
    exit_code = $run.exit
    note = 'a real local image -> local text run using explicit project paths; a mechanics + non-garbage check, NOT an accuracy claim'
  }
  if ($hits.Count -ge $need) {
    Add-Step 'real image-to-text' 'ok' ("page 1 of d1_scanned.pdf at $Dpi dpi -> $($tessWords.Count) words; $($hits.Count)/$($probeWords.Count) answer-key words present (required at least $need)")
    $result.ready = $true
  } else {
    Add-Step 'real image-to-text' 'failed' ("only $($hits.Count)/$($probeWords.Count) answer-key words present (needed $need); missed: $($missed -join ', ')")
    Add-Warning 'the project-local Tesseract did not produce a usable result - the fallback engine is NOT ready'
  }
}

if ($VerifyOnly) {
  if (-not (Test-ExistingRuntime)) {
    Add-Step 'executable' 'missing' "no project-local tesseract at $exe - re-run this script without -VerifyOnly to prepare it"
    $result | ConvertTo-Json -Depth 6
    exit 4
  }
  Test-RealOcrRun
  $result | ConvertTo-Json -Depth 6
  if ($result.ready) { exit 0 } else { exit 5 }
}

if ((Test-Path $exe) -and (-not $Force)) {
  if (Test-ExistingRuntime) {
    Add-Step 'install' 'skip' 'project-local runtime already present (use -Force to reinstall)'
    Test-RealOcrRun
    $result | ConvertTo-Json -Depth 6
    if ($result.ready) { exit 0 } else { exit 5 }
  }
  Add-Warning 'an executable exists here but does not run correctly from the project directory - reinstalling'
}

# 1. staged download, then size / magic / pinned-hash verification
$setup = Get-Staged $pins.installerUrl $pins.installerName $pins.installerBytes $pins.installerSha256

# 2. silent project-local install (NSIS: /S, with /D= last and unquoted)
New-Item -ItemType Directory -Force -Path $tools | Out-Null
$proc = Start-Process -FilePath $setup -ArgumentList @('/S', "/D=$tools") -Wait -PassThru -WindowStyle Hidden
if (-not (Test-Path $exe)) {
  throw "installer exited with $($proc.ExitCode) but produced no $exe - the fallback runtime was NOT installed"
}
Add-Step 'silent install' 'ok' "installed into $tools (exit $($proc.ExitCode)); no system path, no registry entry"

# 3. promote the quality-oriented eng.traineddata; keep the shipped fast flavour, never delete it
$engPath = Join-Path $tessdata 'eng.traineddata'
if (-not $SkipEngSwap) {
  if ((Test-Path $engPath) -and ((Get-Item $engPath).Length -ne $pins.engBytes)) {
    $fastDir = Join-Path $tools 'tessdata_installed_fast'
    New-Item -ItemType Directory -Force -Path $fastDir | Out-Null
    Move-Item -LiteralPath $engPath -Destination (Join-Path $fastDir 'eng.traineddata') -Force
    Add-Step 'keep shipped flavour' 'ok' 'installer eng.traineddata moved to tessdata_installed_fast (kept for A/B, not used at runtime)'
  }
  $eng = Get-Staged $pins.engUrl 'eng.traineddata' $pins.engBytes $pins.engSha256
  Copy-Item -LiteralPath $eng -Destination $engPath -Force
  Add-Step 'language data' 'ok' "tessdata_best eng.traineddata promoted into $tessdata (pinned sha256 verified)"
}

# 4. provenance manifest built from the values actually verified above
if (Test-ExistingRuntime) {
  $osd = Join-Path $tessdata 'osd.traineddata'
  $manifestDoc = [ordered]@{
    purpose = 'project-local OCR assets for the Ruke documents.ocr fallback engine (Tesseract)'
    engine = [ordered]@{
      name = 'tesseract'
      version = $result.version
      executable = '.data/tools/tesseract/tesseract.exe'
      source_page = 'https://github.com/UB-Mannheim/tesseract/wiki'
      asset_url = $pins.installerUrl
      installer_bytes = $pins.installerBytes
      installer_sha256_computed_locally = $pins.installerSha256
      installer_magic = 'MZ (portable executable), verified before running'
      install_mode = 'silent project-local install: setup exe run with /S /D=<project path>; no system-wide install, no registry use'
      note = 'the sha256 is ours, computed after download; it is a pin, not an upstream-published digest'
    }
    language_data = @(
      [ordered]@{
        file = 'tessdata/eng.traineddata'
        flavour = 'tessdata_best (quality-oriented LSTM)'
        bytes = $pins.engBytes
        sha256_computed_locally = $pins.engSha256
        source_url = $pins.engUrl
        source_revision = 'branch main of tesseract-ocr/tessdata_best'
      },
      [ordered]@{
        file = 'tessdata/osd.traineddata'
        flavour = 'as installed by the 5.5.3 Windows package; no separate download URL is claimed'
        bytes = $(if (Test-Path $osd) { (Get-Item $osd).Length } else { 0 })
      }
    )
    installed_language_coverage = 'reported live from tesseract --list-langs by documents.ocr'
    written_by = "scripts/prepare-tesseract-runtime.ps1 at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  }
  [IO.File]::WriteAllText($manifest, ($manifestDoc | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
  Add-Step 'manifest' 'ok' $manifest
}

if (-not $KeepInstaller) {
  Remove-Item -LiteralPath $setup -Force -ErrorAction SilentlyContinue
  Add-Step 'staging cleanup' 'ok' 'setup executable removed from .data/tmp/tesseract-stage (it re-downloads if needed)'
}

Test-RealOcrRun
$result | ConvertTo-Json -Depth 6
if ($result.ready) {
  Write-Host 'The project-local Tesseract fallback is ready. That is engine readiness only: not an accuracy claim, and not primary-engine evidence.'
  exit 0
}
Write-Host 'The Tesseract runtime is present but the real image-to-text verification did not pass.'
exit 5
