# run-browser-e2e-exclusive.ps1 — Phase 18 exclusive Playwright launcher
# (CLAUDE.md §1 lock protocol, machine-enforced).
#
# What it guarantees:
#   * Acquires `.ai-coordination/playwright.lock` ATOMICALLY before anything
#     runs (CreateNew ⇒ two launchers cannot both hold it); a pre-existing
#     lock is a hard stop, never a bypass.
#   * Starts the deterministic fixture server (tests/fixtures/browser/
#     server.mjs, port 3210) and the dev supervisor (npm run dev ⇒ Next
#     :3000 + Rust :3101) ONLY if they are not already answering.
#   * Runs Playwright in the FOREGROUND; the exit code of this script is the
#     Playwright exit code.
#   * finally: stops only the processes THIS script started, and always
#     removes the lock — including when Playwright or a startup check fails.
#
# Usage (from anywhere):
#   powershell -NoProfile -File scripts\run-browser-e2e-exclusive.ps1
#   powershell -NoProfile -File scripts\run-browser-e2e-exclusive.ps1 `
#       -TestFiles tests\browser-easy.spec.ts
#   MULTIPLE files need PowerShell's array syntax, which -File does NOT parse:
#   a comma-joined string arrives as ONE argument ("No tests found"), and bare
#   space-separated files bind POSITIONALLY (the second one lands in -Grep and
#   the run silently selects nothing). Use -Command with a real array instead:
#     powershell -NoProfile -Command "& 'scripts\run-browser-e2e-exclusive.ps1' -TestFiles 'tests\a.spec.ts','tests\b.spec.ts' -AppWaitSeconds 300"
#   From an interactive PowerShell prompt, the array binds directly:
#     & scripts\run-browser-e2e-exclusive.ps1 -TestFiles 'tests\a.spec.ts','tests\b.spec.ts'
param(
    [string[]]$TestFiles = @(
        "tests/browser-easy.spec.ts",
        "tests/browser-medium.spec.ts",
        "tests/browser-hard.spec.ts"
    ),
    [int]$AppWaitSeconds = 240,
    # Optional Playwright `-g` pattern — used to run ONE real-model journey
    # per exclusive invocation (plan rows 19–24: one blocking invocation
    # each, full idle between).
    [string]$Grep = "",
    # Lock protocol (Brief §3.3): inspect a foreign lock and exit without
    # touching it; break a stale lease ONLY with a printed proof that the
    # original holder process ended; heartbeat refresh interval for the
    # lock record (0 disables the heartbeat child).
    [switch]$LockInfo,
    [switch]$BreakStaleLock,
    [int]$HeartbeatSeconds = 30
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Import-Module (Join-Path $PSScriptRoot "playwright-lock.psm1")

function Test-TcpPort([string]$HostName, [int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect($HostName, $Port)
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Test-HttpUp([string]$Url) {
    try {
        $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
        return $true
    } catch {
        # A WebException WITH a response means a server answered (any status).
        return ($_.Exception.Response -ne $null)
    }
}

$lockDir = Join-Path $root ".ai-coordination"
$lockPath = Join-Path $lockDir "playwright.lock"
New-Item -ItemType Directory -Force -Path $lockDir | Out-Null

# Atomic acquire (module-implemented): CreateNew fails if the file already
# exists — the §1.2 rule ("another session owns the workload") is enforced
# by the filesystem, not by politeness. The record carries
# runId/owner/PID/phase/started/heartbeat in a fixed-width layout, and the
# holder keeps its handle open (no FileShare.Delete) so a live lock is
# physically undeletable by anyone else.
$lock = $null
try {
    $lock = Acquire-PlaywrightLock -Path $lockPath -Phase "test"
} catch [System.IO.IOException] {
    # PS 5.1 (.NET Framework) has no FileAlreadyExistsException — CreateNew
    # on an existing file surfaces as IOException 0x80070050 (ERROR_FILE_EXISTS;
    # PS 7 derives its richer type from the same base and HResult).
    if ($_.Exception.HResult -ne -2147024816) { throw }
    $ev = Get-PlaywrightLockEvidence -Path $lockPath
    if ($ev) {
        Write-Output ("Foreign lock: runId=" + $ev.RunId + " owner=" + $ev.Owner +
            " PID=" + $ev.Pid + " phase=" + $ev.Phase +
            " started=" + $ev.Started + " heartbeat=" + $ev.Heartbeat +
            " alive=" + $ev.Alive)
    }
    if ($LockInfo) {
        Write-Output "LockInfo mode: inspecting only — nothing started, nothing touched."
        exit 3
    }
    if ($BreakStaleLock) {
        if (-not (Remove-PlaywrightLockStale -Path $lockPath)) {
            throw "Refusing to break the lock: the holder is live (or staleness is unprovable)."
        }
        $lock = Acquire-PlaywrightLock -Path $lockPath -Phase "test"
    } else {
        throw "Another Playwright session owns the test lock: $lockPath (use -LockInfo to inspect; -BreakStaleLock breaks ONLY a provably-dead holder)"
    }
}
Write-Output ("Playwright lock acquired: $lockPath (runId " + $lock.RunId + ")")

# Heartbeat child: refreshes the lock's heartbeat while this script runs, so
# §1.2 waiters can tell "alive and grinding" from "hung". Killed in finally.
$hbProc = $null
if ($HeartbeatSeconds -gt 0) {
    $hbScript = Join-Path $PSScriptRoot "playwright-lock-heartbeat.ps1"
    $hbProc = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", $hbScript, "-LockPath", $lockPath, "-ParentPid", $PID,
            "-Seconds", "$HeartbeatSeconds") `
        -WindowStyle Hidden -PassThru
}

$fixtureProc = $null
$appProc = $null
$testExit = 1

try {
    # ── fixture server :3210 (start only if not already answering) ───────
    if (Test-TcpPort "127.0.0.1" 3210) {
        Write-Output "Reusing fixture server already listening on 127.0.0.1:3210"
    } else {
        $fixtureScript = Join-Path $root "tests\fixtures\browser\server.mjs"
        if (-not (Test-Path $fixtureScript)) {
            throw "fixture server missing: $fixtureScript"
        }
        $fixtureProc = Start-Process -FilePath "node" `
            -ArgumentList $fixtureScript `
            -WorkingDirectory $root -WindowStyle Hidden -PassThru
        $bound = $false
        for ($i = 0; $i -lt 40 -and -not $bound; $i++) {
            Start-Sleep -Seconds 1
            $bound = Test-TcpPort "127.0.0.1" 3210
        }
        if (-not $bound) {
            throw "fixture server never bound 127.0.0.1:3210"
        }
        Write-Output "Fixture server started on 127.0.0.1:3210 (PID $($fixtureProc.Id))"
    }

    # ── app: Next :3000 (supervisor also owns Rust :3101) ────────────────
    if (Test-HttpUp "http://localhost:3000") {
        Write-Output "Reusing dev app already answering on :3000"
    } else {
        # Supervisor stdout/err (ruke-server tracing rides stderr) are
        # captured so model-round rounds/latency census survives the run
        # for the ANALYZE phase — display only, never a test input.
        $supOut = Join-Path $lockDir "dev-supervisor.out.log"
        $supErr = Join-Path $lockDir "dev-supervisor.err.log"
        $appProc = Start-Process -FilePath "cmd.exe" `
            -ArgumentList "/c", "npm run dev" `
            -WorkingDirectory $root -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $supOut -RedirectStandardError $supErr
        $up = $false
        $deadline = (Get-Date).AddSeconds($AppWaitSeconds)
        while (-not $up -and (Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 2
            $up = Test-HttpUp "http://localhost:3000"
        }
        if (-not $up) {
            throw "dev server never answered on http://localhost:3000 within $AppWaitSeconds s"
        }
        Write-Output "Dev supervisor started (PID tree $($appProc.Id))"
    }

    # ── Playwright, foreground; artifacts preserved by the config ────────
    # (PS 5.1 has no ternary — build the suffix the old way.)
    $grepNote = ""
    if ($Grep -ne "") { $grepNote = " grep = $Grep" }
    Write-Output "Playwright starting: test files = $($TestFiles -join ', ')$grepNote"
    if ($Grep -ne "") {
        & npx.cmd playwright test -g $Grep @TestFiles
    } else {
        & npx.cmd playwright test @TestFiles
    }
    $testExit = $LASTEXITCODE
    Write-Output "Playwright exit code: $testExit"
}
finally {
    # Stop ONLY what this script started.
    if ($hbProc -ne $null) {
        Stop-Process -Id $hbProc.Id -Force -ErrorAction SilentlyContinue
    }
    if ($lock -ne $null) {
        try { Set-PlaywrightLockPhase -Lock $lock -Phase "teardown" } catch { }
    }
    if ($appProc -ne $null) {
        Write-Output "Stopping dev supervisor tree (PID $($appProc.Id)) started by this script"
        # taskkill writes to stderr when a tree child exits mid-kill; PowerShell
        # promotes that to a NativeCommandError which, under ErrorActionPreference
        # 'Stop', aborts this finally block and orphans the lock + fixture server
        # (observed 2026-11-02). Route taskkill's output through cmd so PowerShell
        # never sees the stderr line; teardown must never throw.
        & cmd.exe /c "taskkill /PID $($appProc.Id) /T /F >nul 2>&1"
        Stop-Process -Id $appProc.Id -Force -ErrorAction SilentlyContinue
    }
    if ($fixtureProc -ne $null) {
        Write-Output "Stopping fixture server (PID $($fixtureProc.Id)) started by this script"
        Stop-Process -Id $fixtureProc.Id -Force -ErrorAction SilentlyContinue
    }
    # Owner-only release (module): verifies OUR runId is still the token in
    # the file before deleting; a foreign/replaced lock is never removed.
    if ($lock -ne $null) {
        if (Release-PlaywrightLock -Lock $lock) {
            Write-Output "Playwright lock released."
        }
    }
}

exit $testExit
