# dsh-feishu 接口草图

> **实现状态（2026-08-19）：V0.1 已完成并通过全部离线测试。**
> 代码在本仓库（`src/`），部署见 README.md。
> - `test/scenario.mjs` 27/27 —— 含 /mode（permissionPresets seam）、/model（installModelSelection
>   可变 selection）、/preset（agentPresets：历史会话→新开、空白会话→原地重组）
> - `test/scenario-real.mjs` 8/8 —— 真实 agent：create / **真实 blank-session recompose** /
>   真实模型切换 / 失败回合 / 磁盘持久化 / **跨进程 resume（保留上次模型）**
> - 待真实飞书凭据验证：`vendored` WS 握手（生产建议 `transport: sdk`）
>
> 基于 `@deepseek-ai/dsh@0.1.0-rc.7`（本机 npx 缓存实测）+ 飞书 oapi-sdk。

## 9. 与 DSH Desktop / Community Fabric 的关系（2026-08-19 调研）

调研了 [anywhere-labs/deepseek-harness-desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)
（Electron 桌面壳 + 社区插件市场 + Fabric 互操作标准草案）。结论：

- **它没有飞书桥**：全仓库无 feishu/lark 代码；其"手机远程控制"是 iOS/Android app 连
  Desktop，且尚在"即将推出"状态。与本桥**互补不竞争**：他们做本机 GUI Presentation，
  我们做聊天通道 Presentation，共用同一个 DSH Runtime。
- **RFC 0002（Runtime/Presentation/Control/Transport 分层）验证了本桥的核心决策**：
  - "插件不能依据 isRemote/hostType/Transport 分支"——本桥的 DSH 侧（driver/renderer 数据面）
    完全不知道飞书存在，只走 `ctx.agents` / session 事件 / 两个 seam；飞书特异性全部
    封在 transport/ 与 cards.js。天然对齐。
  - "短期敏感数据不得进持久化 session 结果"——ask/approval 的 pending 状态只存内存
    （InteractionManager 的 Map），session 里只有审计事件。对齐。
  - 未来若 Fabric 落地，本桥可作为现成的 Transport+Presentation 参考实现接入。
- **分发准备已做**：`package.json` 按 dsh-community-market 的 catalog schema 约定声明了
  `dsh.capabilities`（字符串已过 schema 正则校验）与 npm 元数据；待发布时补构建层
  （参考 dsh-plugin-desktop 的 tsdown+tsc 布局）。不设 `dsh.client`（本桥无浏览器组件）。
- 他们的"不魔改上游、固定版本运行官方 Harness"原则与本桥 seam-only/锁 rc.7 策略一致。


## 0. 架构修正（相对原分析的三个变化）

```
                    $DSH_HOME (~/.dsh)
                    sessions/--<workspace-slug>--/session-<uuid>
                              ▲ 共享持久层（resume 交接）
                              │
        ┌─────────────────────┴─────────────────────┐
        │                                           │
  dsh web (进程 A)                        dsh --profile feishu (进程 B)
  dsh-base + dsh-web-app                  dsh-base + dsh-feishu
  WebUI                                    │
                                          │ WS 长连接（oapi-sdk WSClient）
                                          ▼
                                     飞书（手机/群）
```

1. **飞书是 sibling profile 进程，不是挂在 web 里的插件。**
   依据：`ctx.userQuestions` 一个 context 只允许一个 provider（第二个注册直接 `DUPLICATE_PROVIDER`），web-app 已经占了这个位。所以 feishu 必须自己是一个 bundle over `dsh-base`，和 `dsh-web-app` / `dsh-headless` 平级。
2. **"同一个 Harness" 的真实含义是"同一个 session 存储"，不是双端同时驱动。**
   Agent registry 是进程内的（AsyncLocalStorage/fiber），一个 session 的 live driver 同一时刻只存在于一个进程。电脑 WebUI 干到一半 → 出门 → 飞书 `/resume` 接着干，这个没问题（session 落盘在 `~/.dsh/sessions/<workspace-slug>/`，跨进程 resume 是一等公民）；但 WebUI 和飞书**同时**驱动同一个 session 不支持。对"手机远程 vibe coding"场景够用。
3. **不需要自己造 interrupt——DSH 原生有 `steer()`。**
   `agent.steer(msg)`：排队为 waking next-step 输入，running 的 driver 在下一个 step 边界消费它。这正是"等等，不要改那个文件"的正确语义（软打断，模型在下一步就看到）。硬打断是 `agent.cancel(cause)`。

## 1. 依赖的 DSH seam（全部为公开接口）

### 1.1 Agent 生命周期 — `ctx.agents`

```ts
// 创建（新 session，绑定 workspace）
const handle = await ctx.agents.create({
  sessionId,                          // 自己 mint 的 id
  meta: {
    cwd: '/root/project/foo',         // ✅ workspace 绑定就靠这个
    agentPreset: 'minimal',           // 用户当前用的极简 preset
  },
  agentOptions: {
    provider: 'glm-coding',           // settings.yaml 里已配好
    model: 'glm-5.3',
  },
  setup(agentCtx) { /* 可选：scoped 注册 */ },
});
// AgentHandle = { agent, dispose() } —— dispose 是能力，只有创建者持有

// 恢复（跨进程/跨端交接）
const handle = await ctx.agents.resume({
  resumeSessionId,                    // 从绑定表查到的 session-<uuid>
  agentOptions: { provider: 'glm-coding', model: 'glm-5.3' },
});
```

### 1.2 驱动面 — `Agent` 接口

```ts
agent.followup(message)   // 普通 next-turn 消息（idle 时唤醒开新 turn）
agent.steer(message)      // ⭐ next-step 转向：running 时下一步就消费；idle 时立即开 turn
agent.inject(message)     // 非唤醒的 next-step 上下文
agent.cancel(cause, { keepInbox? })  // 硬停当前 turn；keepInbox 保住排队消息
agent.whenIdle()          // quiescence —— 卡片 finalize 的信号
agent.status              // 'idle' | 'running'
agent.inbox               // pending 消息投影（append/remove/clear...）
```

### 1.3 事件流（卡片渲染的数据源）——✅ 已实测（rc.7，2026-08-19）

dsh-session README 明确：turn/step 边界和 token 流是**持久 session 事件**，不是 agent/* 通知。
进程内直接订阅 cordis 事件：

```ts
ctx.on('session/event', ({ session, event }) => { ... })   // payload 形状见下，与磁盘事件一致
```

磁盘事件形状已用 `test/dump-session-events.mjs` 对本机 7 个真实 session 录制验证
（最大 78k 事件解码零错误、seq 零断点）。renderer 关心的精确形状：

```ts
// 信封: { type, seq, time, data?, sourceEventSeqs?, surfaceOp? }，seq 连续 events[i].seq === i
turn/start   { turn }
turn/end     { turn, reason: { kind: 'completed' | ... } }        // 卡片 finalize 信号
step/start   { turn, step }
step/end     { turn, step }

// 流式块: data.chunk.type ∈
//   'block-start' { index, blockType: 'reasoning' | 'text' | 'tool-call' }   ← 开块
//   'reasoning-delta' | 'text-delta' | 'tool-call-delta' { index, text }     ← 增量
//   'finish' { reason, replayState }                                        ← 收尾
assistant/chunk { turn, step, chunk }

// 整消息落定（每 step 一条，含 token 用量 —— V0.2 的 usage 显示直接用它）
assistant/message { turn, step, message: { role:'assistant', content:[reasoning|text|tool-call...] },
                    usage: { inputTokens, outputTokens, cacheReadTokens? },
                    sourceEventSeqs: number[] }   // 回指 chunk 流，可校验

tool/call    { turn, step, callId, name, arguments }              // arguments 是 JSON 字符串
tool/result  { turn, step, message: { source:{kind:'tool',callId},
              content:[{ type:'tool-result', toolCallId, content, isError }] } }

user/message { content:[{type:'text',text}], source:{kind:'user', rpcId, clientTimeZone},
               role:'user', id }   // source.kind 区分真人输入 vs 合成注入；feishu 桥可在此盖 channel 章

// 会话级（一次性事实）
permission/preset { preset:'workspace-write' }   sandbox/mode { mode }   approval/policy { policy:'ask' }
agent-preset/selected { agentPreset }   request/context { provider, model, contextWindow }
session/title { title, messageSeqs, source:{kind:'fallback'|'user'} }
```

存储层补充（对 `/resume` 列表有用）：
- 磁盘 = `~/.dsh/sessions/--<cwd规范化>--/<session-id>/session.jsonl.zstd`，**独立 zstd 帧拼接 + JSONL**
  （Node 22 的 `zlib.zstd` 只解单帧，读多帧文件要走 `zstdcat`；DSH 自己用 Node 内置流式 API）
- 首行 `SessionHeader`（含 cwd/createdAt/agentPreset/**parentSession/seedLength**——fork 血缘）；
  `list` 只读 header 帧，`/sessions` 命令可以很便宜
- 连续 ≥3 个同类 chunk 会被 packed 成 `text-chunks`/`reasoning-chunks`/`tool-call-chunks` 行
  （`{seq0,time0,data:{dt[],texts[]}}`），读侧 `decodeStorageRecord` 无损还原——**读盘必须解码，写盘不用管**

完整事件词汇表见包内 `KNOWN_SESSION_EVENT_TYPES`（还含 approval/asked·decided、compaction/*、todo/write、
command/run·done 等，feishu V0.2+ 逐个接）。

### 1.4 ask-user — `ctx.userQuestions`

```ts
ctx.userQuestions.registerProvider({
  async ask(request) {
    // request: { questions: [{ id, question, detail?, header?, options?, multiSelect?, intent? }], agent?, signal? }
    // → 发飞书交互卡片（按钮 = options）
    // → 用户点按钮/回复文本 → resolve
    return { answers: [{ id, selected: ['...'], custom: '...' }] };
    // 单选: custom 覆盖 selected；跳过: { id, selected: [] }
  },
});
// request.signal 在 turn 被 cancel 时会 abort —— 卡片要同步置为"已失效"
// intent.kind === 'plan-review' 时渲染成 批准/拒绝 两键（approve 字段指定批准项 label）
```

### 1.5 审批 — `ctx.approval`（✅ 实测发现，rc.7）

dump 里每个 session 开头都有 `approval/policy { policy: 'ask' }`。对应 `dsh-user-approval` 包：
channel-neutral 的一次性审批 seam，`ctx.approval.request(req)` 返回
`allowed-once | rejected | cancelled | unavailable`。

- 应答方是 **`approval/request` waterfall 监听器**（不是 provider 注册制，与 userQuestions 不同），
  官方建议"每个部署一个 terminal answerer"
- **无人应答时 fail closed**（→ 拒绝），不会挂死——比 ask-user 优雅
- 沙箱 bash 的升级重试也走这个 seam；审计落 `approval/asked` / `approval/decided` 事件

feishu 桥要注册一个 answerer：审批请求 → 卡片两键（允许一次/拒绝）。V0.1 可以先不注册
（fail-closed 语义下 agent 只是收到拒绝、继续干别的），但 **V0.1 必须显式决策**：要么注册 answerer，
要么把 approval policy 设为 `never`（`setApprovalPolicy()`），不能假装它不存在。

## 2. 飞书侧

- **收消息**：`@larksuiteoapi/node-sdk` 的 `WSClient` 长连接订阅 `im.message.receive_v1`。无需公网 IP/域名，家宽/内网机器直接跑。
- **发消息**：流式卡片——先 create 占位卡片，再节流 patch（500ms~1s 一次，且对 `assistant/chunk` 做增量合并）。⚠ 卡片 patch 频控实测后定节流值；超长输出转文件/分段。
- **交互回调**：卡片按钮 action → 路由到 pending 的 ask promise 或命令处理。
- **SDK 选择**：oapi-sdk（官方）就够了。原分析里"官方独立 Channel SDK 自带 chatQueue/dedup"未在本机可验证范围内，**按不存在设计**；queue/dedup 我们自己在 bridge 层做（本来也不复杂：chat_id 串行 + message_id 去重表）。

## 3. Bridge 核心（本仓库要写的全部东西）

```
feishu-transport        飞书 WS 收发、卡片渲染/节流、按钮回调
      ↓ 归一化消息 { chatId, openId, messageId, text, ts }
ChatRouter              chat_id ↔ { sessionId, cwd } 绑定表 + 消息去重 + 每聊天串行
      ↓
SessionDriver           ctx.agents 封装：create/resume/steer/followup/cancel/whenIdle
      ↓ session/event 流
CardRenderer            事件 → 卡片状态机（见 §4）
      +
AskProvider             userQuestions provider（卡片按钮 → answer）
      +
Commands                /new /stop /resume /sessions /cwd /model
```

### 3.1 消息路由策略（解决"连续发消息"）

```
收到消息且 chat 绑定的 agent.status === 'running'
   ├─ 首条            → agent.steer(msg)      # 软打断，下一步就看到
   ├─ 后续 <N 秒内    → 合并进同一 steer 批次（可配）
   └─ /stop           → agent.cancel('user', { keepInbox: true })

agent.status === 'idle'
   └─ agent.followup(msg)                     # 正常新 turn
```

### 3.2 绑定表

`~/.dsh/feishu/bindings.json`（V0.1 json 即可，并发多了再换 sqlite）：

```json
{
  "chat_oc_xxx": { "sessionId": "session-<uuid>", "cwd": "/root/project/foo" },
  "chat_oc_yyy": { "sessionId": null, "cwd": "/root/project/bar" }
}
```

- 新 chat 首条消息 → `ctx.agents.create`（cwd 来自 chat 绑定或默认 workspace）→ 绑定 sessionId
- `/new` → create 新 session，更新绑定；旧 session 留在盘上
- `/resume` / `/switch <id>` → `ctx.agents.resume`
- 记忆 = DSH session 本身；飞书侧零记忆逻辑 ✅

## 4. 事件 → 卡片状态机（✅ 块语义已实测）

```
turn/start          → 建卡片（状态: ● 工作中，turn N）
step/start          → 开新 step section（步骤计数）
assistant/chunk:
  chunk.type === 'block-start'
     blockType='reasoning' → 开折叠区（默认收起）
     blockType='text'      → 开正文区
     blockType='tool-call' → 累积工具参数（arguments 是流式 JSON 片段）
  '*-delta'          → 按 index 追加到对应块 buffer，节流 patch（500ms~1s）
  'finish'           → 本步流结束（落定由随后的 assistant/message 事件确认）
assistant/message   → 权威快照：直接用它整段覆盖本 step 渲染（比拼 delta 更稳），usage 记 token
tool/call           → 工具行（🔧 name + arguments 摘要；bash 显示 command 首行）
tool/result         → 该行 ✅/❌ + 耗时；content 超长折叠
step/end            → section 收尾
多步满 N / 卡片满   → 滚新卡片续写（旧卡 finalize）
turn/end            → 终态: reason.kind==='completed' → ✓ 完成；否则显示原因；停节流；附 usage 合计
ask(question)       → 卡片插入交互按钮区，置 pending
ask resolved        → 按钮区更新为已选答案
approval/request    → 两键卡片（允许一次/拒绝）——§1.5
turn cancelled      → 卡片置"已停止"；进行中的 ask/approval 卡片置灰（signal abort）
```

> 渲染优先级：**流式期用 delta 拼，落定后以 `assistant/message` 为准覆盖**——delta 乱序/重复
> 都会被快照纠正，卡片不会永久残留错字。

## 5. 安全（V0.1 硬门槛）

- `~/.dsh/feishu/config.yaml`：`allowedOpenIds: []` 白名单，不在表内一律丢弃且不回显（不暴露机器人存在）
- 默认只处理私聊（p2p chat）；群聊 V0.2 再开，开时强制 @ 触发
- cwd 白名单：绑定表的 cwd 必须在 `allowedWorkspaces` 列表内，`/cwd` 不允许指到表外路径
- 机器本身已有 sandbox 工具链（dsh-base 的 bash-sandbox/policy 行照常生效），不动它
- app_id/secret 走环境变量，不进 git

## 6. 里程碑

**V0.1（先跑通闭环）**
1. `dsh --profile feishu` 起 bundle over dsh-base（抄 dsh-headless 的 profile 结构，去掉 webserver/browser 行）
2. WS 收私聊文本（白名单过滤）
3. ChatRouter + bindings.json + create/resume
4. 流式文本卡片（assistant/chunk → 节流 patch；assistant/message 快照落定）+ turn/end finalize
5. `steer`（running 时连发）+ `/stop`（cancel）+ `/new`
6. `userQuestions` provider：options → 按钮卡片，signal abort → 卡片失效
7. approval 显式决策（answerer 卡片 或 policy=never）
8. 锁死 `0.1.0-rc.7`，只用 §1 列的 seam

**V0.2**：tool 卡片精修、群聊 @、图片/文件消息、`/switch` 会话列表、多 workspace 切换、token 用量显示

**V0.3**：批注/diff 卡片（若 DSH 出 diff seam）、长输出转飞书文件

## 7. 风险与开放问题

| 风险 | 对策 |
|---|---|
| rc.7 → 后续版本 breaking（官方明示会有） | 锁版本；seam-only；升级单列 PR |
| ~~session/event payload 形状未核对~~ | ✅ 已录制（dump 脚本 + §1.3；78k 事件零错误） |
| 飞书卡片 patch 频控 | 节流 + 超限退避；实测后定常数 |
| 卡片单卡容量上限 | 超长转新卡/文件，折叠工具输出 |
| ask 无响应挂死 | 卡片带"跳过"按钮；可选超时返回 `{ selected: [] }` |
| 双进程同时 resume 同一 session | V0.1 直接不管（自己一个人用）；V0.2 加文件锁 |
| steer 语义在 GLM-5.3 上的实际效果（模型是否听话） | 上线后实测；不听话就退化为 cancel+followup |
| `ctx.on('session/event')` 进程内订阅的精确签名 | dump 录的是磁盘事实；live 订阅写 V0.1 第 4 步时用 console 先验一遍 |

## 8. 目录草图

```
dsh-feishu/
  cordis.patch.yml        # over dsh-base：去 web 行，挂 feishu-transport/bridge 插件行
  src/
    index.ts              # feishu-runtime 插件（对齐 web-runtime 的位置）
    startup.ts            # --profile feishu 启动参数/环境变量解析
    transport/            # WSClient、卡片 API、节流器
    router.ts             # ChatRouter + bindings
    driver.ts             # SessionDriver（ctx.agents 封装）
    renderer.ts           # 事件→卡片状态机
    ask.ts                # userQuestions provider
    commands.ts           # /new /stop /resume ...
  test/
    dump-session-events.mjs   # ✅ 已完成并验证（rc.7 / 本机 7 sessions / 78k 事件零错误）
                             #   用法见文件头注释；概览 / 直方图 / 形状样本 / --type --full --raw --json
```
