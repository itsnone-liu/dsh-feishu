# dsh-feishu 离线端到端测试（Windows / PS5.1 兼容）
# 双场景真实启动 dsh --profile feishu（junction 到真实 profiles，settings 复制）：
#   A 正向：连发 2 图合并为单回合（附图 2 张）、/doctor、/model 📷 列表、附件落盘
#   B 拒绝：文本模型下发图 → 拒绝卡带切换按钮 → 点击 → 模型已切换
# 步骤里的 'IMG' 会在写入 script.json 前替换为沙箱内的真实测试图路径。
$ErrorActionPreference = 'Stop'
$node = 'D:\qjcNetDiskDownload\nodejs\node.exe'
$bin = 'D:\dsh-install\node_modules\@deepseek-ai\dsh\lib\bin.js'
$pass = 0; $fail = 0

function Run-Bridge([string]$name, [hashtable]$extraCfg, [array]$steps, [scriptblock]$checks) {
  $sandbox = Join-Path $env:TEMP ("dsh-feishu-e2e-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $homeDir = Join-Path $sandbox 'home'
  $ws = Join-Path $sandbox 'ws'
  New-Item -ItemType Directory -Force -Path $homeDir, $ws | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $homeDir 'profiles') -Target 'C:\Users\pc\.dsh\profiles' | Out-Null
  Copy-Item 'C:\Users\pc\.dsh\settings.yaml' (Join-Path $homeDir 'settings.yaml')
  New-Item -ItemType Directory -Force -Path (Join-Path $homeDir 'feishu') | Out-Null

  $cfg = @{
    transport = 'mock'; mockAgent = $true
    allowedOpenIds = @('ou_mock_me'); defaultCwd = $ws
    allowedWorkspaces = @($ws); agentPreset = 'minimal'
    approval = 'cards'; throttleMs = 40; askTimeoutMs = 0
  }
  foreach ($k in $extraCfg.Keys) { $cfg[$k] = $extraCfg[$k] }
  [IO.File]::WriteAllText(
    (Join-Path (Join-Path $homeDir 'feishu') 'config.json'),
    ($cfg | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))

  $img = Join-Path $ws 'test-image.png'
  Copy-Item 'C:\Users\pc\预览.png' $img

  $pyFile = Join-Path $ws 'sample.py'
  [IO.File]::WriteAllText($pyFile, "x = 1`nprint('hello from sample')", [Text.UTF8Encoding]::new($false))

  $imgJson = $img.Replace('\', '\\')
  $fileJson = $pyFile.Replace('\', '\\')
  $scriptJson = ($steps | ConvertTo-Json -Depth 5).Replace('"IMG"', ('"' + $imgJson + '"')).Replace('"FILE"', ('"' + $fileJson + '"'))
  $scriptPath = Join-Path $sandbox 'script.json'
  [IO.File]::WriteAllText($scriptPath, $scriptJson, [Text.UTF8Encoding]::new($false))

  $out = Join-Path $sandbox 'out.json'
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = "`"$bin`" --profile feishu"
  $psi.WorkingDirectory = 'D:\dsh-install'
  $psi.UseShellExecute = $false
  foreach ($kv in @{
    DSH_HOME = $homeDir; DSH_FEISHU_SCRIPT = $scriptPath; DSH_FEISHU_OUT = $out
    DSH_FEISHU_LOG = 'info'; GLM_API_KEY = 'unused'; FEISHU_APP_ID = 'cli_test'; FEISHU_APP_SECRET = 'test'
  }.GetEnumerator()) { $psi.EnvironmentVariables[$kv.Key] = $kv.Value }
  $p = [System.Diagnostics.Process]::Start($psi)
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline -and -not (Test-Path $out)) {
    Start-Sleep -Milliseconds 500
    if ($p.HasExited) { break }
  }
  Start-Sleep -Seconds 1
  if (-not $p.HasExited) { try { $p.Kill() } catch {} }

  if (-not (Test-Path $out)) {
    Write-Host "FAIL [$name] out.json 未生成（沙箱 $sandbox）"; $script:fail++
    return
  }
  $cards = [IO.File]::ReadAllText($out, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
  $allText = ($cards | ConvertTo-Json -Depth 20 -Compress)
  & $checks $name $cards $allText $homeDir
}

# ---------------------------------------------------------------- 场景 A
Run-Bridge 'A 正向（合并+doctor+列表）' @{} @(
  @{ text = '你好' },
  @{ wait = 600 },
  @{ image = 'IMG'; text = '看看这两张' },
  @{ image = 'IMG' },
  @{ wait = 3000 },
  @{ text = '/doctor' },
  @{ wait = 2500 },
  @{ text = '/model' },
  @{ wait = 2000 }
) {
  param($name, $cards, $allText, $homeDir)
  foreach ($c in @('附图 2 张', '诊断', '附件服务：可用', '📷', 'glm-4.5v')) {
    if ($allText.IndexOf($c) -ge 0) { Write-Host "PASS [$name] $c"; $script:pass++ }
    else { Write-Host "FAIL [$name] 缺少：$c"; $script:fail++ }
  }
  $att = @(Get-ChildItem (Join-Path $homeDir 'attachments') -Recurse -File -ErrorAction SilentlyContinue)
  if ($att.Count -ge 2) { Write-Host "PASS [$name] 附件落盘（$($att.Count) 个）"; $script:pass++ }
  else { Write-Host "FAIL [$name] 附件落盘不足（$($att.Count)）"; $script:fail++ }
}

# ---------------------------------------------------------------- 场景 B
Run-Bridge 'B 拒绝卡+一键切换' @{ mockImageGate = 'text-only' } @(
  @{ text = '你好' },
  @{ wait = 600 },
  @{ image = 'IMG' },
  @{ wait = 3000 },
  @{ click = @{ bridge = 'model'; model = 'glm-4.5v' } },
  @{ wait = 1500 }
) {
  param($name, $cards, $allText, $homeDir)
  foreach ($c in @('当前模型不支持图片输入', '切换 glm-4.5v', '模型已切换', 'glm_coding/glm-4.5v')) {
    if ($allText.IndexOf($c) -ge 0) { Write-Host "PASS [$name] $c"; $script:pass++ }
    else { Write-Host "FAIL [$name] 缺少：$c"; $script:fail++ }
  }
}

# ---------------------------------------------------------------- 场景 C
Run-Bridge 'C 文件消息' @{} @(
  @{ text = '你好' },
  @{ wait = 600 },
  @{ file = 'FILE'; text = '帮我看下这个文件' },
  @{ wait = 1500 },
  @{ text = '读一下刚才的文件内容' },
  @{ wait = 1500 }
) {
  param($name, $cards, $allText, $homeDir)
  foreach ($c in @('文件已接收', 'sample.py', '[飞书文件]', '.feishu-files')) {
    if ($allText.IndexOf($c) -ge 0) { Write-Host "PASS [$name] $c"; $script:pass++ }
    else { Write-Host "FAIL [$name] 缺少：$c"; $script:fail++ }
  }
}

# ---------------------------------------------------------------- 场景 D
Run-Bridge 'D 群聊@门控' @{ groups = 'mention' } @(
  @{ text = '你好私聊' },
  @{ wait = 600 },
  @{ text = '群里@提问'; group = $true; mentionBot = $true },
  @{ wait = 1200 },
  @{ text = 'no reply please'; group = $true },
  @{ wait = 800 },
  @{ text = 'p2p again' },
  @{ wait = 1200 }
) {
  param($name, $cards, $allText, $homeDir)
  $checks = @(
    @{ pat = '你好私聊'; want = $true; desc = '私聊正常' },
    @{ pat = '群里@提问'; want = $true; desc = '群内@触发' },
    @{ pat = 'no reply please'; want = $false; desc = '群内未@静默' },
    @{ pat = 'p2p again'; want = $true; desc = '私聊恢复' }
  )
  foreach ($c in $checks) {
    $has = $allText.IndexOf($c.pat) -ge 0
    if ($has -eq $c.want) { Write-Host "PASS [$name] $($c.desc)"; $script:pass++ }
    else { Write-Host "FAIL [$name] $($c.desc)（want=$($c.want) has=$has）"; $script:fail++ }
  }
}

Write-Host ''
Write-Host "结果：$pass 通过 / $fail 失败"
exit $(if ($fail -gt 0) { 1 } else { 0 })