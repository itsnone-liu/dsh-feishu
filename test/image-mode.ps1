# dsh-feishu 识图模式离线端到端测试（Windows）
# 真实启动 dsh --profile feishu（junction 到真实 profiles），mock 传输 + mock agent，
# 脚本发一条图片消息 + /model，验证：
#   1) 图片经嗅探→准入→持久化→image 块提交（卡片出现 "附图 1 张"）
#   2) /model 列表出现带 📷 的 glm-4.5v
#   3) sandbox attachments/v1 落盘
$ErrorActionPreference = 'Stop'
$node = 'D:\qjcNetDiskDownload\nodejs\node.exe'
$bin = 'D:\dsh-install\node_modules\@deepseek-ai\dsh\lib\bin.js'

$sandbox = Join-Path `C:\Users\pc\AppData\Local\Temp ("dsh-feishu-imgtest-" + [guid]::NewGuid().ToString('N').Substring(0,8))
$homeDir = Join-Path $sandbox 'home'
$ws = Join-Path $sandbox 'ws'
New-Item -ItemType Directory -Force -Path $homeDir, $ws | Out-Null

# profiles → 真实目录（junction，只读使用）
New-Item -ItemType Junction -Path (Join-Path $homeDir 'profiles') -Target 'C:\Users\pc\.dsh\profiles' | Out-Null
# settings.yaml 复制（含 glm-4.5v/4.6v 视觉模型声明）
Copy-Item 'C:\Users\pc\.dsh\settings.yaml' (Join-Path $homeDir 'settings.yaml')

# bridge 沙箱配置
New-Item -ItemType Directory -Force -Path (Join-Path $homeDir 'feishu') | Out-Null
@{
  transport = 'mock'
  mockAgent = $true
  allowedOpenIds = @('ou_mock_me')
  defaultCwd = $ws
  allowedWorkspaces = @($ws)
  agentPreset = 'minimal'
  approval = 'cards'
  throttleMs = 40
  askTimeoutMs = 0
} | ConvertTo-Json | ForEach-Object { [IO.File]::WriteAllText((Join-Path (Join-Path $homeDir 'feishu') 'config.json'), $_, [Text.UTF8Encoding]::new($false)) }

# 测试图片（复制到工作区）
$img = Join-Path $ws 'test-image.png'
Copy-Item 'C:\Users\pc\预览.png' $img

# mock 脚本
$scriptPath = Join-Path $sandbox 'script.json'
@(
  @{ text = '你好，桥通了吗' },
  @{ wait = 800 },
  @{ image = $img; text = '这张图里是什么' },
  @{ wait = 1800 },
  @{ text = '/model' },
  @{ wait = 1200 }
) | ConvertTo-Json -Depth 4 | ForEach-Object { [IO.File]::WriteAllText($scriptPath, $_, [Text.UTF8Encoding]::new($false)) }

$out = Join-Path $sandbox 'out.json'
$stdoutFile = Join-Path $sandbox 'bridge.out.log'
$stderrFile = Join-Path $sandbox 'bridge.err.log'
$env2 = @{
  DSH_HOME = $homeDir
  DSH_FEISHU_SCRIPT = $scriptPath
  DSH_FEISHU_OUT = $out
  DSH_FEISHU_LOG = 'info'
  GLM_API_KEY = 'test-key-not-used'
  FEISHU_APP_ID = 'cli_test'
  FEISHU_APP_SECRET = 'test'
}
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $node
$psi.Arguments = "`"$bin`" --profile feishu"
$psi.WorkingDirectory = 'D:\dsh-install'
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $false
$psi.RedirectStandardError = $false
foreach ($k in $env2.Keys) { $psi.EnvironmentVariables[$k] = $env2[$k] }
# stdout/stderr → 文件（避免 ReadToEnd 死锁）
$psi.EnvironmentVariables['DSH_TEST_STDOUT'] = '1'
$p = [System.Diagnostics.Process]::Start($psi)
Write-Host "PID=$($p.Id)"

# 轮询 out.json（脚本完成时 mock 写出并自动退出）
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline -and -not (Test-Path $out)) {
  Start-Sleep -Milliseconds 500
  if ($p.HasExited) { break }
}
Start-Sleep -Seconds 1
if (-not $p.HasExited) {
  Write-Host '（进程未自动退出，终止之）'
  try { $p.Kill() } catch {}
}
$stdout = ''
$stderr = ''

$pass = 0; $fail = 0
if (-not (Test-Path $out)) { Write-Host 'FAIL: out.json 未生成'; exit 1 }
$cards = [IO.File]::ReadAllText($out, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
$allText = ($cards | ConvertTo-Json -Depth 20 -Compress)

foreach ($check in @(
  @{ name = '图片消息走完 agent 回合（附图 1 张）'; pat = '附图 1 张' },
  @{ name = '/model 列表出现 glm-4.5v'; pat = 'glm-4\.5v' },
  @{ name = '/model 列表带 📷 标记'; pat = '📷' }
)) {
  if ($allText -match $check.pat) { Write-Host "PASS: $($check.name)"; $pass++ }
  else { Write-Host "FAIL: $($check.name)"; $fail++ }
}

$attDir = Get-ChildItem (Join-Path $homeDir 'attachments') -Recurse -File -ErrorAction SilentlyContinue
if ($attDir) { Write-Host "PASS: 附件已持久化（$($attDir.Count) 个文件）"; $pass++ }
else { Write-Host 'FAIL: attachments/v1 下没有文件'; $fail++ }

Write-Host ""
Write-Host "结果：$pass 通过 / $fail 失败  （沙箱：$sandbox）"
exit ($(if ($fail -gt 0) { 1 } else { 0 }))
