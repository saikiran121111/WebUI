<#
.SYNOPSIS
  Preview or prepare the quality-preserving RAM placement change for the shared Strata engine.

.DESCRIPTION
  The measured problem (docs/overnight/STRATA-RAM.md): strata.exe holds ~52 GiB of resident
  working set on a 63.8 GiB host, leaving ~3.7 GiB free, which is why the Ruke 4 GB / 5 GB
  runtime budget cannot be met additively while the model is resident.

  The documented knob is `--ram-keep-gib W`: "RAM to leave free for your own work ... the
  expert arena is used only if W GiB stay available after it; otherwise the hottest experts
  are kept in a RAM copy that leaves max(W, 8 GiB on Windows / 4 GiB elsewhere) free and the
  rest are read from the files. 0 = the arena whenever it fits." It changes expert PLACEMENT
  (RAM vs file reads), not precision and not the model, so answers do not change; tokens/s in
  the cold case do (the engine's own help cites 71.97 vs 34.78 ms/token cold vs warm for the
  mmap placement family).

  This script NEVER touches a running process and never restarts anything. It only edits the
  launcher's JSON config, which takes effect on the NEXT engine start. Restarting the engine
  ends any active Ruke chat and any active coding-model session, so the timing is the user's
  call. Default action is preview-only.

.EXAMPLE
  powershell -NoProfile -File scripts\strata-low-ram.ps1                 # preview
  powershell -NoProfile -File scripts\strata-low-ram.ps1 -Apply -KeepGiB 16
  powershell -NoProfile -File scripts\strata-low-ram.ps1 -Verify
#>
[CmdletBinding()]
param(
    [string]$ConfigPath = 'D:\AI\Strata\strata-iq3_s.json',
    [ValidateRange(8, 32)][int]$KeepGiB = 16,
    [switch]$Apply,
    [switch]$Verify
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-RunningArgs {
    $p = Get-CimInstance Win32_Process -Filter "Name='strata.exe'" -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $p) { return $null }
    return @{ pid = $p.ProcessId; command = $p.CommandLine }
}

if ($Verify) {
    $run = Get-RunningArgs
    if (-not $run) { Write-Output 'verify: no strata.exe process is running'; exit 0 }
    $live = $run.command -match '--ram-keep-gib\s+(\d+)'
    $fileHas = $false
    if (Test-Path -LiteralPath $ConfigPath) {
        $cfg = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
        $fileHas = [bool](@($cfg.args) -contains '--ram-keep-gib')
    }
    Write-Output ("running pid {0}: --ram-keep-gib present={1} value={2}" -f `
        $run.pid, $live, $(if ($live) { $Matches[1] } else { 'absent (default 0 = arena whenever it fits)' }))
    Write-Output ("config file {0}: --ram-keep-gib present={1}" -f $ConfigPath, $fileHas)
    if ((-not $live) -and $fileHas) {
        Write-Output 'NOTE: the file carries the flag but the running engine does not - the engine must be restarted by its own launcher before the change is live.'
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Write-Error "config not found: $ConfigPath (pass -ConfigPath)"
    exit 2
}

$raw = Get-Content -LiteralPath $ConfigPath -Raw
$cfg = $raw | ConvertFrom-Json
if (-not $cfg.args) { Write-Error "config has no 'args' array: $ConfigPath"; exit 2 }

$args0 = @($cfg.args)
$clean = @()
$i = 0
while ($i -lt $args0.Count) {
    if ($args0[$i] -eq '--ram-keep-gib') { $i += 2; continue }
    if ($args0[$i] -like '--ram-keep-gib=*') { $i += 1; continue }
    $clean += $args0[$i]; $i += 1
}
$new = $clean + @('--ram-keep-gib', "$KeepGiB")

Write-Output "config : $ConfigPath"
Write-Output ("model  : {0}   port: {1}" -f $cfg.model_name, $cfg.port)
Write-Output ("current ram-keep-gib : {0}" -f $(if ($args0 -contains '--ram-keep-gib') { ($args0)[$args0.IndexOf('--ram-keep-gib')+1] } else { 'absent (0 = arena whenever it fits)' }))
Write-Output ("proposed ram-keep-gib: $KeepGiB  (leave ~$KeepGiB GiB of physical RAM free for Ruke and everything else)")
Write-Output 'quality  : placement only - same pack, same precision, same answers; cold tokens/s drops (see docs/overnight/STRATA-RAM.md)'

if (-not $Apply) {
    Write-Output ''
    Write-Output 'PREVIEW ONLY - nothing was written. Re-run with -Apply to stage it for the next engine start.'
    Write-Output 'Applying it does NOT restart anything; a restart by the user''s own launcher is required, and that restart ends any active Ruke chat and coding-model session.'
    exit 0
}

$cfg.args = $new
$json = $cfg | ConvertTo-Json -Depth 20
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = "$ConfigPath.$stamp.bak"
Copy-Item -LiteralPath $ConfigPath -Destination $bak
Set-Content -LiteralPath $ConfigPath -Value $json -Encoding utf8NoBOM -NoNewline
Write-Output ''
Write-Output ("backup  : $bak")
Write-Output ("written : $ConfigPath (args now end with --ram-keep-gib $KeepGiB)")
Write-Output 'next    : restart Strata through your usual launcher when it is acceptable to interrupt the model; then re-run with -Verify.'
$run = Get-RunningArgs
if ($run) {
    Write-Output ("reminder: pid {0} is still running with the OLD placement; this script did not touch it." -f $run.pid)
}
