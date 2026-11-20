<#
.SYNOPSIS
  Attended acceptance runner for the resource-handoff window (SPEC 17 / amendment 5, J4).

.DESCRIPTION
  Two classes of scenario, and the split is deliberate:

    SAFE      never posts /unload or /load and never runs inference. Lease mechanics, the
              stale-holder proof (including pid reuse), typed resource-limit refusal, worker
              crash recovery and journal recovery. These produce real evidence unattended.

    ATTENDED  they unload and reload the resident main model through the shared Strata
              endpoint (capacity 1). While the window is open every other client, INCLUDING
              this coding CLI, is locked out, and a ~48 GiB process is parked and reloaded.
              They therefore need BOTH -Attended and -ConfirmUnload UNLOAD, and an operator
              watching the screen.

  Nothing here kills a process by image name. The only processes this script may stop are the
  ones it started itself.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\run-handoff-acceptance.ps1
  powershell -ExecutionPolicy Bypass -File scripts\run-handoff-acceptance.ps1 -Attended -ConfirmUnload UNLOAD
#>
[CmdletBinding()]
param(
  [switch]$Attended,
  [string]$ConfirmUnload = "",
  [string]$RukeBase = "http://127.0.0.1:3101",
  [string]$StrataBase = "http://127.0.0.1:8080",
  [int]$EstPeakMib = 0,
  [string]$Out = "",
  [string]$Only = "",
  [switch]$SkipPrecheck,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$py = Join-Path $repo "python-backend\.venv\Scripts\python.exe"
$probe = Join-Path $repo "docs\overnight\probes\j4_handoff_probe.py"
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
if (-not $Out) { $Out = Join-Path $repo ("docs\overnight\logs\j4-attended-" + $stamp + ".json") }

function Header([string]$text) {
  Write-Host ""
  Write-Host ("=" * 78)
  Write-Host $text
  Write-Host ("=" * 78)
}

function Show-Resources {
  Header "PRECONDITIONS - host resources (measured, not estimated)"
  $os = Get-CimInstance -ClassName Win32_OperatingSystem
  $freeRamMib = [math]::Round($os.FreePhysicalMemory / 1024)
  $totalRamMib = [math]::Round($os.TotalVisibleMemorySize / 1024)
  $usedCommitMib = [math]::Round(($os.TotalVirtualMemorySize - $os.FreeVirtualMemory) / 1024)
  $totalCommitMib = [math]::Round($os.TotalVirtualMemorySize / 1024)
  Write-Host ("RAM free/total MiB      : {0} / {1}" -f $freeRamMib, $totalRamMib)
  Write-Host ("commit used/total MiB   : {0} / {1}" -f $freeCommitMib, $totalCommitMib)
  $smi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
  if ($smi) {
    Write-Host "VRAM (nvidia-smi)       :"
    & nvidia-smi.exe --query-gpu=name,memory.total,memory.used,memory.free --format=csv,noheader
  } else {
    Write-Host "VRAM                    : nvidia-smi not on PATH - VRAM headroom UNVERIFIED"
  }
}

function Show-Coordination {
  Header "PRECONDITIONS - shared coordination state"
  $lease = Join-Path $repo ".ai-coordination\llm-handoff.lock"
  $journal = Join-Path $repo ".data\python\handoff-journal.json"
  if (Test-Path -LiteralPath $lease) {
    Write-Host "LEASE  : PRESENT - another handoff window is open. Read it before proceeding:"
    Get-Content -LiteralPath $lease -Raw
  } else {
    Write-Host "LEASE  : none (no handoff window open)"
  }
  if (Test-Path -LiteralPath $journal) {
    Write-Host "JOURNAL: PRESENT - an earlier window may not have been restored. Recovery is"
    Write-Host "         idempotent, but read this before starting a new window:"
    Get-Content -LiteralPath $journal -Raw
  } else {
    Write-Host "JOURNAL: none (nothing awaiting restoration)"
  }
  foreach ($probe2 in @("$StrataBase/health", "$RukeBase/api/ruke/health")) {
    try {
      $r = Invoke-WebRequest -Uri $probe2 -UseBasicParsing -TimeoutSec 5
      Write-Host ("HEALTH : {0} -> {1}" -f $probe2, $r.StatusCode)
    } catch {
      Write-Host ("HEALTH : {0} -> UNREACHABLE ({1})" -f $probe2, $_.Exception.Message)
    }
  }
  Write-Host ""
  Write-Host "Strata capacity is 1. While an ATTENDED window runs, the coding CLI and any other"
  Write-Host "client of that endpoint are locked out. Confirm no other client is mid-request."
}

if (-not $SkipPrecheck) {
  Show-Resources
  Show-Coordination
}

$argv = @($probe)
if ($Attended) {
  if ($ConfirmUnload -ne "UNLOAD") {
    Write-Error ("-Attended unloads and reloads the resident main model on an endpoint with " +
                 "capacity 1. Re-run with -ConfirmUnload UNLOAD to confirm you are watching " +
                 "the screen and that no other client of the endpoint is active.")
    exit 2
  }
  $argv += @("--allow-unload", "--confirm", "UNLOAD")
  Header "ATTENDED RUN - the main model will be parked and reloaded"
} else {
  Header "SAFE RUN - no model lifecycle call, no inference"
  Write-Host "The five unload scenarios are recorded as HELD and stay unproven. Real unload"
  Write-Host "evidence needs -Attended -ConfirmUnload UNLOAD with an operator present."
}
if ($EstPeakMib -gt 0) { $argv += @("--est-peak-mib", [string]$EstPeakMib) }
if ($Only) { $argv += @("--only", $Only) }
$argv += @("--base", $RukeBase, "--out", $Out)

Write-Host ""
Write-Host ("command: {0} {1}" -f $py, ($argv -join " "))
if ($DryRun) {
  Write-Host "DRY RUN - nothing executed."
  exit 0
}

& $py @argv
$code = $LASTEXITCODE

Header "POST-RUN coordination state"
Show-Coordination
Write-Host ""
Write-Host ("probe exit code: {0}; evidence: {1}" -f $code, $Out)
exit $code