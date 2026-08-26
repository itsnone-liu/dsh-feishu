# restart-bridge.ps1 - manual safe restart of the dsh-feishu bridge (run OUTSIDE the bridge process!)
#
# Usage (system terminal):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restart-bridge.ps1 [-Launcher <path>]
#
# Behavior: waits for the old `--profile feishu` node process to exit (max 15s,
# force-kills it if stuck), then starts the new bridge. Everything is logged.
#
# NEVER run this from inside the bridge process (e.g. have the agent run it):
# the 2026-08-23 14:43 incident was exactly an agent Stop-Process'ing its own
# host - the follow-up start died with the host and the bridge was down 56
# minutes. In-process, use the feishu /restart command instead.
#
# 2026-08-26: the final launch no longer spawns the bridge from THIS process
# tree. If this script happens to run inside a scheduled-task job, Task
# Scheduler kills every process in the job when the task's root powershell
# exits (10:08 incident: new bridge pid=14524 killed silently, 14 min outage).
# We now start the dedicated bridge task `dsh-feishu-bridge` (the bridge is
# its root process, no time limit) and only fall back to a direct launch when
# run_bridge.ps1 is missing.
#
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 + BOM-less file =
# system-codepage reads; non-ASCII comments get mangled, see .nobom.bak saga).
param(
  [string]$Launcher = 'D:\dsh-install\start_bridge.ps1'
)
$ErrorActionPreference = 'Continue'
$log = Join-Path $env:DSH_HOME 'feishu\restart.log'
if (-not $env:DSH_HOME) { $log = "$env:USERPROFILE\.dsh\feishu\restart.log" }
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

"manual restart $(Get-Date -Format o) launcher=$Launcher" | Add-Content -Path $log -Encoding UTF8
$victims = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'profile feishu' })
foreach ($v in $victims) {
  "stopping old bridge pid=$($v.ProcessId)" | Add-Content -Path $log -Encoding UTF8
  Stop-Process -Id $v.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep 2
$runBridge = Join-Path (Split-Path -Parent $Launcher) 'run_bridge.ps1'
if (Test-Path $runBridge) {
  Register-ScheduledTask -TaskName 'dsh-feishu-bridge' -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $runBridge + '"') -WorkingDirectory (Split-Path -Parent $runBridge)) -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable) -Force | Out-Null
  schtasks /Run /TN dsh-feishu-bridge | Add-Content -Path $log -Encoding UTF8
} else {
  "WARNING: $runBridge not found; falling back to direct launch (job-kill risk if run inside a scheduled task)" | Add-Content -Path $log -Encoding UTF8
  & $Launcher *>&1 | Add-Content -Path $log -Encoding UTF8
}
"manual restart finished $(Get-Date -Format o)" | Add-Content -Path $log -Encoding UTF8
Get-Content $log -Tail 5
