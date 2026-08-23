# dsh-feishu 外部调研方案（Codex 专用）

> 你（Codex）独立执行本方案，产出**可直接接入**的结构化调研结果。
> 你看不到发起方的对话，本文档自包含全部所需背景。

## 1. 背景

`dsh-feishu` 是一个飞书↔DSH agent 桥接插件（本仓库 `src/`），已实现私聊文本、识图（GLM 视觉模型）、流式卡片、交互问答/审批。V0.2 需要**两类外部事实**才能把参数和实现从「猜测/保守」变成「有据」：

- **R1**：GLM（智谱 bigmodel.cn）视觉模型的真实规格
- **R2**：飞书开放平台能力矩阵（权限、事件、限速、文件）

发起方并行实施其他功能，你的交付物通过 `tools/apply-research.mjs` 按 schema 校验后自动/半自动接入。

## 2. 工作边界（必须遵守）

- **只写** `research/` 目录（`research/*.json`、`research/probe-*.mjs`、`research/out/`）。不改 `src/`、`settings.yaml`、`docs/`、`test/`。
- **不安装任何依赖**：环境 Node ≥ 20，脚本只用内置模块 + 全局 `fetch`。
- **不接触任何密钥**：你没有也不需要 API key。探针脚本一律从环境变量读配置（`GLM_API_KEY`、`GLM_BASE_URL`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_OPEN_ID`），由发起方在本地带凭据执行。脚本**绝不打印密钥**。
- 结论必须**可溯源**：每个非 null 字段附 `sources`（官方文档 URL 优先；社区/Issue 次之并注明）。查不到就填 `null`——**null 是有效答案，猜测不是**。
- 与第 3 节基线冲突的发现，不修改基线描述，写入顶层 `conflictsWithBaseline`。

## 3. 发起方已验证的基线（实测，勿重复劳动，可挑战）

- 端点：coding=`https://open.bigmodel.cn/api/coding/paas/v4`，开放平台=`https://open.bigmodel.cn/api/paas/v4`（openai-compat `chat/completions`）。
- `glm-5.3`、`glm-4.7`、`glm-5-turbo` 发图 → HTTP 400 `{"code":"1210","message":"messages.content.type 参数非法，取值范围 ['text']"}`（服务端拒绝，纯文本模型）。
- `glm-4.5v`、`glm-4.6v` 在 **coding 端点**发图（base64 data URL）→ 200，中文表格截图 OCR 正确（测试图 910×1287 PNG）。
- 同一 key 在**开放平台端点**调 glm-4.5v → HTTP 429 `{"code":"1113","message":"余额不足"}`（该 key 无开放平台余额/包）。
- 发起方给两个 v 模型暂时填了 `contextWindow: 65536` —— **这是拍脑袋值，等 R1 修正**。
- 飞书侧：图片消息经 `im.message.receive_v1`（`message_type:'image'`）+ `GET /open-apis/im/v1/messages/{id}/resources/{file_key}?type=image` 下载，已实测跑通（需 `im:resource` 权限）。

## 4. R1 — GLM 视觉模型事实核查

**交付**：`research/glm-vision-models.json`，符合 `research/schema/glm-vision-models.schema.json`。

必查项（按模型 `glm-4.5v`、`glm-4.6v`，如发现更新的视觉模型如 glm-5v 一并收录）：

| 字段 | 要点 |
|---|---|
| `contextWindow` | 官方文档真值（tokens） |
| `maxOutputTokens` | 同上 |
| `maxImagesPerRequest` | 单请求最多几张图 |
| `imageConstraints` | 尺寸/字节/像素上限；服务端是否自动缩放（`downscaleBehavior`） |
| `pricing` | coding 与开放平台两端点的价差（如有） |
| `stability` | **重点**：coding 端点对视觉模型的支持是否出现在官方文档？若无文档描述，如实填 `undocumented` 并在 notes 说明风险 |
| `deprecated` / 版本迭代 | 4.5v 与 4.6v 差异、弃用时间表 |

渠道建议：open.bigmodel.cn 官方文档（模型列表、视觉理解、coding 专属端点说明）、智谱开放平台更新公告、BigModel GitHub/社区。

## 5. R2 — 飞书开放平台能力矩阵

**交付**：`research/feishu-capabilities.json`，符合 `research/schema/feishu-capabilities.schema.json`。

| 模块 | 必查项 |
|---|---|
| `permissions` | 本项目相关 scope 全集及**控制台中文名**：收发消息、`im:resource`、群聊接收、`im:file`（文件上传/发送）、长连接事件订阅。每个注明 `requiredFor`（p2p-image / group / file-upload / long-output） |
| `cardPatchRateLimit` | 卡片流式更新（PATCH `/im/v1/messages/{id}` 或卡片 update API）的 QPS/突发限制——发起方当前 40ms 一更，需要官方依据 |
| `fileUpload` | `POST /im/v1/files`：大小上限、类型限制、接收方类型、所需 scope；机器人发文件消息的调用链 |
| `groupChat` | `im.message.receive_v1` 群聊样例：**完整原始事件 JSON**（含 `mentions` 数组结构、`@_user_N` 占位符在 content 中的形态）；机器人如何获知自己的 open_id（`bot.info`?）；群内回复消息的正确 API（是否可用 reply） |
| `fileMessage` | `message_type:'file'` 的事件 JSON 样例（content 内 file_key/file_name）；`message-resource` API 对 `type=file` 是否可用及差异 |
| `messageResource` | 支持的 type 集合、大小/频控限制、合并转发消息内资源是否可下载 |
| `longConnection` | 长连接（WebSocket）模式的事件订阅限制、心跳/重连要求、与 webhook 的差异 |

渠道：open.feishu.cn/document（服务端 API、事件订阅、机器人）、飞书开放社区。

## 6. R3（可选加分）— 探针脚本

零依赖 Node 脚本，由发起方带凭据本地执行：

- `research/probe-glm-vision.mjs`：读 `GLM_API_KEY`/`GLM_BASE_URL`，对指定模型列表逐个发 1×1 PNG（内嵌 base64，勿读文件系统）+ 短文本，记录 HTTP 状态/错误码/token 用量/时延，验证 R1 的 `maxImagesPerRequest`（逐加图片直到报错）。
- `research/probe-feishu-card-rate.mjs`：读飞书凭据，向 `FEISHU_OPEN_ID` 发一张卡片后按 10/25/50 QPS 各打 30 次 patch，统计 429/成功时延分布。

**探针契约**（两个脚本都必须满足）：

1. 结果写 `research/out/<probeId>.json`，符合 `research/schema/probe-result.schema.json`
2. 退出码：完全成功 0，部分失败 1，配置缺失 2
3. 幂等：重跑覆盖自己的 out 文件，无其他副作用
4. 任何日志输出不得包含密钥值

## 7. 验收标准（发起方如何验收你的交付）

1. `JSON.parse` + schema 校验通过（`tools/apply-research.mjs` 手写校验器为准）
2. 每个非 null 数值字段有 ≥1 个 `sources` URL；`null` 与 `"undocumented"` 是合格结论
3. 与第 3 节基线冲突处已写入 `conflictsWithBaseline` 并解释
4. 中文撰写 notes/说明；JSON 字段名保持 schema 英文
5. 时间盒：约半天；查不到的项目宁可 null 也不要编造

## 8. 你的交付如何被使用（字段→决策映射）

| 你交付的字段 | 接入点 |
|---|---|
| `models[].contextWindow` / `maxOutputTokens` | 写入 `settings.yaml` 的模型声明（自动） |
| `models[].maxImagesPerRequest` / `imageConstraints` | router 图片合并窗口上限、附件准入参数（自动） |
| `models[].stability` / `pricing` | 用户侧选型建议卡片（人工采纳） |
| `cardPatchRateLimit` | 流式卡片 throttle 与退避参数（自动） |
| `fileUpload` / `permissions` | P4 长输出转文件实现 + `/doctor` 权限清单（自动+人工核对） |
| `groupChat` 事件样例 | 群聊 @ 解析的测试夹具（自动） |
| `conflictsWithBaseline` | 打印给用户裁决（人工） |
