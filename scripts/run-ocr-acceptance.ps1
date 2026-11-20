<#
.SYNOPSIS
  The OCR acceptance runner for the D1 corpus (SPEC 15 / amendments 2, 3 and 4).

.DESCRIPTION
  Two evidence layers, deliberately separate:

    ENGINE      `python -m ruke_ml.handoff --pdf ...` drives the real cascade in one
                exclusive window and writes machine-readable evidence. The fault-injection
                environment belongs to THAT process, so this script can set it honestly.

    PRODUCTION  the upload path: Next -> Rust -> Python supervisor -> the same cascade, then
                the answer key is scored against what the chat/extract route actually returned
                (docs/overnight/probes/d1_ocr_acceptance_probe.py). The fault environment has
                to be visible to the tree that answers HTTP, so -StartDev is required for the
                fault passes: the script starts its OWN dev tree, sets the environment for it,
                and stops only the processes it started.

  Unattended-safe here: -SelfCheck (probe mechanics only, no engine), the readiness report and
  -DryRun. Everything else is an ATTENDED run: the primary pass loads 1.9 GB of weights and,
  when the measured fit says the resident main model has to go, unloads and reloads it on an
  endpoint with capacity 1. That is why -AllowUnload needs -ConfirmUnload UNLOAD.

.NOTES
  Nothing in this script kills a process by image name. The only processes it may stop are the
  ones it started itself.
#>
[CmdletBinding()]
param(
  [ValidateSet("all","engine","production","content","fallback_primary","fallback_crash","no_language")]
  [string]$Pass = "all",
  [switch]$AllowUnload,
  [string]$ConfirmUnload = "",
  [switch]$SelfCheck,
  [switch]$StartDev,
  [string]$BaseUrl = "http://localhost:3000",
  [string]$RukeBase = "http://127.0.0.1:3101",
  [string]$StrataBase = "http://127.0.0.1:8080",
  [string]$OutDir = "",
  [int]$MaxFreeMib = 0,
  [string]$InjectPrimaryFailurePage = "",
  [int]$Dpi = 200,
  # F32: an attended run must bound its own blind window. The handoff runner already accepts
  # --pages; exposing it here keeps scripts/run-ocr-acceptance.ps1 the single authoritative runner
  # instead of asking the operator to hand-build the command line. Empty = every page (the frozen
  # corpus default). Any restricted run must be reported as restricted, not as a full-corpus pass.
  [string]$Pages = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$py = Join-Path $repo "python-backend\.venv\Scripts\python.exe"
$probe = Join-Path $repo "docs\overnight\probes\d1_ocr_acceptance_probe.py"
$pdfDir = Join-Path $repo "docs\overnight\fixtures\d1\pdfs"
if (-not $OutDir) { $OutDir = Join-Path $repo "docs\overnight\logs" }
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$ownedPids = New-Object System.Collections.Generic.List[int]

# pass -> (fixture, RUKE_OCR_FAULT, extra handoff args, language)
$passes = [ordered]@{
  content          = @{ fixture = "d1_scanned.pdf";     fault = "";           lang = "eng"; inject = "0" }
  fallback_primary = @{ fixture = "d1_scanned.pdf";     fault = "unavailable"; lang = "eng"; inject = "0" }
  fallback_crash   = @{ fixture = "d1_scanned.pdf";     fault = "crash";      lang = "eng"; inject = "0" }
  no_language      = @{ fixture = "d1_scan_nolang.pdf"; fault = "";           lang = "";    inject = "0" }
}
$enginePasses = switch ($Pass) {
  "all"        { @("content","fallback_primary","fallback_crash","no_language") }
  "engine"     { @("content","fallback_primary","fallback_crash","no_language") }
  "production" { @() }
  default      { @($Pass) }
}
$productionPasses = switch ($Pass) {
  "all"        { @("content","fallback_primary","fallback_crash","no_language") }
  "production" { @("content","fallback_primary","fallback_crash","no_language") }
  "engine"     { @() }
  default      { @($Pass) }
}

function Header([string]$text) {
  Write-Host ""
  Write-Host ("=" * 78)
  Write-Host $text
  Write-Host ("=" * 78)
}

function Show-Resources {
  Header "PRECONDITIONS - host resources (measured)"
  $os = Get-CimInstance -ClassName Win32_OperatingSystem
  Write-Host ("RAM free/total MiB   : {0} / {1}" -f [math]::Round($os.FreePhysicalMemory / 1024),
              [math]::Round($os.TotalVisibleMemorySize / 1024))
  Write-Host ("commit used/total MiB: {0} / {1}" -f [math]::Round(($os.TotalVirtualMemorySize - $os.FreeVirtualMemory) / 1024),
              [math]::Round($os.TotalVirtualMemorySize / 1024))
  $smi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
  if ($smi) {
    Write-Host "VRAM (nvidia-smi)    :"
    & nvidia-smi.exe --query-gpu=name,memory.total,memory.used,memory.free --format=csv,noheader
  } else {
    Write-Host "VRAM                 : nvidia-smi not on PATH - VRAM headroom UNVERIFIED"
  }
}

function Show-Readiness {
  Header "PRECONDITIONS - OCR readiness (no model is loaded to answer this)"
  $out = & $py -m ruke_ml.documents.ocr_cascade 2>&1
  $code = $LASTEXITCODE
  $text = ($out -join "`n")
  try {
    $rep = $text | ConvertFrom-Json
    Write-Host ("primary engine   : {0}  ready={1}" -f $rep.primary.engine, $rep.primary.ready)
    Write-Host ("primary blockers : {0}" -f (($rep.primary.blockers | ForEach-Object { $_ }) -join " | "))
    Write-Host ("runtime          : {0} ({1})" -f $rep.primary.runtime.interpreter, $rep.primary.runtime.detail)
    Write-Host ("pinned pins      : {0}" -f (($rep.primary.runtime.pinned.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ", "))
    Write-Host ("asset snapshots  : {0}" -f (($rep.primary.assets | ForEach-Object { "$($_.model_id) present=$($_.present)" }) -join "; "))
    Write-Host ("declared peaks   : ram {0} MiB ({1}); vram {2} MiB ({3})" -f `
                $rep.primary.estimate.est_peak_mib, $rep.primary.estimate.est_peak_basis,
                $rep.primary.estimate.est_peak_vram_mib, $rep.primary.estimate.est_vram_basis)
    Write-Host ("recovery engine  : {0} - languages {1}" -f $rep.recovery.status, ($rep.recovery_languages -join ","))
    Write-Host ("rasterizer       : {0} {1}" -f $rep.rasterizer.package, $rep.rasterizer.version)
    Write-Host ("policy           : primary={0} allow_gpu={1} allow_unload={2}" -f $rep.policy.primary,
                $rep.policy.allow_gpu, $rep.policy.allow_unload)
  } catch {
    Write-Host "readiness report was not parseable; raw output follows"
    Write-Host $text
  }
  Write-Host ("readiness exit    : {0} (non-zero = the PRIMARY engine cannot run here)" -f $code)
}

function Show-Coordination {
  Header "PRECONDITIONS - shared coordination state"
  $lease = Join-Path $repo ".ai-coordination\llm-handoff.lock"
  $journal = Join-Path $repo ".data\python\handoff-journal.json"
  if (Test-Path -LiteralPath $lease) {
    Write-Host "LEASE  : PRESENT - another handoff window is open; this run would conflict."
    Get-Content -LiteralPath $lease -Raw
  } else { Write-Host "LEASE  : none" }
  if (Test-Path -LiteralPath $journal) {
    Write-Host "JOURNAL: PRESENT - an earlier window may need --recover, read this first:"
    Get-Content -LiteralPath $journal -Raw
  } else { Write-Host "JOURNAL: none" }
  foreach ($u in @("$StrataBase/health", "$RukeBase/api/ruke/health")) {
    try {
      $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 5
      Write-Host ("HEALTH : {0} -> {1}" -f $u, $r.StatusCode)
    } catch { Write-Host ("HEALTH : {0} -> UNREACHABLE ({1})" -f $u, $_.Exception.Message) }
  }
}

function Start-OwnDev {
  Header "STARTING A DEV TREE THIS SCRIPT OWNS (so the fault environment reaches the worker)"
  $log = Join-Path $OutDir ("d1-dev-" + $stamp + "-pass" + $script:passName + ".log")
  $p = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "npm run dev > `"$log`" 2>&1") `
        -WorkingDirectory $repo -PassThru -WindowStyle Hidden
  $ownedPids.Add($p.Id)
  Write-Host ("dev tree pid {0}; log {1}" -f $p.Id, $log)
  $ready = $false
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 2
    try {
      $r = Invoke-WebRequest -Uri "$BaseUrl" -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -lt 500) { $ready = $true; break }
    } catch { }
  }
  if (-not $ready) { Write-Warning "the dev tree did not answer on $BaseUrl within 180 s" }
  return $ready
}

function Stop-OwnTree {
  if (-not $ownedPids.Count) { return }
  Header "STOPPING ONLY THE PROCESSES THIS SCRIPT STARTED"
  $all = New-Object System.Collections.Generic.List[int]
  $queue = New-Object System.Collections.Generic.Queue[int]
  foreach ($pid0 in $ownedPids) { $queue.Enqueue($pid0) }
  while ($queue.Count) {
    $current = $queue.Dequeue()
    $all.Add($current)
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$current" -ErrorAction SilentlyContinue |
      ForEach-Object { $queue.Enqueue($_.ProcessId) }
  }
  foreach ($t in (@($all) | ForEach-Object { $_ } | Select-Object -Unique)) {
    Stop-Process -Id $t -Force -ErrorAction SilentlyContinue
  }
  Write-Host ("stopped pids: {0}" -f (($all | Select-Object -Unique) -join ", "))
  $ownedPids.Clear()
}

function Run-EnginePass([string]$name) {
  $cfg = $passes[$name]
  $script:passName = $name
  $fixture = Join-Path $pdfDir $cfg.fixture
  if (-not (Test-Path -LiteralPath $fixture)) {
    Write-Warning "fixture missing: $fixture"
    return 2
  }
  $env:RUKE_OCR_FAULT = $cfg.fault
  $env:RUKE_OCR_PRIMARY = ""
  if ($AllowUnload) { $env:RUKE_OCR_ALLOW_UNLOAD = "1" } else { Remove-Item Env:RUKE_OCR_ALLOW_UNLOAD -ErrorAction SilentlyContinue }
  if (-not $cfg.lang) { $env:RUKE_DOCUMENT_OCR_LANGUAGE = "" } else { $env:RUKE_DOCUMENT_OCR_LANGUAGE = $cfg.lang }
  $outFile = Join-Path $OutDir ("d1-engine-" + $name + "-" + $stamp + ".json")
  $argv = @("-m", "ruke_ml.handoff", "--pdf", $fixture, "--language", $cfg.lang, "--dpi", [string]$Dpi,
            "--lease-owner", ("d1-" + $name), "--out", $outFile)
  if ($AllowUnload) { $argv += "--allow-unload" }
  if ($MaxFreeMib -gt 0) { $argv += @("--max-free-mib", [string]$MaxFreeMib) }
  if ($Pages) { $argv += @("--pages", $Pages) }
  if ($InjectPrimaryFailurePage) { $argv += @("--inject-primary-failure-page", $InjectPrimaryFailurePage) }
  Write-Host ""
  Write-Host ("command: {0} {1}" -f $py, ($argv -join " "))
  Write-Host ("env    : RUKE_OCR_FAULT='{0}' RUKE_DOCUMENT_OCR_LANGUAGE='{1}' RUKE_OCR_ALLOW_UNLOAD='{2}'" -f `
              $env:RUKE_OCR_FAULT, $env:RUKE_DOCUMENT_OCR_LANGUAGE, $env:RUKE_OCR_ALLOW_UNLOAD)
  if ($DryRun) { Write-Host "DRY RUN - not executed."; return 0 }
  # F31 measured bug: a native command's stdout joins this function's output stream, so the
  # return value became System.Object[] and the final `exit` threw
  # ConvertToFinalInvalidCastException. Stream to the host instead and return one int.
  # ErrorActionPreference is relaxed only around the call because PS 5.1 turns native stderr
  # records into terminating errors under Stop; the exit code is the real signal.
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $py @argv 2>&1 | ForEach-Object { Write-Host ("  | {0}" -f $_) }
  $code = [int]$LASTEXITCODE
  $ErrorActionPreference = $prevEAP
  Write-Host ("engine pass {0}: exit {1}; evidence {2}" -f $name, $code, $outFile)
  $env:RUKE_OCR_FAULT = ""
  return $code
}

function Run-ProductionPass([string]$name) {
  $script:passName = $name
  $outFile = Join-Path $OutDir ("d1-http-" + $name + "-" + $stamp + ".json")
  $argv = @($probe, "--pass", $name, "--base", $BaseUrl, "--out", $outFile)
  Write-Host ""
  Write-Host ("command: {0} {1}" -f $py, ($argv -join " "))
  if ($DryRun) { Write-Host "DRY RUN - not executed."; return 0 }
  # F31 measured bug: with no tree answering, the probe raised ConnectionRefusedError and the
  # pass looked like a script crash. A dead tree is a RECORDED precondition failure instead.
  try {
    $ping = Invoke-WebRequest -Uri $BaseUrl -UseBasicParsing -TimeoutSec 5
    Write-Host ("tree reachable: {0} -> {1}" -f $BaseUrl, $ping.StatusCode)
  } catch {
    Write-Warning ("no tree answering $BaseUrl - production pass '$name' recorded as code 3 " +
                   "(precondition_not_met). Start 'npm run dev' or re-run with -StartDev.")
    return 3
  }
  if (-not $StartDev) {
    Write-Warning ("the fault-injection environment has to be set in the environment of the tree " +
                   "that answers HTTP. Re-run with -StartDev (this script then starts and stops " +
                   "its own tree), or restart npm run dev from a shell where these variables are set. " +
                   "Whatever the probe records is what the tree really did.")
  }
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $py @argv 2>&1 | ForEach-Object { Write-Host ("  | {0}" -f $_) }
  $code = [int]$LASTEXITCODE
  $ErrorActionPreference = $prevEAP
  Write-Host ("production pass {0}: exit {1}; evidence {2}" -f $name, $code, $outFile)
  return $code
}

if ($SelfCheck) {
  Header "SELF CHECK - probe mechanics only, no engine, no upload"
  & $py $probe --self-check
  exit $LASTEXITCODE
}

Show-Resources
Show-Readiness
Show-Coordination

if ($AllowUnload -and $ConfirmUnload -ne "UNLOAD") {
  Write-Error ("-AllowUnload may unload and reload the resident main model on an endpoint with " +
               "capacity 1, for minutes. Re-run with -ConfirmUnload UNLOAD to confirm you are " +
               "watching the screen and that no other client of that endpoint is active.")
  exit 2
}
if (-not $AllowUnload) {
  Write-Host ""
  Write-Host "Without -AllowUnload the primary pass is admitted only if OCR fits alongside the"
  Write-Host "resident main model. If it does not, the run must end as a typed resource-limit"
  Write-Host "result - that is a legitimate acceptance outcome, not a crash."
}

$results = [ordered]@{}
foreach ($name in $enginePasses) { $results["engine:" + $name] = Run-EnginePass $name }
if ($productionPasses.Count -and -not $DryRun) {
  foreach ($name in $productionPasses) {
    $script:passName = $name
    $up = $true
    if ($StartDev) { $up = Start-OwnDev }
    if ($up) { $results["production:" + $name] = Run-ProductionPass $name }
    else { Write-Warning "skipping production pass $name - no tree answered on $BaseUrl" }
    Stop-OwnTree
  }
} elseif ($productionPasses.Count) {
  foreach ($name in $productionPasses) { $results["production:" + $name] = Run-ProductionPass $name }
}

Header "SUMMARY (exit codes; 0 = the answer key passed, non-zero = a recorded miss or refusal)"
foreach ($k in $results.Keys) { Write-Host ("{0,-32} {1}" -f $k, $results[$k]) }
Write-Host ""
Write-Host "Engine evidence is NOT production-path evidence. Both are needed before OCR is GREEN."
$worst = 0
foreach ($v in $results.Values) { if ([int]$v -ne 0) { $worst = 1 } }
exit $worst
