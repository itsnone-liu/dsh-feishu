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

## 功能（V0.1，已实现）

- 私聊文本 → agent；**运行中发消息 = steer**（下一步转向输入，"等等别改那个文件"）
- 一个 turn 一张**流式卡片**：思考摘要 / 正文 / 工具行（✅❌ + 结果预览）/ token 用量 / 耗时
- `ask_user_question` → 按钮卡片（点按钮或直接回文字均可），回合取消自动失效
- 工具审批 → 允许一次 / 拒绝 两键卡片（fail-closed）
- `/new /stop /status /mode /sessions /resume /cwd /help`
- **`/mode` 权限模式切换**：`/mode` 查看，`/mode ro|r w|full` 切换（read-only / workspace-write / danger-full-access），
  走官方 `ctx.permissionPresets`——一次切换联动 sandbox + 审批策略并落审计事件，下一回合对模型生效
- **`/model` 模型切换**：`/model` 列出各厂商模型，`/model glm-5.3`（唯一时）或 `/model glm-coding/glm-5.3`；
  走 `installModelSelection` 可变 selection——下一回合路由切换并落 `request/header(change)`；resume 会保留上次模型
- **`/preset` 预设切换**：`/preset` 列出 minimal/standard/code/cordis（含自建预设）；空白会话原地
  `recompose()`（工具/提示词即刻更换），有历史的会话自动以新预设开新会话（历史锁定是官方防 replay 设计）
- open_id 白名单（fail-closed，静默丢弃）+ 工作区白名单
- 事件渲染以 `assistant/message` 权威快照落定——流式抖动不会留错字

## 安装（离线，无需 pnpm/网络）

```sh
cd /root/dsh-ws/dsh-feishu
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

## 已知限制（V0.2 路线）

- WebUI 与飞书**同时**驱动同一 session 不支持（live driver 单进程单属）；一端退出/闲置后另一端
  `/resume` 接续已验证可用。V0.2 计划加文件锁与占用提示。
- 群聊、图片/文件消息、@ 触发、长输出转文件、todo/diff 卡片。
- `vendored` WS 协议未经真实凭据验证（优先用 `sdk`）。

## 与 DSH Desktop 的关系

[anywhere-labs/deepseek-harness-desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)
是社区桌面客户端（Electron 壳 + 插件市场），**不含飞书桥**；其手机远程（iOS/Android 连桌面）
尚在开发中。本桥与它互补：同一 DSH Runtime 的不同 Presentation。
`package.json` 已按其市场 catalog schema 约定声明 capabilities，未来可经其插件市场分发。
详见 SKETCH.md §9。

