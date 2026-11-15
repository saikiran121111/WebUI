# playwright-lock-heartbeat.ps1 — keeps the Playwright lock's heartbeat fresh
# while the exclusive launcher runs. Exits when the parent launcher PID dies,
# or when the lock file disappears (released). Fixed-width in-place rewrite
# only (see playwright-lock.psm1 layout); never creates or deletes the file.
param(
    [Parameter(Mandatory = $true)][string]$LockPath,
    [Parameter(Mandatory = $true)][int]$ParentPid,
    [int]$Seconds = 30
)
while ($true) {
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    if (-not (Test-Path -LiteralPath $LockPath)) { break }
    try {
        $beat = (Get-Date).ToString('o')
        # ReadWrite access: a Write-only FileStream throws on .Read().
        $fs = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite)
        try {
            $buf = New-Object byte[] 512
            $n = $fs.Read($buf, 0, 512)
            $text = [System.Text.Encoding]::UTF8.GetString($buf, 0, $n)
            $repl = '"heartbeat":"' + $beat + '"'
            $new = [regex]::Replace($text, '"heartbeat":"[^"]*"', $repl)
            $nb = [System.Text.Encoding]::UTF8.GetBytes($new)
            $fs.Seek(0, [System.IO.SeekOrigin]::Begin) | Out-Null
            $fs.Write($nb, 0, $nb.Length)
            $fs.Flush()
        } finally { $fs.Dispose() }
    } catch {
        # Holder released between Test-Path and Open, or transient sharing
        # clash — the loop re-checks liveness next tick. Never let a
        # heartbeat helper take down an E2E run.
    }
    Start-Sleep -Seconds $Seconds
}
