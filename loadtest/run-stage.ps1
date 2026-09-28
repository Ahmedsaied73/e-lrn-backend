# run-stage.ps1 — self-contained k6 stage orchestrator (detached execution).
#
# Boots the API with LOAD_TEST=true, waits for /healthz, snapshots /metrics,
# runs the k6 scenario SYNCHRONOUSLY, snapshots again, flushes stale rl:*
# buckets, then stops the server. One detached process per stage → immune to
# parent-session teardown, and every stage gets clean since-boot metric counters.
#
# Usage (from repo root):
#   powershell -File loadtest/run-stage.ps1 -Label l0 -StageCap 1
#   powershell -File loadtest/run-stage.ps1 -Label l1 -StageCap 10
#   powershell -File loadtest/run-stage.ps1 -Label l2a -StageCap 50
#   powershell -File loadtest/run-stage.ps1 -Label l2b -StageCap 120
#   powershell -File loadtest/run-stage.ps1 -Label full            (full ramp)
#   powershell -File loadtest/run-stage.ps1 -Label login -Scenario login-surge.js
#   powershell -File loadtest/run-stage.ps1 -Label spike -Scenario spike.js
#   powershell -File loadtest/run-stage.ps1 -Label soak -Scenario soak.js
param(
  [Parameter(Mandatory=$true)][string]$Label,
  [string]$Scenario = "browse-10k.js",
  [string]$StageCap = ""
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$results = Join-Path $root "loadtest\results"
New-Item -ItemType Directory -Force $results | Out-Null
$log = Join-Path $results ("stage-" + $Label + ".log")

function Log($msg) {
  $line = "$(Get-Date -Format o) $msg"
  Add-Content -Path $log -Value $line
  Write-Output $line
}

# 0. Kill leftovers from a previous stage (server on 3005 + stray k6).
# netstat-based: Get-NetTCPConnection can MISS a listener (observed on this box).
$leftovers = netstat -ano | Select-String ':3005\s' | Select-String 'LISTENING'
foreach ($m in $leftovers) {
  $leftPid = ($m.Line.Trim() -split '\s+')[-1]
  Log "killing leftover listener PID $leftPid"
  Stop-Process -Id $leftPid -Force -ErrorAction SilentlyContinue
}
Get-Process k6 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 1. Boot server (LOAD_TEST profile + explicit pool 40), logs per stage.
$srvOut = Join-Path $results "server-$Label.log"
$srvErr = Join-Path $results "server-$Label.err.log"
$env:LOAD_TEST = "true"
$env:DATABASE_CONNECTION_LIMIT = "40"
$env:BASE_URL = "http://127.0.0.1:3005"
$server = Start-Process node -ArgumentList "app.js" -WorkingDirectory $root `
  -RedirectStandardOutput $srvOut -RedirectStandardError $srvErr -PassThru -WindowStyle Hidden
Log "server PID=$($server.Id) (LOAD_TEST=true, DATABASE_CONNECTION_LIMIT=40)"

# Ownership check: healthz passing is not enough (a stale listener can answer),
# and netstat at T+3s can also be TOO EARLY (boot takes ~10s — a missing line
# must not become a false FATAL). Poll up to 20s: wait for ANY :3005 listener,
# then require it to be OUR pid.
Start-Sleep -Seconds 3
$ownerPid = ""
for ($t = 0; $t -lt 20 -and $ownerPid -eq ""; $t++) {
  $portLines = netstat -ano | Select-String ':3005\s' | Select-String 'LISTENING'
  foreach ($m in $portLines) { $ownerPid = ($m.Line.Trim() -split '\s+')[-1] }
  if ($ownerPid -eq "") { Start-Sleep -Seconds 1 }
}
if ($ownerPid -ne "$($server.Id)") {
  Log ("FATAL port 3005 owned by PID " + $ownerPid + " (expected " + $server.Id + ") - aborting stage")
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  exit 1
}
Log "port ownership verified: PID $ownerPid"

# 2. Wait for /healthz (max 30s).
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try { $h = Invoke-RestMethod -Uri "http://127.0.0.1:3005/healthz" -TimeoutSec 3; if ($h.status -eq "ok") { $ready = $true; break } } catch {}
}
if (-not $ready) { Log "FATAL server never became healthy"; Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue; exit 1 }
Log "server healthy after $($i + 1)s"

# 3. Pre-run snapshot.
node (Join-Path $root "loadtest\lib\snapshot.js") ($Label + "-pre") 2>&1 | ForEach-Object { Log $_ }

# 4. Run k6 synchronously.
$k6Out = Join-Path $results ("k6-" + $Label + ".log")
$k6Err = Join-Path $results ("k6-" + $Label + ".err.log")
$k6Args = @("run")
if ($StageCap -ne "") { $k6Args += @("-e", "STAGE_CAP=$StageCap") }
$k6Args += (Join-Path $root "loadtest\scenarios\$Scenario")
Log "k6 start: k6 $($k6Args -join ' ')"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$k6 = Start-Process k6 -ArgumentList $k6Args -WorkingDirectory $root `
  -RedirectStandardOutput $k6Out -RedirectStandardError $k6Err -PassThru -WindowStyle Hidden
Wait-Process -Id $k6.Id -ErrorAction SilentlyContinue
$sw.Stop()
Log "k6 exit=$($k6.ExitCode) duration=$([math]::Round($sw.Elapsed.TotalMinutes,1))min"

# 5. Post-run snapshot + bucket flush (stale rl:* = phantom 429 next stage).
node (Join-Path $root "loadtest\lib\snapshot.js") ($Label + "-post") 2>&1 | ForEach-Object { Log $_ }
node (Join-Path $root "scripts\flushLoadTestBuckets.js") 2>&1 | ForEach-Object { Log $_ }

# 6. Stop the server (next stage boots fresh).
Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
Log ("stage " + $Label + " COMPLETE (k6 exit " + $k6.ExitCode + ") - server stopped")
exit $k6.ExitCode