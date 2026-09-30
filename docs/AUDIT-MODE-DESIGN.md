# dsh-feishu `/audit` 自动审计模式设计方案

**版本**：v0.3  
**日期**：2026-09-27（v0.1 同日；v0.2 协议缺口补丁 + 本机部署评估；v0.3 审计事实源冻结为 GitHub remote commit）  
**目标仓库**：`itsnone-liu/dsh-feishu`  
**设计基线**：`main @ 016115f83995a85682c48f91b1cf4d0e96de7096`  
**参考项目**：
- `miuuyy/codex-chatgpt-web`，设计参考基线 `main @ 2d73f626290a5062825bb595dabb89aaf88d16c5`
- `XiaoDuoYa/codex-with-chatgpt`，设计参考基线 `main @ 9663b88753e35c76796c5bce000293e0bd22cd9e`

> **v0.3 修订记录**（标注 `[v0.3]`；核心原则见新增 §29）：
>
> 1. **冻结原则**：所有正式 Audit 以**已 push 到 GitHub 的 commit** 为审计对象；本地未 push 状态不作为正式审计事实源（§29）；
> 2. READY_FOR_AUDIT 与 Web 审计之间新增 push gate：`commit → push → ls-remote 确认 origin/<branch> tip == headCommit → AUDIT_REMOTE_READY`，未确认前禁止发起审计（§8/§29）；
> 3. push 失败分类：瞬时（网络）→ `WAIT_GIT_PUSH` 退避重试；非快进 / 远端 tip 被外部改动 → `ERROR_GIT_REMOTE` → `PAUSED_NEEDS_USER`（§29.3）；
> 4. `codex-chatgpt-web` 职责收窄：只承担「调用网页 GPT」，不再承担「让 GPT 读取本地 workspace」；只读 Codex 降级为**辅助抓取通道**（从 GitHub 取 commit 事实喂给 Web GPT），不得覆盖 GitHub 事实（§5/§29.4）；
> 5. manifest 新增 `repo` / `branch` / `auditedCommits`；`headCommit` 语义收紧为「已 push 且远端可见的待审 commit」（§7）；
> 6. 测试事实规则：本地测试 PASS 是 READY gate；测试报告**入库**（随待审 commit 提交）成为 Web GPT 可核对的事实；网页 GPT 无代码执行能力，其职责是核对报告与代码/diff 一致性、检查覆盖不足，而非复跑（§29.5）；
> 7. handoff 模板加 `REPO` / `TARGET_COMMIT`，审计指令改为「inspect the GitHub repo at commit X」（§15）；
> 8. G12 新增：Remote-only audit fact source；G2 改写为抓取范围约束（§21）；
> 9. 崩溃恢复简化：恢复 run 后按 `targetCommit` 重审同一 GitHub commit，不受本地工作区前进影响（§22/§29.2）。

> **v0.2 修订记录**（补丁均以 `[v0.2]` 标注，v0.1 原文未改动）：
>
> 1. §6.2 补 `/audit until` 竞态规则（目标早于当前阶段时拒绝）；
> 2. §7.2 新增启动校验 gate 清单；
> 3. §8 补 `REVISE_LOOP_EXHAUSTED` 状态迁移（迭代上限耗尽的归属）；
> 4. §9 补 DSH turn 结束但无 `READY_FOR_AUDIT` marker 的超时策略；
> 5. §7.3 补审计范围界定（untracked 文件与 ignorePaths）；
> 6. §18.2 补 events.jsonl 事件字段要求（headCommit + token 消耗）；
> 7. §21 新增 G11（禁 amend/rebase 已审 commit）；
> 8. §28 新增本机部署评估（2026-09-27 实测：网络、额度策略定稿、资源、自启现状）；
> 9. §20 补额度策略确认（执行侧 GLM+Codex 双模型耗尽即等待；审核侧网页额度池）。

---

## 1. 背景与目标

当前工作流分为两个阶段。

第一阶段由用户全程参与：

1. 用户在 ChatGPT 网页端讨论需求、研究目标、实施路线和阶段划分；
2. 用户负责对目标、边界、阶段定义和方案进行修改；
3. 当方案冻结后，将最终任务书交给 DSH；
4. DSH 使用 GLM、GPT 等模型执行工程工作。

第二阶段目前仍需要用户人工充当中转器：

1. DSH 完成一个阶段；
2. 用户把完成结果复制到 ChatGPT 网页；
3. ChatGPT 独立审核代码、结果和测试；
4. 用户把审核意见再复制给 DSH；
5. DSH 修复；
6. 重复审核，直至通过；
7. 进入下一阶段。

本方案只自动化第二阶段。

**不自动化需求定义，不替代用户确定研究方向，不引入通用 Agent Fabric，不做复杂多 Agent 调度。**

目标是为 `dsh-feishu` 增加一个 `/audit` 模式，使下列过程自动完成：

```text
用户冻结方案
      ↓
DSH 执行阶段
      ↓
Web GPT 独立审核
      ↓
不通过 → 自动把问题交回 DSH 修复
      ↓
再次审核
      ↓
通过 → 进入下一阶段
      ↓
达到用户指定停止阶段
      ↓
停止并通过飞书通知用户
```

---

## 2. V1 核心原则

### 2.1 用户仍然是工程 Owner

用户负责：

- 最终目标；
- 研究/工程路线；
- 阶段划分；
- 任务边界；
- 停止点；
- 对方案本身的重大修改。

自动化系统只能：

- 执行冻结方案；
- 检查实现是否符合冻结方案；
- 发现代码错误、遗漏、测试不足、事实不一致；
- 要求 DSH 修复；
- 在用户定义的阶段边界内继续。

如果审核模型认为“冻结方案本身需要改变”，不得自行改方案，必须进入：

```text
PAUSED_NEEDS_USER
```

---

### 2.2 Executor 和 Auditor 必须分离

DSH 是执行者：

```text
DSH
├─ 修改文件
├─ shell
├─ test
├─ build
└─ git
```

Web GPT 是审核者：

```text
Web GPT
├─ 读取 GitHub remote commit（正式审计事实源 [v0.3]）
├─ 读取 commit diff / 文件 / 入库测试报告
├─ 对照冻结方案
└─ 给出 APPROVE / REVISE / NEED_USER
```

V1 中 Web GPT **不获得写权限和 shell 执行权**。

原则：

> 审核者不能依据执行者的“我已经完成”文本直接批准；必须独立检查工作区事实。

---

### 2.3 不继承人工讨论聊天

用户前期在 ChatGPT 网页中的方案讨论聊天与自动审计聊天彻底分离。

自动模式启动后：

```text
人工方案讨论 Chat
        ≠
自动 Audit Chat
```

原因：

- 避免人工聊天上下文过长；
- 避免自动化误操作用户正在使用的聊天；
- 避免 Windows / Ubuntu 并行运行发生 conversation 串线；
- 自动审计可自由 rollover；
- 审计事实来自 repo，而不是聊天历史。

---

## 3. 总体架构

```text
                          Feishu
                            │
                      /audit T2
                            │
                            ▼
                 ┌────────────────────┐
                 │    dsh-feishu      │
                 │ AuditController    │
                 └─────────┬──────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
       DSH Executor               Web Audit Runner
       GLM / GPT                        │
              │                         ▼
       edit/test/git             只读 Codex 辅助抓取 [v0.3]
              │               （从 GitHub 取 commit 事实）
              ▼                         │
       commit + push ───► GitHub remote ◀── 正式审计事实源
              │             repo @ headCommit
              │                         │
              │               ls-remote 确认 tip==head
              │               → AUDIT_REMOTE_READY
              │                         │
              │                         ▼
              │                codex-chatgpt-web
              │                         │
              │                         ▼
              │                    ChatGPT Web
              │                         │
              │              inspect GitHub commit
              │                         │
              └──── REVISE / PASS ◀─────┘
```

> `[v0.3]` 正式审计事实源是 GitHub remote 上的 commit，不是本地工作区（§29）。

---

## 4. 为什么 V1 直接复用 `codex-chatgpt-web`

不在 `dsh-feishu` 内重新实现：

- Electron；
- ChatGPT 登录；
- 网页 DOM selector；
- 模型选择；
- Responses/SSE；
- ChatGPT 页面 streaming；
- browser turn identity；
- compaction；
- Windows/Linux 浏览器兼容；
- ChatGPT UI 漂移检测。

`codex-chatgpt-web` 已提供本机 loopback Responses 路由：

```text
POST /v1/responses
POST /v1/responses/compact
GET  /v1/models
GET  /healthz
```

它负责：

```text
Codex / Responses
      ↓
ChatGPT browser worker
      ↓
ChatGPT Web
```

因此 V1 把它作为一个本机 Web-GPT sidecar，而不是把它的代码复制进 `dsh-feishu`。

> `[v0.3]` 职责收窄：`codex-chatgpt-web` 只承担「调用网页 GPT」这一传输职责，**不再承担「让 GPT 读取本地 workspace」**。审计数据面是 GitHub remote commit（§29）；如需程序化取回 commit 事实（diff/文件/报告），由只读 Codex 辅助抓取并作为只读输入喂给 Web GPT，GitHub commit 始终是唯一权威事实源。

---

## 5. Web Audit Runner 的调用方式

推荐调用链：

```text
AuditController
      ↓
确认 AUDIT_REMOTE_READY（GitHub tip == headCommit）[v0.3]
      ↓
启动一个 read-only Codex audit task
      ↓
模型 = chatgpt-web/high（或配置值）
      ↓
codex-chatgpt-web
      ↓
ChatGPT Web
      ↓
inspect GitHub repo @ headCommit
```

Codex 在这里不是项目执行者，只承担 `[v0.3]`：

- **辅助抓取**：从 GitHub remote 取 `repo @ headCommit` 的 diff（`stageBaseCommit..headCommit`）、文件内容、入库测试报告；
- 把上述事实作为只读输入提供给 Web GPT；
- GitHub remote commit 是唯一权威事实源；本地 workspace 状态不进入正式审计。

必须使用只读 sandbox。

Web Auditor 不得拥有：

```text
write_file
apply_patch
shell mutation
git commit
delete
```

---

## 6. `/audit` 用户接口

### 6.1 启动

```text
/audit T2
```

语义：

> 从当前 DSH session 开始进入自动执行—审核—修复循环，在 T2 审核通过后停止。

也支持：

```text
/audit T3
/audit C4-D
/audit phase-b
```

阶段名称视为字符串，由当前冻结任务书定义，不要求只能是 `T1/T2/...`。

---

### 6.2 管理命令

```text
/audit status
/audit pause
/audit resume
/audit stop
/audit until T3
```

含义：

- `status`：显示 run、阶段、状态、轮次、当前 commit、最近审核结果；
- `pause`：在当前安全边界暂停；
- `resume`：恢复；
- `stop`：结束自动模式，不删除 DSH session；
- `until X`：修改停止阶段。

V1 不建议实现复杂子命令体系。

> **[v0.2] `/audit until` 竞态规则**
>
> `until X` 必须通过校验才能生效，否则拒绝并回卡片说明原因：
>
> 1. `X` 必须是 manifest `stages` 中的合法阶段名；
> 2. `X` 的序号必须 **大于等于** `currentStage`（把停止点改到已经完成的阶段没有定义语义，拒绝）；
> 3. `X == currentStage` 且当前正处 `AUDITING`：本次审核结束后按新目标判定（APPROVE 即停，语义不变）；
> 4. `X == stopAfter`（无变化）：幂等成功，不产生副作用；
> 5. 修改只写 manifest 的 `stopAfter` 字段并追加 `events.jsonl`（`STOP_TARGET_CHANGED`），不影响正在进行的 turn。

---

## 7. Audit Manifest

`/audit` 启动时冻结一个本地 manifest。

建议路径：

```text
$DSH_HOME/feishu/audit/runs/<runId>/manifest.json
```

核心字段：

```json
{
  "schemaVersion": 1,
  "runId": "audit_xxxxx",
  "hostId": "ubuntu-01",
  "chatId": "...",
  "dshSessionId": "...",
  "cwd": "...",

  "goal": "...",
  "approvedPlan": "...",
  "stages": ["T1", "T2", "T3"],
  "currentStage": "T1",
  "stopAfter": "T2",

  "repo": "https://github.com/itsnone-liu/<repo>.git",
  "branch": "main",
  "startingCommit": "...",
  "stageBaseCommit": "...",
  "auditedCommits": [],

  "createdAt": "...",
  "updatedAt": "..."
}
```

> `[v0.3]` 远端字段语义：
>
> - `repo` / `branch`：正式审计事实源位置；`/audit` 启动 gate 必须验证本地 HEAD 与 `origin/<branch>` 一致；
> - `headCommit`（运行态，见 state.json）**始终指已 push 且 `git ls-remote origin <branch>` 可见的 commit**；未 push 的本地 commit 不构成审计对象；
> - `auditedCommits`：已进入审计链（已发起过 Web 审计）的 commit 列表。这些 commit 进入 G11 保护——被 amend/rebase/force-push 破坏即 `HISTORY_REWRITTEN`。

### 7.1 Manifest 的角色

Manifest 是自动模式的“授权边界”。

Auditor 可以指出：

```text
实现不符合 approvedPlan
测试不足
diff 存在问题
阶段交付不完整
```

Auditor 不可以自行：

```text
增加新研究阶段
重构用户目标
改变冻结指标
改变研究口径
推翻用户已经冻结的架构
```

涉及上述内容时必须：

```text
NEED_USER
```

### 7.2 启动校验 gate `[v0.2]`

`/audit <X>` 在创建 run 之前必须全部通过以下检查，任一失败即拒绝启动并回显原因（fail-closed）：

```text
1. stages 非空、无重复、顺序即执行顺序（来自冻结任务书）
2. X ∈ stages
3. DSH session 已绑定且空闲（不被其他端占用）
4. git 起点：工作区 clean；否则拒绝（或显式记录脏起点清单后由用户确认）
5. startingCommit / stageBaseCommit 已写入 manifest
6. Web sidecar /healthz = ok 且 accepting_turns = true
7. Web smoke（固定 token 往返）通过
8. 额度水位探测：执行侧（GLM/Codex）与审核侧（网页）均未处于耗尽状态
```

第 8 条是软门槛：额度临界时允许启动但卡片明确提示当前水位。

### 7.3 审计范围界定 `[v0.2]`

Auditor 的默认审计范围为：

```text
git diff(stageBaseCommit..HEAD)
+ 全量测试运行结果
+ manifest.ignorePaths 之外的受控文件读取
```

- untracked 文件默认 **不纳入** 审计基准，但 Auditor 可以要求 DSH 解释 untracked 文件的来源（`REVISE` 项）；
- 构建产物、缓存等应列入 `manifest.ignorePaths`；
- Auditor 通过只读 Codex 的文件读取权限仅限 `manifest.cwd` 且排除 `ignorePaths`（见 G2）。

---

## 8. 状态机

V1 使用一个尽量小的状态机：

```text
IDLE
  │
  ▼
EXECUTING
  │
  │ DSH stage ready (READY_FOR_AUDIT, identity ok, no history rewrite)
  ▼
REMOTE_SYNC_GATE [v0.3]
  │  commit → push → ls-remote 确认 origin/<branch> tip == headCommit
  │
  ├── push 瞬时失败（网络）────► WAIT_GIT_PUSH ──退避重试──► REMOTE_SYNC_GATE
  │
  ├── 非快进 / tip 被外部改动 ──► PAUSED_NEEDS_USER (cause=ERROR_GIT_REMOTE)
  │
  └── AUDIT_REMOTE_READY
         ▼
      AUDITING
         │
         ├── REVISE ───────────► EXECUTING
         │
         ├── NEED_USER ────────► PAUSED_NEEDS_USER
         │
         ├── WEB_FAILURE ──────► WAIT_WEB / ERROR
         │
         └── APPROVE
                │
                ├── current != stopAfter
                │        ↓
                │    NEXT_STAGE
                │        ↓
                │    EXECUTING
                │
                └── current == stopAfter
                         ↓
                       STOPPED
```

额外运行状态：

```text
WAIT_DSH_QUOTA
WAIT_WEB_QUOTA
WAIT_GIT_PUSH       [v0.3]
PAUSED
PAUSED_NEEDS_USER
ERROR
```

> **[v0.2] REVISE 迭代上限耗尽**
>
> `maxReviewIterations`（默认 8）耗尽而当前 stage 仍未 APPROVE 时：
>
> ```text
> AUDITING ── iteration > maxReviewIterations ──► REVISE_LOOP_EXHAUSTED
>                                                  │
>                                                  ▼
>                                          PAUSED_NEEDS_USER
> ```
>
> - 事件 `REVISE_LOOP_EXHAUSTED` 写入 `events.jsonl`，附全部历次 verdict 摘要；
> - 飞书卡片列出：各轮 P0/P1 未解决项、当前 HEAD、建议（继续加轮次 `/audit resume` 后人工确认，或人工介入修复）；
> - **禁止**：静默放行进入下一 stage、静默重置 iteration 计数、用执行模型代替复审（G4/G6 仍然生效）。

---

## 9. DSH 与 AuditController 的协议

不依赖自然语言猜测。

DSH 阶段完成后必须输出一个可解析的 terminal marker。

例如：

```text
[DSH-AUDIT]
STATE: READY_FOR_AUDIT
RUN_ID: audit_xxxxx
STAGE: T1
ITERATION: 2
HEAD: abc1234
SUMMARY:
...
TESTS:
...
```

AuditController 检查：

```text
runId
stage
iteration
commit
```

与本地状态一致后，才能触发 Web 审核。

> **[v0.2] DSH turn 结束但无合法 marker**
>
> DSH turn 结束（`turn/end`）但输出中解析不到合法 `READY_FOR_AUDIT` 块时：
>
> ```text
> 第 1 次：向 DSH session 重发一条「请按协议输出 READY_FOR_AUDIT 标记」的指令（同一 turn 内 follow-up）
> 第 2 次仍失败：PAUSED_NEEDS_USER（事件 MARKER_PARSE_FAILED）
> ```
>
> - 禁止把"没有 marker"解释为"通过"或"失败"，只能解释为"协议未履行"；
> - parser 必须是严格逐行解析器（键值行 + 段落），不得用宽松正则全文搜索；marker 块必须出现在 assistant 最终消息的尾部区域；
> - RUN_ID/STAGE/ITERATION/HEAD 任一字段与本地状态不一致 → 丢弃该 marker，按无 marker 处理（fail-closed）。

---

## 10. Web GPT 审核输出协议

Web GPT 必须返回结构化控制块：

### 10.1 通过

```text
[DSH-AUDIT]
STATE: APPROVE
RUN_ID: audit_xxxxx
STAGE: T1
ITERATION: 2

SUMMARY:
...

EVIDENCE:
...

RESIDUAL_RISKS:
...
```

### 10.2 要求修订

```text
[DSH-AUDIT]
STATE: REVISE
RUN_ID: audit_xxxxx
STAGE: T1
ITERATION: 2

P0:
- ...

P1:
- ...

TESTS_REQUIRED:
- ...
```

### 10.3 需要用户判断

```text
[DSH-AUDIT]
STATE: NEED_USER
RUN_ID: audit_xxxxx
STAGE: T1
ITERATION: 2

REASON:
冻结任务书与当前实现存在需要改变目标/范围才能解决的冲突。

QUESTION:
...
```

---

## 11. 防止串话

### 11.1 三重身份

每一轮都绑定：

```text
HOST_ID
RUN_ID
STAGE
```

例如：

```text
HOST_ID: ubuntu-01
RUN_ID: audit_7f31a
STAGE: T2
```

Web GPT 返回时必须匹配。

任何一个不一致：

```text
FAIL CLOSED
```

不得把审核意见注入 DSH。

---

### 11.2 一次 AuditRun 一个独立 Codex thread

禁止：

```text
多个 AuditRun 复用同一个 Codex thread
```

推荐：

```text
AuditRun A → Codex thread A
AuditRun B → Codex thread B
```

---

### 11.3 V1 推荐“每次审核轮次开新 Web Chat”

为了最大限度降低串线和上下文增长，V1 可采用更保守策略：

```text
T1 / audit iteration 1 → Chat A
T1 / audit iteration 2 → Chat B
T2 / audit iteration 1 → Chat C
```

每一轮都重新向模型提供短 handoff，真实事实由 Codex 从工作区读取。

因此不依赖长 ChatGPT conversation。

如果后续实测性能需要优化，再考虑同阶段复用 retained chat。

---

## 12. Windows + Ubuntu 双端运行

两台机器可以同时安装：

```text
Windows
└─ codex-chatgpt-web profile A

Ubuntu
└─ codex-chatgpt-web profile B
```

两边可以登录同一个 ChatGPT 账号，但：

**绝不复制、同步或共用浏览器 profile。**

每台机器独立保存：

```text
cookies
localStorage
Electron userData
browser tabs
runtime socket/pipe
launcher state
```

### 12.1 共享的只有账号额度

```text
Windows Audit ─┐
               ├─ same ChatGPT account quota
Ubuntu Audit ──┘
```

因此默认：

```text
auditConcurrencyPerHost = 1
```

V1 不实现跨主机分布式锁。

如果两台机器同时工作，允许最多各一条 audit；如果后续发现账户并发或额度有问题，再增加 account-wide lease。

---

## 13. Ubuntu 8GB 部署方案

Ubuntu 不安装完整 GNOME/KDE 桌面。

推荐：

```text
Ubuntu 8GB
│
├─ dsh
├─ dsh-feishu
├─ Xvfb :99
└─ codex-chatgpt-web
    └─ Electron / Chromium
```

### 13.1 VNC 不是常驻组件

只在以下情况临时启动：

```text
ChatGPT 首次登录
验证码
2FA
账号重新认证
浏览器故障排查
```

操作完成后关闭 VNC。

长期只保留：

```text
Xvfb
+
Electron
```

---

## 14. Web GPT 额度与错误恢复

不得把所有错误都当作“重试”。

分类处理。

### 14.1 短暂错误

包括：

```text
429
temporary capacity
network reset
browser transient failure
upstream temporary error
```

策略：

```text
短指数退避
30s
60s
120s
...
最大 N 次
```

超过阈值后升级。

---

### 14.2 Web 额度耗尽

进入：

```text
WAIT_WEB_QUOTA
```

行为：

1. 冻结当前 stage；
2. 不允许 DSH 进入下一 stage；
3. 飞书发状态卡；
4. 如果错误中能解析恢复时间，按恢复时间重试；
5. 否则按配置周期探测；
6. 恢复后重新发起本轮 audit。

默认不使用执行模型代替 Web GPT 审计。

原因：

> Executor 不能自动变成自己的 Reviewer。

---

### 14.3 登录失效 / CAPTCHA / 2FA

统一进入：

```text
PAUSED_NEEDS_USER
```

不得自动无限重试。

飞书提示：

```text
Web GPT 需要人工重新认证。
当前阶段已冻结，DSH 不会继续进入下一阶段。
```

用户修复登录后：

```text
/audit resume
```

---

### 14.4 UI / DOM 漂移

如果 `codex-chatgpt-web` 明确报 browser/UI adapter failure：

```text
ERROR_WEB_ADAPTER
```

禁止：

- 猜测结果；
- 自动 fallback 到另一个 transport；
- 把空结果当 APPROVE。

---

### 14.5 输出协议错误

Web GPT 没有输出合法控制块：

第一次：

```text
要求它重新输出结构化 verdict
```

第二次仍失败：

```text
PAUSED_NEEDS_USER
```

---

## 15. 上下文管理

V1 不依赖“一个对话从 T1 聊到 T20”。

真实状态保存在：

```text
repo
git
tests
DSH session
Audit Manifest
Audit Run State
```

Web GPT 只收到短 handoff：

```text
[DSH-AUDIT HANDOFF]

RUN_ID: ...
STAGE: T2
ITERATION: 1

REPO: https://github.com/itsnone-liu/<repo>      [v0.3]
BRANCH: main                                     [v0.3]
TARGET_COMMIT: def456   （已 push，ls-remote 确认可见）[v0.3]

ORIGINAL_GOAL:
...

FROZEN_STAGE_REQUIREMENTS:
...

COMPLETED:
T1 approved @ abc123

BASE_COMMIT:
abc123

INSTRUCTION:
Independently inspect the GitHub repo at TARGET_COMMIT
(diff BASE_COMMIT..TARGET_COMMIT, files, committed test reports).
Do not trust executor claims.
Return APPROVE / REVISE / NEED_USER.
```

代码正文、diff 和测试不复制进 control prompt `[v0.3]`：diff / 文件 / 入库测试报告由只读 Codex 从 **GitHub remote @ TARGET_COMMIT** 取回作为输入；本地 workspace 状态不进入正式审计。

---

## 16. 阶段停止规则

`/audit T2` 的含义必须严格冻结为：

```text
T2 审核 APPROVE 后停止
```

不是：

```text
T2 开始时停止
```

也不是：

```text
T2 DSH 声称完成时停止
```

只有：

```text
Web Auditor APPROVE T2
```

才能触发：

```text
STOPPED_TARGET_REACHED
```

飞书卡片：

```text
✅ Audit 自动流程已停止

Run: audit_xxxxx
T1: PASS
T2: PASS
Stop target: T2
Current HEAD: abc1234

等待用户下一步指令。
```

---

## 17. 用户干预规则

Audit 模式运行期间用户仍可通过飞书 steer。

但要区分两种情况。

### 17.1 普通修正

例如：

```text
先不要重构这个模块
测试增加 Windows 场景
```

可以作为当前 DSH turn steer。

---

### 17.2 改变冻结任务书

例如：

```text
不要做 T2 了
把方案改成另外一种架构
新增 T2.5
```

AuditController 必须：

```text
PAUSE
```

并要求重新冻结 manifest，而不是一边运行一边悄悄修改审计基准。

---

## 18. 持久化

建议目录：

```text
$DSH_HOME/feishu/audit/
├── runs.json
└── runs/
    └── audit_xxxxx/
        ├── manifest.json
        ├── state.json
        ├── events.jsonl
        ├── handoffs/
        └── reviews/
```

### 18.1 state.json

至少记录：

```text
state
currentStage
stopAfter
iteration
dshSessionId
auditThreadId
stageBaseCommit
lastHeadCommit
lastVerdict
retryState
updatedAt
```

---

### 18.2 events.jsonl

审计流水：

```text
RUN_STARTED
STAGE_STARTED
READY_FOR_AUDIT
AUDIT_STARTED
AUDIT_REVISE
AUDIT_APPROVE
REVISE_LOOP_EXHAUSTED   [v0.2]
WEB_QUOTA_WAIT
PAUSED_NEEDS_USER
STAGE_ADVANCED
STOP_TARGET_CHANGED     [v0.2]
TARGET_REACHED
RUN_STOPPED
```

> **[v0.2] 事件字段要求**
>
> 每条事件至少携带：
>
> ```text
> ts（毫秒时间戳）
> runId / stage / iteration
> headCommit（事件发生时的 HEAD）
> elapsedMs（自 RUN_STARTED 起的累计耗时）
> tokens（本事件消耗的审核侧 token 估算，无则 0）
> ```
>
> `tokens` 的用途：事后复盘额度消耗速率，为后续调整 `maxReviewIterations` 与额度水位阈值提供数据。只记数字，不得记录任何对话正文。

不得记录：

```text
ChatGPT cookie
token
OAuth secret
browser storage
```

---

## 19. 与现有 `dsh-feishu` 的集成点

当前仓库已有：

```text
src/commands.js
src/autocontinue.js
src/driver.js
src/router.js
src/store.js
src/config.js
```

V1 建议新增：

```text
src/audit/
├── controller.js
├── store.js
├── protocol.js
├── manifest.js
├── web-runner.js
├── recovery.js
└── cards.js
```

### 修改 `commands.js`

增加：

```text
/audit
```

命令解析与状态卡。

---

### 修改 `router.js`

增加：

```text
AuditController user activity hook
```

避免 audit 状态与普通 steer 冲突。

---

### 修改 session event 监听

监听 DSH：

```text
turn/end
assistant/message
```

识别：

```text
READY_FOR_AUDIT
```

注意：

**不能仅依赖字符串搜索最终文本。**

优先把 audit marker 做成明确的机器协议事件或严格 parser。

---

### 修改 `config.js`

新增：

```json
{
  "audit": {
    "enabled": true,
    "hostId": "ubuntu-01",
    "model": "chatgpt-web/high",
    "concurrency": 1,
    "maxReviewIterations": 8,
    "quotaPollMs": 600000,
    "maxWebWaitMs": 21600000,
    "freshConversationPerReview": true
  }
}
```

---

## 20. 与现有 AutoContinue 的关系

现有 `AutoContinue` 继续负责：

```text
DSH 执行模型
GLM quota
GPT fallback
DSH turn retry
```

新增 `AuditRecovery` 负责：

```text
Web GPT quota
Web browser failure
login expiry
UI drift
audit output protocol
```

两者不能混在同一个 watcher 中。

但错误分类、退避算法和飞书通知风格可复用。

> **[v0.2] 额度策略定稿（2026-09-27 用户确认）**
>
> 两个额度池各司其职，互不挤占：
>
> ```text
> 执行侧（Codex 订阅 API 池，5h/周窗）
>   = GLM 主力 + Codex（codex-proxy → backend-api/codex/responses）兜底
>   = 两者都耗尽 → WAIT_DSH_QUOTA 等待（维持现有 AutoContinue 行为，不改）
>
> 审核侧（网页对话额度池，独立计量）
>   = chatgpt-web（codex-chatgpt-web Electron）
>   = 耗尽 → WAIT_WEB_QUOTA
> ```
>
> 关键理由：网页对话额度与 Codex API 额度是**两个独立池**。审核走网页路线正是为了不挤占执行侧赖以兜底的 Codex 池。因此 G4（Web 不可用时禁止执行模型代审）与「执行侧耗尽即等待、不换审核模型凑合」是对称约束。

---

## 21. 重要安全约束

### G1 — Web Auditor read-only

Web audit Codex 必须运行在只读权限。

### G2 — Audit fact containment `[v0.3 改写]`

正式审计事实只来自 `manifest.repo @ TARGET_COMMIT`（GitHub remote）。只读 Codex 的抓取范围限定为该 repo 该 commit（含 `diff(stageBaseCommit..TARGET_COMMIT)` 与入库测试报告）；本地 workspace 不进入正式审计。

### G12 — Remote-only audit fact source `[v0.3]`

所有正式 Audit 以**已 push 到 GitHub 且 `ls-remote` 确认可见**的 commit 为审计对象：

```text
READY_FOR_AUDIT → commit → push → ls-remote(tip == headCommit)
              → AUDIT_REMOTE_READY → 才允许发起 Web 审计
```

push 失败绝不进入正式审计：瞬时失败 → `WAIT_GIT_PUSH`；非快进 / tip 被外部改动 → `ERROR_GIT_REMOTE` → `PAUSED_NEEDS_USER`（详见 §29）。

### G3 — Run identity

每个审核 verdict 必须匹配：

```text
HOST_ID
RUN_ID
STAGE
ITERATION
```

### G4 — No silent fallback

Web GPT 不可用时不得静默改用 DSH 当前模型充当审核者。

### G5 — No automatic scope change

Auditor 提出需要改变冻结方案时进入 `NEED_USER`。

### G6 — No stage skipping

只有 `APPROVE(currentStage)` 才能进入 next stage。

### G7 — Stop target exactness

`stopAfter=T2` 必须在 T2 APPROVE 后停止。

### G8 — Crash recovery

桥重启后从 `state.json` 恢复，不重复已经批准的阶段。

### G9 — Idempotency

同一：

```text
run + stage + iteration + headCommit
```

不得因为消息重复投递而触发两个 Web audit。

### G10 — No secret persistence

Audit logs 不得写 browser/session credentials。

### G11 — No history rewrite under audit `[v0.2]`

G9 的幂等键包含 `headCommit`，其前提是已审 commit 不可变。因此：

```text
AUDITING 期间禁止 amend / rebase / reset 已被审核的 commit；
每轮 REVISE 修复必须产生新 commit（headCommit 前进）。
```

AuditController 在每次 READY_FOR_AUDIT 校验时顺带检查：若发现 `git log` 中已审 commit 的哈希变化（历史被改写），立即 `PAUSED_NEEDS_USER`（事件 HISTORY_REWRITTEN），不重复发起审计。

---

## 22. 崩溃恢复

### 场景 A：dsh-feishu 重启

读取：

```text
audit/runs.json
state.json
```

如果状态：

```text
EXECUTING
```

重新绑定已有 DSH session。

如果：

```text
AUDITING
```

不能假设网页请求仍然存在。

策略：

```text
把该轮 audit 标记为 INTERRUPTED
重新发起同一 iteration 的 fresh audit
```

但必须使用相同：

```text
stage
iteration
headCommit
```

保证语义幂等。

> `[v0.3]` GitHub 模式下恢复更稳：`headCommit` 已 push 到 GitHub，恢复 run 后按 `targetCommit` 重审同一远端 commit，不受本地工作区已前进影响——审错对象在结构上不可能（§29.2）。

---

### 场景 B：codex-chatgpt-web 重启

先：

```text
GET /healthz
```

不可用：

```text
WEB_UNAVAILABLE
```

等待 sidecar 恢复后重发 audit。

---

### 场景 C：DSH session 被别的端占用

沿用 `dsh-feishu` 已有 fail-closed 行为：

```text
PAUSED_NEEDS_USER
```

不得静默创建新的执行 session。

---

## 23. Web sidecar 健康检查

`/audit` 启动前必须检查：

```text
codex-chatgpt-web /healthz
```

至少确认：

```text
status=ok
accepting_turns=true
```

然后运行一个最小 Web smoke：

```text
要求模型返回固定 token
```

失败则不进入自动模式。

可以扩展 `/doctor`：

```text
✅ DSH
✅ Audit feature
✅ codex-chatgpt-web daemon
✅ ChatGPT authenticated
✅ Web model available
✅ read-only Codex smoke
```

---

## 24. V1 不做的功能

明确排除：

- Agent Fabric；
- 中央调度器；
- 多节点任务迁移；
- 多 reviewer 投票；
- 自动选择最佳 reviewer；
- 自动修改 frozen plan；
- 跨主机共享 browser profile；
- 数据库；
- 通用 workflow DSL；
- ChatGPT 人工讨论聊天接管；
- 自动操纵用户正在使用的浏览器窗口；
- 每台机器多个并发 Web audit。

---

## 25. 实施阶段建议

### A1 — Protocol + Store

实现：

```text
AuditRunStore
Manifest
state machine
protocol parser
```

全部用 fake runner 测试。

Gate：

```text
状态迁移全覆盖
重复事件幂等
run/stage mismatch fail closed
stopAfter 精确
```

---

### A2 — Feishu Commands

实现：

```text
/audit T2
/audit status
/audit pause
/audit resume
/audit stop
/audit until X
```

Gate：

```text
不影响现有 /new /stop /model /preset
```

---

### A3 — DSH Lifecycle Hook

实现：

```text
READY_FOR_AUDIT
REVISE injection
APPROVE → NEXT_STAGE
```

Gate：

```text
不会把 audit 指令误当普通用户消息
不会重复执行同一阶段
```

---

### A4 — WebAuditRunner Fake

先做 fake Web auditor：

```text
approve
revise
need_user
quota
login_expired
protocol_error
```

Gate：

完整状态机端到端跑通。

---

### A5 — codex-chatgpt-web Integration

接入真实：

```text
read-only Codex
+
chatgpt-web model
```

Gate：

1. Web GPT 能独立读取 workspace；
2. 能读取 git diff；
3. 无写工具；
4. 正确返回 structured verdict；
5. 两个 AuditRun 不串线。

---

### A6 — Windows

验证：

```text
Windows launcher
独立 browser profile
/audit smoke
```

---

### A7 — Ubuntu 8GB

验证：

```text
Xvfb
无完整桌面
codex-chatgpt-web
单 audit concurrency
登录态保持
内存压力可接受
```

VNC 仅用于登录/维护。

---

### A8 — Fault Matrix

必须主动注入：

```text
Web quota
429
network loss
browser crash
ChatGPT logout
malformed response
dsh-feishu restart
codex-chatgpt-web restart
duplicate Feishu message
stage mismatch
run mismatch
DSH session occupied
```

全部验证 fail-closed 和恢复语义。

---

## 26. 最终 V1 用户体验

用户：

```text
/audit T2
```

飞书：

```text
🚀 Audit Run 已启动
Run: audit_7f31a
Current: T1
Stop after: T2
Executor: DSH
Reviewer: ChatGPT Web
Web concurrency: 1
```

此后用户可以离开。

系统自动：

```text
T1 execute
→ audit
→ revise
→ audit
→ PASS
→ T2 execute
→ audit
→ revise
→ audit
→ PASS
→ STOP
```

最终：

```text
✅ 自动审计达到停止点

T1 PASS
T2 PASS

Stop target: T2
HEAD: abc1234

自动流程已停止，等待用户决定是否继续。
```

---

## 27. 冻结结论

V1 采用以下方案：

1. `dsh-feishu` 新增 `/audit` 模式；
2. DSH 继续做唯一执行者；
3. `codex-chatgpt-web` 作为本机 Web GPT sidecar；
4. Web GPT 通过只读 Codex 独立检查 repo/diff/test；
5. 不接管用户人工 ChatGPT 讨论聊天；
6. 自动审计聊天与人工聊天完全分离；
7. Windows、Ubuntu 各自维护独立浏览器 profile；
8. 同一个 ChatGPT 账号可以同时登录，但两端共享账号额度；
9. 每台机器 Web audit 并发固定为 1；
10. Ubuntu 8GB 使用 `Xvfb + Electron`，不安装完整桌面，VNC 仅临时登录/维护；
11. Web GPT quota 时冻结 stage 并等待，不让 Executor 自审；
12. 登录/CAPTCHA/2FA/UI drift 进入人工处理状态；
13. 审核上下文以 repo 为事实源，通过 fresh audit chat / handoff 避免长上下文；
14. `/audit T2` 精确定义为 **T2 审核通过后停止**；
15. V1 不实现 Agent Fabric、多节点调度或通用 workflow 系统；
16. `[v0.3]` **所有正式 Audit 以已 push 到 GitHub 且远端可见的 commit 为唯一审计事实源**；本地未 push 状态、本地 workspace 均不作为正式审计事实（G12 / §29）。

该方案的目标不是构建新的 Agent 平台，而是把现有人工的：

```text
DSH → 用户复制 → Web GPT 审核 → 用户复制 → DSH
```

替换成：

```text
DSH → AuditController → Web GPT → AuditController → DSH
```

除此之外尽量不改变现有工作方式。

---

## 28. 本机部署评估（2026-09-27 实测）`[v0.2]`

评估对象：`RainYun-c438TDGn`（Ubuntu 22.04.5，即 §13 预设的 8GB 机；同时是 dsh-bridge 生产机）。

### 28.1 网络（决定性实验）

| 实验 | 结果 |
|---|---|
| 出口 IP | `154.64.231.1` — Los Angeles, US（AS979 NetLab Global） |
| 裸 curl `chatgpt.com` / `auth.openai.com` | 403 —— Cloudflare 对数据中心 IP 无指纹请求的拦截（**不是**区域封锁） |
| headless Chromium | 被 Turnstile 挡（"Just a moment..." 挑战页） |
| **Xvfb 有头 Chromium（正常桌面 UA）** | **15 秒内自动过 CF，拿到真实 ChatGPT 页面，75 秒观察稳定** |

结论：§4/§12/§13 的 Electron 有头 + Xvfb 路线在网络层**成立**。headless 方案不可用（不可改为 headless 省内存）。

### 28.2 本机就绪度

| 项 | 状态 |
|---|---|
| dsh-feishu 基线 | 本地 HEAD = `016115f` = 本设计基线；src 结构与 §19 吻合 |
| Xvfb / xvfb-run | 已装，实测可用 |
| node v22 / npm / codex CLI 0.146.1 | 已装（codex 已 ChatGPT OAuth 登录，供执行侧兜底） |
| Electron | 未装 —— 由 `codex-chatgpt-web` 自带，npm 安装即可（勿用系统 snap chromium：strict confinement 下 `/tmp` 不可写、CDP 受限，实测起不来） |
| 内存 | 7.8Gi，available ~6.1Gi，Electron 常驻（0.5–1GB）可容纳 |
| 磁盘 | 已扩容 20G：`/` = 117G（66% 用，余 40G），充足 |
| systemd | `dsh-bridge` / `codex-proxy` / `cc-connect` / `fabric-central` / `dsh-web` 全部 `enabled` + `Restart=always`（开机自启 + 崩溃自动拉起） |

### 28.3 实施注意事项

1. **Electron sidecar 需自建 systemd 单元**（A5）：`Xvfb :99 + codex-chatgpt-web`，`Restart=always`，`After=network-online.target dsh-bridge.service`；崩溃后按 §22 场景 B 恢复（先 `/healthz`，AUDITING 中的轮次标记 INTERRUPTED 重发）；
2. **首次登录**：DC IP 上 ChatGPT 登录可能触发验证码/邮件验证，按 §13.1 临时 VNC 人工登录一次，此后 Electron 常驻保持会话；
3. **`~/.codex` 全局状态污染**：本机 codex `config.toml` 被多工具（cc-connect / codex-deepseek 等）频繁修改（40+ backup 为证）。若 A5 之后引入任何 codex CLI 辅助调用，必须 `CODEX_HOME` 隔离，否则 audit 依赖的配置会被外部改写；
4. **参考仓库可达**：GitHub 直连正常，两个参考项目 HEAD 与 §参考项目 所列基线一致。

### 28.4 评估结论

方案 v0.2 在本机**无阻塞项**，可直接进入 A1。执行顺序建议：A1（Protocol+Store+状态机，fake runner 全覆盖，含 v0.2 新增状态/事件）→ A2 → A3 → A4 → A5（真实 Electron 接入 + systemd 单元）→ A6/A7 合并为「双端 proxy 式部署验证」（Windows 跑同款 sidecar）→ A8 故障矩阵（追加：proxy 401 OAuth 过期 → PAUSED_NEEDS_USER）。

---

## 29. GitHub 审计事实源（v0.3 冻结原则）

> **冻结原则**：所有正式 Audit 都以**已经 push 到 GitHub 的 commit** 为审计对象；本地未 push 状态不作为正式审计事实源。

### 29.1 阶段流程

```text
DSH 完成 T1
      ↓
本地测试 PASS
      ↓
commit（含入库测试报告，见 29.5）
      ↓
git push origin <branch>
      ↓
git ls-remote 确认 origin/<branch> tip == audit headCommit
      ↓
AUDIT_REMOTE_READY
      ↓
Web GPT 审计（数据面 = GitHub）
      ├─ commit 元数据 / 必要历史
      ├─ diff(stageBaseCommit..headCommit)
      ├─ 仓库文件 @ headCommit
      └─ 入库测试产物/报告
      ↓
APPROVE / REVISE / NEED_USER
```

### 29.2 为什么

1. **审计对象天然冻结**：`T1 audit target = abc1234` 永不改变——无论 Windows / Ubuntu / DSH 后续把本地工作区怎么改，审的始终是 GitHub 上的 abc1234；
2. **双机对称**：Web GPT 不依赖任何一台机器的本地 workspace，只需要 `repo + commit` 两个参数，两端审计事实完全一致；
3. **恢复简单**：AuditController 崩溃 → 恢复 run → 读 `targetCommit` → 重审同一 commit。本地工作区已前进也不会审错对象；
4. **与既有工作流一致**：延续「commit + 报告 = 唯一事实源」的人工审计习惯。

### 29.3 push gate 与失败分类

READY_FOR_AUDIT 之后、Web 审计之前必须通过 REMOTE_SYNC_GATE：

| 失败类型 | 判定 | 状态 | 恢复 |
|---|---|---|---|
| 瞬时网络失败 | push/ls-remote 连接错误、超时 | `WAIT_GIT_PUSH` | 指数退避自动重试（30s/60s/120s，上限 N 次） |
| 非快进被拒 | push rejected (non-fast-forward) | `ERROR_GIT_REMOTE` → `PAUSED_NEEDS_USER` | 人工：远端被外部改动，须确认基准未被动过 |
| 远端 tip 不符 | ls-remote tip ≠ headCommit（审计发起时） | `ERROR_GIT_REMOTE` → `PAUSED_NEEDS_USER` | 人工：同上，外部 push 过该分支 |
| 重试耗尽 | WAIT_GIT_PUSH 超过上限 | `PAUSED_NEEDS_USER` | 人工检查网络/凭据 |

规则：

- 未到达 `AUDIT_REMOTE_READY` **绝不发起正式 Web 审计**；
- `auditedCommits` 中已进入审计链的 commit 受 G11 保护；GitHub 的 non-fast-forward 拒绝天然阻止普通 amend 重放，force-push 由 ls-remote tip/ancestry 校验捕获。

### 29.4 与本地只读 Codex 的关系

```text
正式审计事实源 = GitHub remote commit（唯一权威）
本地只读 Codex = 辅助抓取通道（fetch GitHub @ TARGET_COMMIT → diff/文件/报告 → 喂给 Web GPT）
```

- 辅助抓取结果只是 GitHub 事实的**投影**，冲突时以 GitHub 为准；
- 本地 workspace / 未 push 状态永远不进入正式审计；
- `codex-chatgpt-web` 职责相应收窄：只负责调用网页 GPT（§4）。

### 29.5 测试事实规则

网页 GPT 没有代码执行能力，因此测试事实分两层：

```text
执行层：DSH 本地跑测试（READY gate：测试 PASS 才算 stage ready）
事实层：测试报告随待审 commit 入库（如 docs/reports/ 或约定路径），成为 Web GPT 可核对的对象
```

Auditor 对测试的职责 = 核对入库报告与代码 / diff 的一致性、识别覆盖不足与可疑结论；**不是复跑**。executor 自述「测试通过」本身不构成事实——入库报告才是。

### 29.6 对实施阶段的影响

- **A1**：状态机加 `WAIT_GIT_PUSH`；事件加 `GIT_PUSH_WAIT` / `GIT_PUSH_RETRY` / `AUDIT_REMOTE_READY` / `ERROR_GIT_REMOTE`；manifest/state 加 `repo` / `branch` / `targetCommit` / `auditedCommits`；fake runner 增加 push 成功 / 瞬时失败 / 非快进 / tip 分歧注入；
- **A3**：DSH lifecycle hook 在 READY_FOR_AUDIT 后执行真实 `git push` + `git ls-remote` 校验；
- **A5**：Web GPT 审计输入从「本地 workspace」改为「GitHub @ TARGET_COMMIT」；
- **A8**：故障矩阵追加 push 网络中断、非快进、外部 push 污染分支、force-push 改写已审历史四类注入。

## 30. 修订 v2 —— 纯无人值守（2026-09-30 业主指令，取代 §"预授权" 全部设计）

**背景**：PREAUTH v1（P-A~P-D）上线后仍连续发生人闸通道事故——最近一次
2026-09-30：run `audit_20260930021152297` 在 B4 布防等待人类批准，用户输入
未通过冻结话术校验，桥回「❌ 审计人工输入未转交」并丢消息，run 卡死约 8
小时。业主裁决：**审计程序不得含任何人工授权门禁；除非异常事故不停机；
任务书若强制人工批准则修改任务书。**

**已删除（commit 见 2026-09-30）**：
- 人工批准协议：SEAL/REVEAL 批准话术正则与构造器、`WAIT_HUMAN_APPROVAL`
  等待块解析、executor 的 `submitHumanResponse`、READY 防绕过守卫；
- PREAUTH v1 全套：`preauth-protocol.js`、`preauth-store.js`、任务书
  `preauthorization` 节解析、`/audit preauth add|list|revoke`、
  `GATE_PASSED_BY_PREAUTH/POLICY/MISMATCH` 事件与 gateProvenance 注入；
- router 对同 chat 普通文本的批准转交（「审计人工输入未转交」事故机制）。

**保留**：HARD STOP 阶段边界与独立审计、REVISE 迭代、身份四元组 fail-closed、
停-报-修-续事故语义（WATCHDOG/执行异常/审核基础设施故障仍会停机汇报——
这属"异常事故"，不属人工授权门禁）、`/audit pause|resume|stop` 止损控制。

**迁移**：旧持久化 `waitingForHuman=true` 的 run 在加载时被
`recoverTransientState` 确定性解除（事件 `HUMAN_GATE_REMOVED`），lifecycle
据此补发阶段 prompt，run 无人值守续跑（B4/C2/C5 按修订后任务书自动落
`approved_by=UNATTENDED_POLICY` 批准工件，hash 绑定与机器实测校验照旧）。
