# playwright-lock.psm1 — Brief §3.3 / CLAUDE.md §1.2 lock primitives, one
# implementation shared by the exclusive launcher, the heartbeat child, and
# the lock self-test. NEVER edit lock semantics in only one place.
#
# Guarantees:
#   * Atomic acquire: FileMode CreateNew — two launchers can never both hold.
#   * Lock contents carry runId (owner token), owner tag, PID, phase,
#     started, and a heartbeat timestamp, in a FIXED-WIDTH 512-byte record
#     so the heartbeat child can rewrite it in place without truncation.
#   * The holder keeps its handle open with FileShare Read|Write (so the
#     heartbeat can refresh) but WITHOUT FileShare.Delete — a live holder's
#     lock physically cannot be deleted by anyone else.
#   * Owner-only release: Release verifies the runId inside the file before
#     deleting; a lock whose token isn't ours is never removed.
#   * Stale lease = PROOF the original process ended (PID absent, or the PID
#     now belongs to a process that started LATER than the lock — PID reuse).
#     Anything unprovable is treated as live (fail-safe).

$Script:LockRecordWidth = 512

function Get-PlaywrightLockRecord {
    param(
        [string]$RunId,
        [string]$Owner,
        [int]$PidValue,
        [string]$Phase,
        [string]$Started,
        [string]$Heartbeat
    )
    # Fixed-width JSON-ish record (not strict JSON after padding — parse by
    # regex). Fixed lengths: ISO-8601 'o' round-trip format is 29 chars in
    # PS 5.1 local time (always "+hh:mm" offset, exactly 7 fraction digits).
    $text = '{"runId":"' + $RunId + '"' +
            ',"owner":"' + $Owner + '"' +
            ',"pid":' + $PidValue +
            ',"phase":"' + $Phase + '"' +
            ',"started":"' + $Started + '"' +
            ',"heartbeat":"' + $Heartbeat + '"}'
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    if ($bytes.Length -gt $Script:LockRecordWidth) {
        throw "lock record too long ($($bytes.Length) > $Script:LockRecordWidth): shorten owner/runId"
    }
    $fixed = New-Object byte[] $Script:LockRecordWidth
    [Array]::Copy($bytes, $fixed, $bytes.Length)
    return ,$fixed
}

function Acquire-PlaywrightLock {
    <# Atomic CreateNew acquire. Returns @{Stream; RunId; Path}; throws
       FileAlreadyExistsException when another session owns the lock. #>
    param(
        [string]$Path,
        [string]$Owner = ($env:USERNAME + '@' + $env:COMPUTERNAME),
        [string]$Phase = "test"
    )
    $runId = [guid]::NewGuid().ToString()
    $now = (Get-Date).ToString('o')
    $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::ReadWrite)   # no Delete share: undeletable while alive
    try {
        $rec = Get-PlaywrightLockRecord -RunId $runId -Owner $Owner -PidValue $PID `
            -Phase $Phase -Started $now -Heartbeat $now
        $stream.Write($rec, 0, $rec.Length)
        $stream.Flush()
    } catch {
        $stream.Dispose()
        Remove-Item -Path $Path -Force -ErrorAction SilentlyContinue
        throw
    }
    return @{ Stream = $stream; RunId = $runId; Path = $Path; Started = $now }
}

function Read-PlaywrightLockText {
    param([string]$Path)
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    } catch { return $null }
    try {
        $buf = New-Object byte[] $Script:LockRecordWidth
        $n = $fs.Read($buf, 0, $Script:LockRecordWidth)
        return [System.Text.Encoding]::UTF8.GetString($buf, 0, $n)
    } finally { $fs.Dispose() }
}

function Get-PlaywrightLockEvidence {
    <# Parse the lock and PROVE whether its holder is alive:
       - PID absent            -> the original process ended (stale, provable)
       - PID present but its
         StartTime is after the
         lock's "started"      -> the PID was recycled (stale, provable)
       - anything unprovable   -> treat as LIVE (fail-safe) #>
    param([string]$Path)
    $text = Read-PlaywrightLockText -Path $Path
    if ($null -eq $text) { return $null }
    $runId = [regex]::Match($text, '"runId":"([^"]+)"').Groups[1].Value
    $owner = [regex]::Match($text, '"owner":"([^"]+)"').Groups[1].Value
    $phase = [regex]::Match($text, '"phase":"([^"]+)"').Groups[1].Value
    $pidM  = [regex]::Match($text, '"pid":(\d+)')
    $startM = [regex]::Match($text, '"started":"([^"]+)"')
    $beatM  = [regex]::Match($text, '"heartbeat":"([^"]+)"')
    if (-not $pidM.Success) {
        # Malformed record: cannot prove anything about a holder — live by law.
        return @{ RunId = $runId; Owner = $owner; Phase = $phase; Pid = 0
                  Started = $null; Heartbeat = $null; Alive = $true; StaleProof = "" }
    }
    $holderPid = [int]$pidM.Groups[1].Value
    $alive = $true
    $proof = ""
    $proc = Get-Process -Id $holderPid -ErrorAction SilentlyContinue
    if ($null -eq $proc) {
        $alive = $false
        $proof = "PID $holderPid does not exist — original process ended"
    } elseif ($startM.Success) {
        try {
            $startedUtc = ([DateTimeOffset]::Parse(
                $startM.Groups[1].Value,
                [System.Globalization.CultureInfo]::InvariantCulture)).UtcDateTime
            $procStart = $proc.StartTime.ToUniversalTime()
            # A REAL holder necessarily started BEFORE taking the lock. Only
            # a process that started (well) AFTER the lock can be a recycled
            # PID wearing the dead holder's number.
            if ($procStart -gt $startedUtc.AddSeconds(2)) {
                $alive = $false
                $proof = "PID $holderPid was recycled (process started $procStart, after the lock was taken $startedUtc)"
            }
        } catch {
            $alive = $true   # StartTime unreadable (access denied) — fail-safe live
            $proof = "holder process exists but start time unreadable — treated LIVE"
        }
    }
    return @{ RunId = $runId; Owner = $owner; Phase = $phase; Pid = $holderPid
              Started = $startM.Groups[1].Value; Heartbeat = $beatM.Groups[1].Value
              Alive = $alive; StaleProof = $proof }
}

function Set-PlaywrightLockPhase {
    <# Rewrite phase+heartbeat IN PLACE through the holder's own handle.
       Refuses unless the on-disk token still matches our runId. #>
    param($Lock, [string]$Phase)
    # "started" stays the ORIGINAL acquire time (it is the reference for
    # PID-reuse detection); only phase + heartbeat move.
    $started = if ($Lock.Started) { $Lock.Started } else { (Get-Date).ToString('o') }
    $rec = Get-PlaywrightLockRecord -RunId $Lock.RunId `
        -Owner ($env:USERNAME + '@' + $env:COMPUTERNAME) -PidValue $PID `
        -Phase $Phase -Started $started -Heartbeat ((Get-Date).ToString('o'))
    $Lock.Stream.Seek(0, [System.IO.SeekOrigin]::Begin) | Out-Null
    $Lock.Stream.Write($rec, 0, $rec.Length)
    $Lock.Stream.Flush()
}

function Release-PlaywrightLock {
    <# Owner-only release: verify OUR runId is the token in the file, then
       close the handle and delete. A foreign/replaced lock is left alone
       (warning only) — the file must never be removed by a non-owner. #>
    param($Lock)
    $mine = $true
    try {
        $current = Read-PlaywrightLockText -Path $Lock.Path
        if ($null -eq $current -or $current -notlike ('*"' + $Lock.RunId + '"*')) {
            $mine = $false
            # Write-Warning (NOT Write-Output): informational text must never
            # ride the pipeline — it would turn the $true/$false return into an array.
            Write-Warning ("lock at $($Lock.Path) no longer carries runId $($Lock.RunId) — NOT releasing a foreign lock.")
        }
    } catch { $mine = $false }
    try { $Lock.Stream.Dispose() } catch { }
    if ($mine) {
        Remove-Item -Path $Lock.Path -Force -ErrorAction SilentlyContinue
    }
    return $mine
}

function Remove-PlaywrightLockStale {
    <# Break a stale lease ONLY with a printed proof that the original
       process ended. Returns $false (and changes nothing) unless provable. #>
    param([string]$Path)
    $ev = Get-PlaywrightLockEvidence -Path $Path
    if ($null -eq $ev) { Write-Host "no lock file at $Path"; return $false }
    if ($ev.Alive) {
        # Write-Host, not Write-Output: keeps the $true/$false return clean.
        Write-Host ("LOCK IS LIVE (runId " + $ev.RunId + ", PID " + $ev.Pid +
            ", phase " + $ev.Phase + ", heartbeat " + $ev.Heartbeat + "). Not breaking.")
        return $false
    }
    Write-Host ("STALE PROOF: " + $ev.StaleProof + " (runId " + $ev.RunId + ")")
    Remove-Item -Path $Path -Force -ErrorAction SilentlyContinue
    Write-Host "Stale lock removed: $Path"
    return $true
}
