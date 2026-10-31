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
    [string]$Grep = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

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

# Atomic acquire: CreateNew fails if the file already exists — the §1.2
# rule ("another session owns the workload") is enforced by the filesystem,
# not by politeness.
try {
    $lockStream = [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::Read)
} catch [System.IO.FileAlreadyExistsException] {
    throw "Another Playwright session owns the test lock: $lockPath"
}
# NOTE: build the lock text in a separate statement — PS 5.1 mis-parses
# nested `ToString('o')` interpolation inside GetBytes(...) and the script
# dies AFTER the exclusive handle is held, stranding the lock file.
try {
    $lockText = "PID=$PID Started=" + (Get-Date).ToString('o')
    $lockBytes = [System.Text.Encoding]::UTF8.GetBytes($lockText)
    $lockStream.Write($lockBytes, 0, $lockBytes.Length)
} catch {
    $lockStream.Dispose()
    Remove-Item -Path $lockPath -Force -ErrorAction SilentlyContinue
    throw
}
$lockStream.Dispose()
Write-Output "Playwright lock acquired: $lockPath"

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
        $appProc = Start-Process -FilePath "cmd.exe" `
            -ArgumentList "/c", "npm run dev" `
            -WorkingDirectory $root -WindowStyle Hidden -PassThru
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
    if ($appProc -ne $null) {
        Write-Output "Stopping dev supervisor tree (PID $($appProc.Id)) started by this script"
        & taskkill.exe /PID $appProc.Id /T /F 2>$null | Out-Null
    }
    if ($fixtureProc -ne $null) {
        Write-Output "Stopping fixture server (PID $($fixtureProc.Id)) started by this script"
        Stop-Process -Id $fixtureProc.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -Path $lockPath -Force -ErrorAction SilentlyContinue
    Write-Output "Playwright lock released."
}

exit $testExit
