param([int]$Id, [int]$Ms = 400)
while ($true) {
  $p = Get-Process -Id $Id -ErrorAction SilentlyContinue
  if (-not $p) { break }
  Write-Output ("{0},{1}" -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), $p.WorkingSet64)
  Start-Sleep -Milliseconds $Ms
}
