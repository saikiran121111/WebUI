# test-playwright-lock.ps1 — self-test for the §1.2/§3.3 lock protocol
# (scripts/playwright-lock.psm1). Runs in seconds, touches NO Playwright and
# NO inference backend — safe alongside any phase. Exit 0 = all assertions
# passed. Usage: powershell -NoProfile -File scripts\test-playwright-lock.ps1
$ErrorActionPreference = "Stop"
$mod = Join-Path $PSScriptRoot "playwright-lock.psm1"
Import-Module $mod

$tmp = Join-Path $env:TEMP ("pwlock-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$lp = Join-Path $tmp "playwright.lock"
$fails = 0
function Assert([bool]$cond, [string]$name) {
    if ($cond) { Write-Output "PASS  $name" }
    else { Write-Output "FAIL  $name"; $script:fails++ }
}

try {
    # 1. Acquire writes the full runId/owner/PID/phase/started/heartbeat record.
    $l = Acquire-PlaywrightLock -Path $lp
    Assert ((Test-Path $lp)) "acquire creates the lock file"
    $ev = Get-PlaywrightLockEvidence -Path $lp
    Assert ($ev.RunId -eq $l.RunId) "record carries our runId (owner token)"
    Assert ($ev.Pid -eq $PID) "record carries our PID"
    Assert ($ev.Phase -eq "test") "record carries phase"
    Assert ($ev.Started -ne "" -and $ev.Heartbeat -ne "") "record carries started + heartbeat"
    Assert ($ev.Alive -eq $true) "self holder reads as LIVE"

    # 2. Second acquire fails while the handle is held (atomic CreateNew).
    $threw = $false
    try { $l2 = Acquire-PlaywrightLock -Path $lp }
    catch [System.IO.IOException] {
        if ($_.Exception.HResult -ne -2147024816) { throw }  # must be ERROR_FILE_EXISTS
        $threw = $true
    }
    Assert $threw "second acquire fails while the lock is held"

    # 3. A live holder's lock cannot be deleted out from under it.
    $delThrew = $false
    try { Remove-Item -Path $lp -Force -ErrorAction Stop } catch { $delThrew = $true }
    Assert $delThrew "live lock cannot be deleted (no FileShare.Delete)"

    # 4. Heartbeat child refreshes the heartbeat field in place.
    $hb = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", (Join-Path $PSScriptRoot "playwright-lock-heartbeat.ps1"),
            "-LockPath", $lp, "-ParentPid", "$PID", "-Seconds", "1") `
        -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 3
    $ev2 = Get-PlaywrightLockEvidence -Path $lp
    Assert ($ev2.RunId -eq $l.RunId -and $ev2.Pid -eq $PID) "heartbeat rewrite preserves runId + PID"
    $beat = [DateTime]::Parse($ev2.Heartbeat, [System.Globalization.CultureInfo]::InvariantCulture)
    $started = [DateTime]::Parse($ev2.Started, [System.Globalization.CultureInfo]::InvariantCulture)
    Assert ($beat -gt $started) "heartbeat advanced past started"
    Stop-Process -Id $hb.Id -Force -ErrorAction SilentlyContinue

    # 5. Tampering: foreign content -> owner-only release REFUSES to delete.
    $tampered = Get-PlaywrightLockRecord -RunId ([guid]::NewGuid().ToString()) `
        -Owner "foreign" -PidValue 999999 -Phase "hog" `
        -Started ((Get-Date).ToString('o')) -Heartbeat ((Get-Date).ToString('o'))
    $fw = [System.IO.File]::Open($lp, [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    $fw.Write($tampered, 0, $tampered.Length); $fw.Flush(); $fw.Dispose()
    $released = Release-PlaywrightLock -Lock $l
    Assert ($released -eq $false) "release refuses when the token is no longer ours"
    $stillThere = $null
    try { $stillThere = Get-PlaywrightLockEvidence -Path $lp } catch { }
    Assert ($stillThere -ne $null -and $stillThere.Owner -eq "foreign") "foreign lock left in place untouched"

    # 6. Stale lease = provable only. A crashed holder (process gone, lock
    #    stranded) breaks WITH a printed proof; a live holder never breaks.
    $dead = Join-Path $tmp "dead-holder.ps1"
    Set-Content -Path $dead -Encoding UTF8 -Value @'
param($Path, $Mod)
Import-Module $Mod
[void](Acquire-PlaywrightLock -Path $Path)
[Environment]::Exit(0)   # dies WITHOUT releasing — handle closed by the OS
'@
    $deadProc = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", $dead, "-Path", $lp, "-Mod", $mod) `
        -WindowStyle Hidden -PassThru
    $deadProc.WaitForExit()
    $stale = Remove-PlaywrightLockStale -Path $lp
    Assert ($stale -eq $true) "dead holder's lock breaks with proof"
    Assert (-not (Test-Path $lp)) "stale lock file removed after proof"

    $live = Join-Path $tmp "live-holder.ps1"
    Set-Content -Path $live -Encoding UTF8 -Value @'
param($Path, $Mod, $RunIdFile)
Import-Module $Mod
$l = Acquire-PlaywrightLock -Path $Path
Set-Content -Path $RunIdFile -Value $l.RunId
Start-Sleep -Seconds 12
[void](Release-PlaywrightLock -Lock $l)
'@
    $rid = Join-Path $tmp "holder.runid"
    $liveProc = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", $live, "-Path", $lp, "-Mod", $mod, "-RunIdFile", $rid) `
        -WindowStyle Hidden -PassThru
    for ($i = 0; $i -lt 40 -and -not (Test-Path $lp); $i++) { Start-Sleep -Milliseconds 250 }
    $evLive = Get-PlaywrightLockEvidence -Path $lp
    Assert ($evLive -ne $null -and $evLive.Alive -eq $true) "live holder reads as LIVE"
    $broke = Remove-PlaywrightLockStale -Path $lp
    Assert ($broke -eq $false) "live holder's lock NEVER breaks (unprovable staleness)"
    Assert ((Test-Path $lp)) "live lock untouched by break attempt"
    $liveProc.Kill(); $liveProc.WaitForExit()
    Remove-Item -Path $lp -Force -ErrorAction SilentlyContinue   # test-owned temp file

    Write-Output ""
    if ($fails -eq 0) { Write-Output "LOCK PROTOCOL: ALL PASS"; exit 0 }
    Write-Output "LOCK PROTOCOL: $fails FAILURE(S)"
    exit 1
}
finally {
    Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
