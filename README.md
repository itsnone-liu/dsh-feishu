# dsh-feishu

飞书/Lark ↔ DeepSeek Harness (DSH) 桥。DSH 的第三个 surface（与 `web`/`headless` 平级的 profile）：
手机飞书直接驱动你机器上的 Harness，共享同一份持久 session 存储。

```
手机飞书 ⇄ (WS 长连接) ⇄ dsh --profile feishu ⇄ dsh-base ⇄ GLM/DeepSeek
                              │
                              └─ ~/.dsh/sessions/…  ← 与 dsh web 共享，跨端 resume
```

**桥零记忆**：chat_id ↔ session 的绑定表是它唯一的路由状态；对话历史、compaction、
resume 全部由 DSH session 层拥有。

## 功能（V0.3，已实现）

- 私聊文本 → agent；**运行中发消息 = steer**（下一步转向输入，"等等别改那个文件"）
- **识图（两条路，推荐工具路）**：
  - **`inspect_image` 工具路（V0.3 新增，默认启用）**：主模型保持 glm-5.3，agent 自动调
    `inspect_image(file, question)` 外挂 coding 端点 glm-4.5v 识图，文字回答直接回上下文——
    无需切模型、无需重发图（设计参考 dsh-tool-vision，见 `docs/VISION-PLAN.md`）；
  - **原生模型路（V0.2 保留）**：发图 → 附件服务持久化 → image 块直达模型；文本模型下发图收到
    带一键切换按钮的卡片（如 `glm-4.5v`）。飞书侧需「im:resource」权限；入参上限 8192px / 10MB。
    **连发多张图自动合并为一个回合**（`imageBatchMs` 窗口，默认 1.5s，紧随的文本=说明文字）。
- **文件消息**：非图片文件落盘 `<cwd>/.feishu-files/<时间戳>-<名>`（≤10MB，文件名清洗防穿越），
  agent 收到路径说明——文本模型即可用，与识图解耦
- **群聊 @ 触发**：`groups` 三档 `off`（默认，仅私聊）/`mention`（群内 @机器人 的文本）/
  `all`（全部消息，白名单仍生效）；机器人身份经 `GET /bot/v3/info` 解析，失败 fail-closed
- **长输出转文件**：回复超过 `cardTextLimit` 时全文落盘 `<cwd>/.feishu-outputs/`，卡片尾注给路径
- **会话占用报错**：绑定的会话被另一端（WebUI 等）使用时给专属卡片，不再静默开新会话
- **进程生存加固（V0.3）**：session/event 渲染异常隔离（dsh 的 append 同步调监听器，旧代码一处
  抛错即进程死亡）；卡片更新失败有界退避重试 + 连续失败换发新卡；卡片元素上限折叠；
  桥自身持久日志 `$DSH_HOME/feishu/bridge.log`（5MB 轮转）；进程异常钩子落盘。
  详见 `docs/INCIDENT-2026-08-23.md`
- **自杀式重启防护（V0.3）**：tools guard 拦截"杀掉本桥进程"的 shell 命令（2026-08-23 14:43 事故
  根因——agent Stop-Process 自己的宿主，重启链随宿主死亡，桥停机 56 分钟）；新增 **`/restart`**
  经 schtasks 计划任务在进程外安全重启，绑定与持久会话可接续；终端手动重启用
  `scripts/restart-bridge.ps1`
- **`/doctor` 诊断**：传输模式、群聊模式、当前模型识图能力、识图模型清单、附件服务探针（1×1 PNG 实测）
- 一个 turn 一张**流式卡片**：思考摘要 / 正文 / 工具行（✅❌ + 结果预览）/ token 用量 / 耗时
- `ask_user_question` → 按钮卡片（点按钮或直接回文字均可），回合取消自动失效
- 工具审批 → 允许一次 / 拒绝 两键卡片（fail-closed）
- `/new /stop /status /doctor /mode /sessions /resume /cwd /help`
- **`/mode` 权限模式切换**：`/mode` 查看，`/mode ro|rw|full` 切换（read-only / workspace-write / danger-full-access），
  走官方 `ctx.permissionPresets`——一次切换联动 sandbox + 审批策略并落审计事件，下一回合对模型生效
- **`/model` 模型切换**：`/model` 列出各厂商模型（📷 标识图），`/model glm-5.3`（唯一时）或 `/model glm-coding/glm-5.3`；
  走 `installModelSelection` 可变 selection——下一回合路由切换并落 `request/header(change)`；resume 会保留上次模型
- **`/preset` 预设切换**：`/preset` 列出 minimal/standard/code/cordis（含自建预设）；空白会话原地
  `recompose()`（工具/提示词即刻更换），有历史的会话自动以新预设开新会话（历史锁定是官方防 replay 设计）
- open_id 白名单（fail-closed，静默丢弃）+ 工作区白名单
- 事件渲染以 `assistant/message` 权威快照落定——流式抖动不会留错字

### Research 接口（Codex 交付）

`research/BRIEF.md` 是外部调研的自包含任务书；交付 JSON 按 `research/schema/*.schema.json` 校验后
由 `tools/apply-research.mjs` 接入（`--check` 仅校验 / `--dry` 预览）：
R1 视觉模型规格 → `settings.yaml` 模型行；R2 飞书能力 → `research/out/applied.json` 参数快照
（卡片限速校准、文件上传、群聊回复策略）。冲突项只提示，不自动覆盖。

## 安装（离线，无需 pnpm/网络）

```sh
cd dsh-feishu
./scripts/setup-profile.sh          # 安装到 ~/.dsh/profiles/feishu（symlink 方式）
```

## 飞书侧配置（一次性）

1. [开放平台](https://open.feishu.cn) → 创建企业自建应用
2. 添加「机器人」能力
3. 权限：`im:message`（收）、`im:message:send_as_bot`（发）
4. 事件订阅：选择 **长连接（WebSocket）模式**，订阅 `im.message.receive_v1` 与 `card.action.trigger`
5. 拿到 App ID / App Secret

## 运行

```sh
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx
dsh --profile feishu
```

先给机器人发条消息，看日志里的：

```
[feishu][warn] dropping message from unknown open_id ou_xxx …
```

把 `ou_xxx` 填进 `~/.dsh/feishu/config.json` 的 `allowedOpenIds`，重启即可。

## 配置（`~/.dsh/feishu/config.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| `allowedOpenIds` | `[]` | **硬门槛**：只处理这些 open_id，其余静默丢弃 |
| `defaultCwd` | — | 新 chat 的默认工作区 |
| `allowedWorkspaces` | `[defaultCwd]` | 工作区白名单（含子目录） |
| `agentPreset` | `minimal` | 新 session 的 preset |
| `provider` / `model` | 空=DSH 默认 | 模型覆盖（如 glm-coding/glm-5.3） |
| `approval` | `cards` | `cards`=按钮审批；`never`=自动拒绝 |
| `throttleMs` | `900` | 卡片节流（也是频控保护） |
| `askTimeoutMs` | `0` | 提问超时（0=永久等） |
| `transport` | `auto` | `sdk`/`vendored`/`mock`；auto=有官方 SDK 用之 |
| `vision` | `null`(=默认启用) | `inspect_image` 识图工具配置；`false` 关闭（见 `docs/VISION-PLAN.md`） |
| `logFile` | `$DSH_HOME/feishu/bridge.log` | 桥自身持久日志（5MB 轮转）；`none` 关闭 |
| `restartLauncher` | 自动探测 | `/restart` 使用的启动脚本绝对路径 |
| `cardRetryBaseMs` | `1000` | 卡片更新失败退避基数（指数退避至 15×） |

环境变量：`FEISHU_APP_ID` `FEISHU_APP_SECRET`（密钥只走环境）；
`DSH_FEISHU_LOG=debug`；`FEISHU_API_BASE`（Lark 海外版 `https://open.larksuite.com`）。

> ⚠️ 生产启动脚本（`start_bridge.ps1` / `.bat`）里如内联了密钥，注意文件权限；推荐改为只读环境。

## Transport 说明

- **`sdk`（生产推荐）**：`dsh plugin --profile feishu add @larksuiteoapi/node-sdk`
  装官方 SDK 后自动启用（WS 长连接协议由官方维护）。
- **`vendored`**：零依赖自带实现（REST 部分为稳定公开 API；WS 握手细节是尽力还原，
  若飞书侧协议变化只需修 `src/transport/lark.js` 一个文件）。
- **`mock`**：无凭据本地 REPL/测试用。

## 测试

```sh
node test/scenario.mjs             # 16 断言：mock agent 全链路（流式卡/ask/审批/steer/stop/命令/白名单/持久化）
node test/scenario-real.mjs        # 6 断言：真实 agent（创建/失败回合/磁盘持久化/跨进程 resume）
node test/hardening.test.mjs       # 8 断言：稀疏块渲染/卡片失败退避/杀宿主拦截/inspect_image（mock fetch）
node test/replay-render.mjs        # 真实会话日志全量回放（95,877 事件无异常）；REPLAY_FAIL_SEND=1 注入卡片失败
node tools/decode-session.mjs <session.jsonl.zstd> [out.jsonl]   # 纯 Node 解码 DSH 会话日志（无 zstdcat 依赖）
powershell -File test/image-mode.ps1  # e2e：21 断言，真实 dsh + mock transport（识图/拒图切换/文件/群聊/长输出）
```

## 安全模型

- 白名单外的 open_id：**静默丢弃**（不回执，不暴露机器人存在）
- 默认仅私聊；群聊需显式开 `allowGroupChats`（V0.2 会加 @ 触发）
- `/cwd` 与 session 绑定都受 `allowedWorkspaces` 约束
- 沙箱/权限沿用 dsh-base（`DSH_PERMISSION_MODE` 控制沙箱与审批默认）
- 本进程是唯一 userQuestions provider——所以它必须是独立 profile，不能与 `dsh web` 同进程

## 已知限制（V0.4 候选）

- WebUI 与飞书**同时**驱动同一 session 不支持（live driver 单进程单属）；被占用时会收到
  专属提示卡。
- 卡片更新限速参数与文件上传为保守实现（飞书文件上传待 research R2 接入后升级）。
- 识图不支持表情包与合并转发消息内的图片（飞书资源接口限制）。
- `vendored` WS 协议未经真实凭据验证（优先用 `sdk`）。
- `inspect_image` 单图调用；多图对比（`files[]`）与像素预算 downscale 待需要时加。
- `/restart` 依赖 schtasks（Windows）；跨平台需 systemd/launchd 等价物。

## 与 DSH Desktop 的关系

[anywhere-labs/deepseek-harness-desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)
是社区桌面客户端（Electron 壳 + 插件市场），**不含飞书桥**；其手机远程（iOS/Android 连桌面）
尚在开发中。本桥与它互补：同一 DSH Runtime 的不同 Presentation。
`package.json` 已按其市场 catalog schema 约定声明 capabilities，未来可经其插件市场分发。
详见 SKETCH.md §9。

