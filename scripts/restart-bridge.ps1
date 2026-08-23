# restart-bridge.ps1 — 手动安全重启 dsh-feishu 桥（在桥进程之外运行！）
#
# 用法（系统终端）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restart-bridge.ps1 [-Launcher <path>]
#
# 行为：等待旧的 `--profile feishu` node 进程退出（最多 15s，卡住则强杀），
#       然后调用启动脚本拉起新进程。全过程写 restart 日志。
# 注意：绝不要在桥进程内部（比如让 agent 跑这条命令）重启桥 ——
#       2026-08-23 14:43 事故正是 agent Stop-Process 自己的宿主进程，
#       后续启动命令随宿主一起死亡，桥停机 56 分钟。进程内请用飞书 /restart。
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
& $Launcher *>&1 | Add-Content -Path $log -Encoding UTF8
"manual restart finished $(Get-Date -Format o)" | Add-Content -Path $log -Encoding UTF8
Get-Content $log -Tail 5
