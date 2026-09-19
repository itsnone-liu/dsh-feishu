# finish-phase-setup.ps1 — codex-chatgpt-web 装机收尾一键脚本
# 读 ~/.codex-chatgpt-web/config.json → 拿 controlToken/port →
# 写 CHATGPT_WEB_TOKEN 用户级环境变量 → 实测 /v1/models。
# 前提：launcher 已完成首启向导 + 已登录 ChatGPT（config.json 已生成）。
$ErrorActionPreference = 'Stop'
$cfgPath = "$env:USERPROFILE\.codex-chatgpt-web\config.json"
if (-not (Test-Path $cfgPath)) { Write-Host "config.json 不存在——launcher 向导/登录还没完成"; exit 1 }
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$token = $cfg.controlToken
$port = if ($cfg.port) { $cfg.port } else { 17841 }
$mode = $cfg.mode
if (-not $token) { Write-Host "config.json 里没有 controlToken"; exit 1 }
Write-Host "mode=$mode port=$port token=$($token.Substring(0,8))..."

# 1) 用户级环境变量（持久化，重启不丢）
[Environment]::SetEnvironmentVariable('CHATGPT_WEB_TOKEN', $token, 'User')
Write-Host "[ok] CHATGPT_WEB_TOKEN 已写入用户级环境变量"

# 2) 实测 daemon /v1/models（当前进程也注入，便于本会话直接用）
$env:CHATGPT_WEB_TOKEN = $token
try {
  $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Headers @{ authorization = "Bearer $token" } "http://127.0.0.1:$port/v1/models"
  Write-Host "[ok] /v1/models HTTP $($resp.StatusCode)"
  $json = $resp.Content | ConvertFrom-Json
  $ids = @($json.data | ForEach-Object { $_.id })
  Write-Host "models: $($ids -join ', ')"
} catch {
  Write-Host "[warn] /v1/models 探测失败: $($_.Exception.Message)"
  Write-Host "       （daemon 可能尚未随登录完成启动——登录完成后再跑一次本脚本）"
}
Write-Host "done"
