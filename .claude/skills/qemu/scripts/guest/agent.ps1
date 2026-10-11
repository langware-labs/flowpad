# vmagent: polls the Mac job queue (rig/vmq_server.py on host 127.0.0.1:8766 = 10.0.2.2 from the guest).
# Every job runs in a FRESH powershell process, so env set by one job never leaks into the next.
param([string]$Lane = 'user', [string]$Q = 'http://10.0.2.2:8766')
$ProgressPreference = 'SilentlyContinue'
$dir = "C:\vmagent\jobs"; New-Item -ItemType Directory -Force $dir | Out-Null
while ($true) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing "$Q/next?lane=$Lane" -TimeoutSec 40
    if ($r.StatusCode -ne 200) { continue }
    $job = $r.Content | ConvertFrom-Json
    $f = "$dir\$($job.id).ps1"; $o = "$dir\$($job.id).out"; $e = "$dir\$($job.id).err"
    [IO.File]::WriteAllText($f, $job.cmd, (New-Object Text.UTF8Encoding $true))
    $p = Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$f`"" `
         -RedirectStandardOutput $o -RedirectStandardError $e -WindowStyle Minimized -PassThru
    $null = $p.Handle  # without this PS 5.1 never reports ExitCode
    $timedOut = -not $p.WaitForExit([int]$job.timeout * 1000)
    if ($timedOut) { & taskkill /T /F /PID $p.Id | Out-Null; $code = -1 } else { $code = $p.ExitCode }
    $out = (Get-Content $o -Raw -ErrorAction SilentlyContinue) + (Get-Content $e -Raw -ErrorAction SilentlyContinue)
    $body = @{ code = $code; timed_out = $timedOut; out = "$out" } | ConvertTo-Json -Compress
    Invoke-WebRequest -UseBasicParsing -Method Post "$Q/result/$($job.id)" -ContentType 'application/json; charset=utf-8' `
      -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30 | Out-Null
  } catch { Start-Sleep 3 }
}
