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

## 功能（V0.2，已实现）

- 私聊文本 → agent；**运行中发消息 = steer**（下一步转向输入，"等等别改那个文件"）
- **识图模式**：直接发图片 → 消息资源下载 → 魔数嗅探格式 → 附件服务持久化 → image 块提交。
  需当前模型声明图片输入（`/model` 列表带 📷 的，如 `glm-4.5v`）；文本模型下发图会收到
  **带一键切换按钮**的卡片。飞书侧需为应用添加「im:resource」（获取消息中的资源文件）权限。
  入参上限随附件服务放宽为 8192px / 10MB（profile patch 覆盖）。
  **连发多张图自动合并为一个回合**（`imageBatchMs` 窗口，默认 1.5s，紧随的文本=说明文字）。
- **文件消息**：非图片文件落盘 `<cwd>/.feishu-files/<时间戳>-<名>`（≤10MB，文件名清洗防穿越），
  agent 收到路径说明——文本模型即可用，与识图解耦
- **群聊 @ 触发**：`groups` 三档 `off`（默认，仅私聊）/`mention`（群内 @机器人 的文本）/
  `all`（全部消息，白名单仍生效）；机器人身份经 `GET /bot/v3/info` 解析，失败 fail-closed
- **长输出转文件**：回复超过 `cardTextLimit` 时全文落盘 `<cwd>/.feishu-outputs/`，卡片尾注给路径
- **会话占用报错**：绑定的会话被另一端（WebUI 等）使用时给专属卡片，不再静默开新会话
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

环境变量：`FEISHU_APP_ID` `FEISHU_APP_SECRET`（密钥只走环境）；
`DSH_FEISHU_LOG=debug`；`FEISHU_API_BASE`（Lark 海外版 `https://open.larksuite.com`）。

## Transport 说明

- **`sdk`（生产推荐）**：`dsh plugin --profile feishu add @larksuiteoapi/node-sdk`
  装官方 SDK 后自动启用（WS 长连接协议由官方维护）。
- **`vendored`**：零依赖自带实现（REST 部分为稳定公开 API；WS 握手细节是尽力还原，
  若飞书侧协议变化只需修 `src/transport/lark.js` 一个文件）。
- **`mock`**：无凭据本地 REPL/测试用。

## 测试

```sh
node test/scenario.mjs        # 16 断言：mock agent 全链路（流式卡/ask/审批/steer/stop/命令/白名单/持久化）
node test/scenario-real.mjs   # 6 断言：真实 agent（创建/失败回合/磁盘持久化/跨进程 resume）
node test/dump-session-events.mjs   # session 事件录制/检查工具
```

## 安全模型

- 白名单外的 open_id：**静默丢弃**（不回执，不暴露机器人存在）
- 默认仅私聊；群聊需显式开 `allowGroupChats`（V0.2 会加 @ 触发）
- `/cwd` 与 session 绑定都受 `allowedWorkspaces` 约束
- 沙箱/权限沿用 dsh-base（`DSH_PERMISSION_MODE` 控制沙箱与审批默认）
- 本进程是唯一 userQuestions provider——所以它必须是独立 profile，不能与 `dsh web` 同进程

## 已知限制（V0.3 路线）

- WebUI 与飞书**同时**驱动同一 session 不支持（live driver 单进程单属）；被占用时会收到
  专属提示卡。V0.3 计划加文件锁与占用提示优化。
- 卡片更新限速参数与文件上传为保守实现（飞书文件上传待 research R2 接入后升级）。
- 识图不支持表情包与合并转发消息内的图片（飞书资源接口限制）。
- `vendored` WS 协议未经真实凭据验证（优先用 `sdk`）。

## 与 DSH Desktop 的关系

[anywhere-labs/deepseek-harness-desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)
是社区桌面客户端（Electron 壳 + 插件市场），**不含飞书桥**；其手机远程（iOS/Android 连桌面）
尚在开发中。本桥与它互补：同一 DSH Runtime 的不同 Presentation。
`package.json` 已按其市场 catalog schema 约定声明 capabilities，未来可经其插件市场分发。
详见 SKETCH.md §9。

