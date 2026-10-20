# engine_reaper.ps1 - lifecycle reaper for the WebUI decision engine (Windows).
#
# Launched HIDDEN by lib/decision/client.ts (via a throwaway PowerShell that
# Start-Process-es THIS one hidden, so its console is NOT in the dev server's
# console-destroy group). Never run it manually.
# Args: <dev-server PID> <worker launcher PID> <llama pidfile path>.
# Pure ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI and any
# non-ASCII byte corrupts parsing (an em-dash once made this script die at
# parse time while appearing to "run").
#
# Death-mode coverage (verified empirically 2026-10-20):
#   - Console destroy (window X / taskkill w/o /F on the dev window):
#     TerminateProcess()es everything ATTACHED to that console - cmd, node,
#     the python pair - without running any atexit/signal/exit handler.
#     llama-server CANNOT be reaped this way: llama.cpp detaches its own
#     console at startup (detach_console), so it sits outside every teardown
#     group - which is exactly the 500MB orphan users saw.
#   - Dev killed while its console survives (taskkill /F /PID node, crash):
#     the pair survives and must be tree-killed by this kernel wait.
# So: wait on the dev PID (kernel object - signals for every death mode),
# then reclaim BOTH engine halves explicitly:
#   1) launcher tree (taskkill /F /T) if it is still alive and still ours,
#   2) llama-server straight from its pidfile - its parent may already be
#      dead, so never rely on the process tree reaching it.
# Guards: same-starttime + cmdline must match our paths, so unrelated
# processes (e.g. Strata's own llama-server) can NEVER be touched.
# Transcript: %TEMP%\webui-engine-reaper.log (one line per step).
param([int]$NodePid, [int]$RootPid, [string]$LlamaPidfile)

$LogFile = Join-Path $env:TEMP "webui-engine-reaper.log"
function Log($m) {
  try {
    Add-Content -Path $LogFile -Value ("{0} [node={1} root={2}] {3}" -f (Get-Date -Format "HH:mm:ss"), $NodePid, $RootPid, $m) -ErrorAction SilentlyContinue
  } catch {}
}

Log "reaper started"
try { $born = (Get-Process -Id $RootPid -ErrorAction Stop).StartTime } catch { Log "root not found at boot - exit"; exit 0 }

# Kernel-object wait: fires the instant the dev server dies, whatever the mode.
try { (Get-Process -Id $NodePid -ErrorAction Stop).WaitForExit() } catch { Log "node not found - proceed now" }
Log "node pid $NodePid is gone"

# 1) Worker pair: taskkill the launcher subtree iff it is still OUR process.
try {
  if ((Get-Process -Id $RootPid -ErrorAction Stop).StartTime -ne $born) {
    Log "root PID recycled (StartTime mismatch) - skip tree kill"
  } else {
    $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$RootPid").CommandLine
    if ($cl -notmatch 'decision_server\.py|\.decision-engine[\\/]') {
      Log "root cmdline no longer ours ('$cl') - skip tree kill"
    } else {
      $out = taskkill /F /T /PID $RootPid 2>&1
      Log "pair taskkill exit=${LASTEXITCODE}: $($out -join ' | ')"
    }
  }
} catch { Log "root already dead - pair reaped by console/other" }

# 2) llama-server: own process, outside every console tree. Kill straight from
#    the pidfile until the file is gone or the pid is dead/foreign.
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  if (-not (Test-Path -LiteralPath $LlamaPidfile)) { Log "pidfile gone - llama reclaimed"; break }
  $lp = 0
  try { $lp = [int]((Get-Content -LiteralPath $LlamaPidfile -First 1).Trim()) } catch {}
  if ($lp -le 0) { Log "pidfile unreadable - exit"; break }
  $cl = $null
  try { $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$lp" -ErrorAction Stop).CommandLine } catch {}
  if (-not $cl) { Log "llama pid $lp not running - done"; break }
  if ($cl -notmatch '\.decision-engine[\\/]') { Log "llama pid $lp cmdline not ours ('$cl') - REFUSE to kill"; break }
  $out = taskkill /F /T /PID $lp 2>&1
  Log "llama taskkill exit=${LASTEXITCODE}: $($out -join ' | ')"
  Start-Sleep -Milliseconds 700
}
Log "reaper done"
