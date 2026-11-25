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
    [int]$HeartbeatSeconds = 30,
    # Brief section 10 isolation seam: which conversation store the app under
    # test uses. "" = the launcher's own e2e store (see below). An already
    # exported WEBUI_DATA_DIR always wins.
    [string]$DataDir = "",
    # F129 (user brief 2026-11-23 sections 2-5): the exclusive batch grants the
    # ML handoff window INSIDE its own lock, so the GPU/Parakeet acceptance rows
    # run real handoffs during real uploads (the batch is the only inference
    # owner; Claude stays dormant; zero :8080 inference while Strata is
    # unloaded). -NoMlGrant keeps the pre-F129 law: the lock refuses every
    # ML handoff for the whole window.
    [switch]$NoMlGrant,
    # F152 Part 1 (2026-11-24): a live run graded on saved evidence must be served
    # by an app whose conversation store, python result root (WEBUI_DATA_DIR drives
    # ruke_ml runtime_dir) and model-request capture the launcher ITSELF wired.
    # The f152-live-1 attempt lost its wire proof to a FOREIGN app on :3000 that
    # wrote to the real store with the proxy bypassed. -RequireIsolation refuses
    # to reuse a foreign-owned :3000/:3101, NEVER kills it, and with
    # -WaitForReleaseSeconds > 0 waits for release and starts the isolated
    # instance itself; on timeout it hard-stops with exit 87.
    [switch]$RequireIsolation,
    [int]$WaitForReleaseSeconds = 0,
    # Set on the app this launcher starts so the run's capture proxy sees every
    # final model request (settings.json llm_api_url still wins — the documented
    # chain — and the identity record below prints the resolved store either way).
    [string]$LlmProxyUrl = "",
    # F153 §4b case (b) (2026-11-24): the brief's handoff case (b) row runs the
    # AUTHORIZED handoff-ON journey (real Parakeet transcript under a real
    # unload/restore). The pin below keeps the DEFAULT handoff-off, so a
    # constrained-memory admission stays an honest retryable refusal naming the
    # policy. An operator who authorizes handoff FOR THIS RUN passes
    # -AuthorizeHandoff: the inversion is loud, per-run, and lands in the
    # identity record; the default and machine settings never change.
    [switch]$AuthorizeHandoff
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Import-Module (Join-Path $PSScriptRoot "playwright-lock.psm1")

# ── Brief section 10: "Use isolated test data. Never modify real user
# conversations/uploads during tests." ────────────────────────────────────
# Both persistence resolvers - lib/persistence/dataRoot.ts (TS) and
# rust-backend/crates/ruke-server/src/main.rs (Rust) - take the conversation
# store from WEBUI_DATA_DIR and otherwise fall back to
# <home>/.local-intelligence/conversations. A live-model e2e run drives the
# REAL product, so with no override it writes into the user's actual chat
# store: measured on 2026-11-16, the CRUD/recents specs seed, rename, pin,
# archive, group and bulk-delete conversations there (14 store files touched
# in one Stage-B run; no user chat was deleted, because every destructive
# spec addresses only its own seeded unique title, but that is luck, not a
# gate). Model configuration lives in project-root settings.json, NOT in the
# store, so pointing the store somewhere else does not disable the live model.
function Get-E2EDataStore {
    param([string]$Explicit)
    $override = (Get-Item Env:WEBUI_DATA_DIR -ErrorAction SilentlyContinue).Value
    if ($override -and $override.Trim()) {
        return [pscustomobject]@{ Source = "inherited WEBUI_DATA_DIR"; Path = $override.Trim() }
    }
    if ($Explicit -and $Explicit.Trim()) {
        return [pscustomobject]@{ Source = "-DataDir"; Path = $Explicit.Trim() }
    }
    return [pscustomobject]@{ Source = "launcher default"; Path = (Join-Path $root ".data\e2e-store") }
}

$store = Get-E2EDataStore -Explicit $DataDir
# PS 5.1 has no ?? operator, so resolve the home explicitly.
$homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:HOME) { $env:HOME } else { "" }
$realStore = if ($homeDir) { Join-Path $homeDir ".local-intelligence\conversations" } else { "" }
if ($realStore -and ($store.Path -replace '\\', '/') -eq ($realStore -replace '\\', '/')) {
    throw "refusing to run e2e against the real user conversation store: $($store.Path)"
}
# -LockInfo is a read-only inspection: it must not create anything.
# Nothing is created or exported yet: -LockInfo can exit before any run starts,
# and a read-only inspection must not create a store. The store is materialised
# only after this script has actually acquired the lock (see below).


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

# F152 Part 1: WHO owns a port, printed before any costly run so app identity is
# verified, not assumed (the f152-live-1 run reused a foreign app started 08:02
# whose environment owned the evidence trail). Read-only: never kills, never
# touches the owner.
function Get-PortOwner([int]$Port) {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $conns) { return $null }
    $procId = ($conns | Select-Object -First 1).OwningProcess
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    return [pscustomobject]@{
        Pid     = $procId
        Name    = $(if ($p) { $p.ProcessName } else { "?" })
        Path    = $(try { $p.Path } catch { "?" })
        Started = $(try { $p.StartTime } catch { "?" })
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
$mlWindow = $(if ($NoMlGrant) { "" } else { "grant" })
try {
    $lock = Acquire-PlaywrightLock -Path $lockPath -Phase "test" -MlWindow $mlWindow
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
        $lock = Acquire-PlaywrightLock -Path $lockPath -Phase "test" -MlWindow $mlWindow
    } else {
        throw "Another Playwright session owns the test lock: $lockPath (use -LockInfo to inspect; -BreakStaleLock breaks ONLY a provably-dead holder)"
    }
}
Write-Output ("Playwright lock acquired: $lockPath (runId " + $lock.RunId +
    "; ML window: " + $(if ($mlWindow) { "GRANTED to product ML handoffs for this window" } else { "refused for the whole window" }) + ")")

# From here this script is definitely going to run tests, so the isolated
# conversation store becomes real. Done BEFORE any app child starts, so both the
# Rust server and Next inherit the same WEBUI_DATA_DIR.
New-Item -ItemType Directory -Force -Path $store.Path | Out-Null
$env:WEBUI_DATA_DIR = $store.Path
Write-Output "e2e conversation store isolated: $($store.Path) (source: $($store.Source))"

# F153 §4: the live batches run under the PINNED handoff-off policy, in the
# maintained template and not just in a generated kit (the f152-submit pin at
# lines 83-84 is this law's per-batch copy). Handoff OFF is what makes a
# constrained-memory ML admission an honest retryable refusal naming the
# policy (lifecycle._commit_ceiling_shortfall, test_memory_policy.py:152) —
# the graded truth the batches assert; a silently-widened exclusive window
# launders a real shortage away. The OCR unload pin keeps the engine
# resident for the same honesty. Supervisor + Rust children inherit.
if ($AuthorizeHandoff) {
    $env:RUKE_LLM_AUTOMATIC_HANDOFF = "1"
    Write-Output "PIN INVERTED BY OPERATOR AUTHORIZATION THIS RUN: RUKE_LLM_AUTOMATIC_HANDOFF=1 (handoff case (b) live row); RUKE_OCR_ALLOW_UNLOAD stays 0; default handoff-off law UNCHANGED; recorded in launcher-identity.json"
} else {
    $env:RUKE_LLM_AUTOMATIC_HANDOFF = "0"
    Write-Output "pins RUKE_LLM_AUTOMATIC_HANDOFF=0 RUKE_OCR_ALLOW_UNLOAD=0 (env; supervisor + Rust inherit)"
}
$env:RUKE_OCR_ALLOW_UNLOAD = "0"

# The model-asset cache is a SHARED download root (PaddlePaddle/PaddleOCR-VL-1.6,
# PP-DocLayoutV3, HF snapshots), not per-store user data. Isolating it made the
# Paddle primary "not executable here" in the e2e store (F91.1/fr-P10 fell to
# Tesseract with "no snapshot for this repo id in any configured cache root").
# Isolate conversations/settings; share the model cache. An explicit override
# wins. Propagates: launcher -> dev supervisor -> Python supervisor -> workers.
if (-not (Get-Item Env:RUKE_ML_CACHE_DIR -ErrorAction SilentlyContinue).Value) {
    $env:RUKE_ML_CACHE_DIR = Join-Path $root ".data\ml-cache"
    Write-Output "model cache shared: $env:RUKE_ML_CACHE_DIR"
}

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
    # F152 Part 1: -RequireIsolation refuses a FOREIGN-owned :3000/:3101 — the
    # owner is identified and PRINTED, never touched. With -WaitForReleaseSeconds
    # the launcher waits for the owner to release, then starts its own fully
    # isolated instance (store + python result root + capture wired by it);
    # a foreign listener that does not release is a hard stop (exit 87), never
    # a reuse and never a kill.
    if ($RequireIsolation -and ((Test-HttpUp "http://localhost:3000") -or (Test-TcpPort "127.0.0.1" 3101))) {
        $o3 = Get-PortOwner 3000
        $o1 = Get-PortOwner 3101
        Write-Output ("Foreign port owners (NOT touched): :3000 PID=" + $(if ($o3) { "$($o3.Pid) $($o3.Name) started=$($o3.Started)" } else { "free" }) +
            "; :3101 PID=" + $(if ($o1) { "$($o1.Pid) $($o1.Name) started=$($o1.Started)" } else { "free" }))
        $relDeadline = (Get-Date).AddSeconds($WaitForReleaseSeconds)
        while ((Test-HttpUp "http://localhost:3000") -or (Test-TcpPort "127.0.0.1" 3101)) {
            if ((Get-Date) -ge $relDeadline) {
                Write-Output "Ports not released within $WaitForReleaseSeconds s. The foreign listener is LEFT ALONE (leave-it-alone law): it is not this run's app, its environment owns its evidence, and this launcher never kills it. Re-run when the ports are free."
                exit 87
            }
            Start-Sleep -Seconds 5
        }
        Write-Output "Foreign app released the ports; starting the launcher-owned isolated instance."
    }
    $reused = $false
    if (Test-HttpUp "http://localhost:3000") {
        $reused = $true
        $o3 = Get-PortOwner 3000
        Write-Output ("Reusing dev app already answering on :3000 (owner PID " +
            $(if ($o3) { "$($o3.Pid) $($o3.Name)" } else { "unknown" }) + ")")
        # The reused server was started by someone else, so it may be using a
        # different (possibly non-isolated) store. Say so instead of implying
        # the isolation above applied to it.
        Write-Warning "Reused app was NOT started by this script: its conversation store is whatever its own environment says. For a guaranteed-isolated live run, pass -RequireIsolation (it refuses reuse and never kills the owner) or stop that app first (or pass -DataDir and start it yourself)."
    } else {
        if ($LlmProxyUrl -and $LlmProxyUrl.Trim()) {
            # The capture proxy rides the app's env (chain: settings.json
            # llm_api_url > LLM_API_URL > .env.local > :8080; a settings.json
            # pin wins, and the identity record prints what the app resolves).
            $env:LLM_API_URL = $LlmProxyUrl.Trim()
            Write-Output "app LLM_API_URL = $($env:LLM_API_URL) (capture proxy; settings.json llm_api_url would win)"
        }
        $appStartUtc = (Get-Date).ToUniversalTime()
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

    # ── app identity record (F152 Part 1) ────────────────────────────────
    # f152-live-1 rode a FOREIGN app started 08:02 — before the Stage-6 edits,
    # with .env.local's store and a direct :8080 — so the run proved nothing
    # about the tree under test. The launcher that OWNS the app writes the
    # facts BEFORE Playwright starts: store, python OCR result root, the
    # RESOLVED LLM URL (chain settings.json > LLM_API_URL > .env.local > :8080;
    # the settings pin wins), and :3000/:3101 owner PID + start time. The live
    # spec asserts against this file pre-run. Under -RequireIsolation the Rust
    # server must be THIS launcher's child (start time >= app start): a server
    # predating the binary under test silently runs old assembly, so that is a
    # hard stop (exit 87) — the old process is reported, never killed.
    $idPath = Join-Path $store.Path "launcher-identity.json"
    if ($RequireIsolation -and -not $reused) {
        $rustDeadline = (Get-Date).AddSeconds(120)
        while (-not (Test-TcpPort "127.0.0.1" 3101) -and (Get-Date) -lt $rustDeadline) {
            Start-Sleep -Seconds 2
        }
        if (-not (Test-TcpPort "127.0.0.1" 3101)) {
            Write-Output "-RequireIsolation: the supervisor never brought up the Rust server on :3101 within 120 s — the chat path under test would not be the production path."
            exit 87
        }
    }
    $o3 = Get-PortOwner 3000
    $o1 = Get-PortOwner 3101
    $pin = $null
    $rootSettings = Join-Path $root "settings.json"
    if (Test-Path $rootSettings) {
        try { $pin = (Get-Content $rootSettings -Raw | ConvertFrom-Json).llm_api_url } catch { $pin = "UNPARSEABLE" }
    }
    $envLocalUrl = $null
    $envLocalFile = Join-Path $root ".env.local"
    if (Test-Path $envLocalFile) {
        $m = Select-String -Path $envLocalFile -Pattern '^\s*LLM_API_URL\s*=\s*(.+)$' | Select-Object -Last 1
        if ($m) { $envLocalUrl = $m.Matches[0].Groups[1].Value.Trim().Trim('"') }
    }
    $resolvedLlm = if ($pin) { "$pin (settings.json pin WINS)" } `
        elseif ($env:LLM_API_URL) { "$($env:LLM_API_URL) (env)" } `
        elseif ($envLocalUrl) { "$envLocalUrl (.env.local)" } `
        else { "http://localhost:8080 (fallback)" }
    $identity = [ordered]@{
        schema          = "ruke.e2e-launcher-identity.v1"
        runId           = $lock.RunId
        appStartedUtc   = $appStartUtc
        reusedForeign   = $reused
        storePath       = $store.Path
        storeSource     = $store.Source
        pythonOcrResultRoot = Join-Path $store.Path "python\ocr-results"
        llmResolved     = $resolvedLlm
        llmEnvSet       = $env:LLM_API_URL
        llmSettingsPin  = $pin
        llmEnvLocal     = $envLocalUrl
        owner3000       = $o3
        owner3101       = $o1
        requireIsolation = [bool]$RequireIsolation
        handoffAuthorized = [bool]$AuthorizeHandoff
    }
    $identity | ConvertTo-Json -Depth 4 | Out-File -Encoding ascii $idPath
    Write-Output ("launcher identity -> " + $idPath + " : store=" + $store.Path +
        " llm=" + $resolvedLlm +
        " :3000=" + $(if ($o3) { "PID $($o3.Pid) start $($o3.Started)" } else { "none" }) +
        " :3101=" + $(if ($o1) { "PID $($o1.Pid) start $($o1.Started)" } else { "none" }))
    if ($RequireIsolation -and -not $reused) {
        if (-not $o1 -or $o1.Started -eq "?" -or $o1.Started -lt $appStartUtc) {
            Write-Output ("-RequireIsolation: :3101 owner PID " + $(if ($o1) { $o1.Pid } else { "none" }) +
                " started " + $(if ($o1) { $o1.Started } else { "?" }) + " predates this launcher's app start " + $appStartUtc +
                " — an OLD server assembly would prove nothing. Hard stop; the old process is LEFT ALONE, never killed.")
            exit 87
        }
        Write-Output "identity verified: :3101 server (PID $($o1.Pid)) started THIS launcher — post-edit binary, isolated store."
    }

    # ── Playwright, foreground; artifacts preserved by the config ────────
    # (PS 5.1 has no ternary — build the suffix the old way.)
    $grepNote = ""
    if ($Grep -ne "") { $grepNote = " grep = $Grep" }
    Write-Output "Playwright starting: test files = $($TestFiles -join ', ')$grepNote"
    # node.exe direct, NOT the npx.cmd shim: cmd.exe re-parses the command
    # line, so a grep containing `|` (e.g. "fr-F152|fr-F153") splits at the
    # pipe into two commands (F153 batch evidence: pre-lock fast fail).
    # node.exe receives the variable argument verbatim.
    $pwCli = Join-Path $root "node_modules\@playwright\test\cli.js"
    if ($Grep -ne "") {
        & node $pwCli test -g $Grep @TestFiles
    } else {
        & node $pwCli test @TestFiles
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
