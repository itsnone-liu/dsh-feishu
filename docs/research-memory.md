# Agent 长期记忆机制调研：三个 GitHub 项目技术摘要

> 调研目的：为 DeepSeek Harness (dsh) 设计长期记忆机制提供参考。
> 数据来源：GitHub API + 各仓库 README / INSTALL / docs 源文件（raw.githubusercontent.com 实际拉取核对）。
> 说明：文中标注"未找到/无法确认"的信息均经过检索确认；未编造任何字段或机制。

| # | 项目 | 仓库 | Stars | 语言/许可 |
|---|------|------|-------|-----------|
| 1 | ai-memory | https://github.com/akitaonrails/ai-memory | 4,546 | Rust / MIT |
| 2 | OpenViking | https://github.com/volcengine/OpenViking | 33,214 | Python（CLI 为 Rust）/ 主仓 AGPLv3 |
| 3 | TencentDB-Agent-Memory | https://github.com/TencentCloud/TencentDB-Agent-Memory | 24,407 | TypeScript / MIT |

> ⚠️ 地址勘误：用户最初提供的 `Tencent/TencentDB-Agent-Memory` 不存在，实际仓库在 **TencentCloud** 组织下（README 内部分自引用链接仍写 `Tencent/`，已失效）。默认分支为 `feat/server_team`（v3 团队版），另有 `main` 分支（v2 个人版）。
> OpenViking 由字节跳动火山引擎（volcengine）开发，配套论文 VikingMem（arXiv:2605.29640，VLDB 2026）。

---

## 1. akitaonrails/ai-memory

### 1.1 一句话定位

面向编码 agent CLI 的跨 harness 长期记忆服务——"在 Claude Code 中途退出，几小时后换 OpenAI Codex 在同一目录继续，无需重新解释架构、失败尝试和未决问题"。

### 1.2 核心架构

单个 Rust 二进制运行一个 MCP/HTTP 服务（axum，默认绑定 `127.0.0.1:49374`，可 bearer auth 扩展到 LAN/homelab），独占一个数据目录：

```
<data_dir>/
├── wiki/    # markdown 源 of truth，git 版本化（可 grep / Obsidian 打开 / rsync 备份）
├── raw/     # 不可变的脱敏 managed-workstream transcript 段（raw/workstreams/）
├── db/      # SQLite 索引：FTS5、实体、向量
├── models/  # 预留：本地 embedding 模型
└── logs/    # 滚动 tracing 输出
```

**核心设计：markdown wiki 为真（source of truth），SQLite 只作索引**——wiki 文件可通过 `ai-memory reindex` 重建索引；反向用 `restore-page` 从 git 历史恢复单页并重新入索引。

身份坐标为 **workspace / project 双键**（稳定 UUID）：`<wiki_root>/<workspace_id>/<project_id>/…`。project 默认由 `$cwd` 派生（CLI 子命令走到主 git repo 根，使同 repo 的所有 worktree 共享同一 project 身份；hook 路由默认 `basename($cwd)`，可选 repo-root 规则）。祖先目录放 `.ai-memory.toml` marker 可显式覆盖两个字段。`_global` 为保留的跨项目偏好域（`scope: "global"`），事件捕获永不写入该域。

#### SQLite Schema（当前 head，来自 docs/ARCHITECTURE.md）

| 表 | 内容 |
|---|---|
| `workspaces`, `projects` | 三元组身份坐标的顶层 |
| `pages` | 版本化 wiki 页，`is_latest` + `supersedes` 链。M8 列：`last_accessed_at`、`access_count`、衰减墓碑 `superseded_at`；M9 列：`embedding_provider`、`embedding_model`、`embedding_dim`；V36：`expires_at`（frontmatter TTL）；V37：`salience`（NULL = `salience_default`，由 `page_feedback` 派生） |
| `pages_fts` | FTS5 虚表，覆盖 `(title, body)`，触发器自动同步 |
| `sessions`, `observations` | 脱敏、有界的生命周期 hook 投影。`sessions.ended_observation_count` 是 resumed-session 重结束资格的稳定生成水位（不用墙上时钟）。定位为操作审计轨迹而非完整原生 transcript |
| `session_consolidation_jobs` | 持久化、按 observation-generation 幂等的 SessionEnd LLM 整固队列；单 worker 租约、指数退避重试、重启后恢复过期租约 |
| `observations_fts` | 原始 observation `(title, body)` 的 FTS5 虚表，仅作有界回退 |
| `workstreams`, `managed_runs`, `workstream_native_sessions` | `ai-memory run` 的租约状态 + 每 harness 原生源/投递游标 |
| `workstream_events`, `workstream_events_fts` | 追加式归一化可见 transcript 事件 + 全文检索；不可变脱敏源批次存 `raw/workstreams/` |
| `links` | wikilink / markdown 交叉引用。`to_page_id`（全局 PageId）可空以支持未解析前向链接；`to_workspace`/`to_project` 携带跨项目作用域 |
| `handoffs` | 类型化跨 agent handoff 记录（open / accepted / expired） |
| `page_embeddings` | 可选向量行，只存最新版页；`(provider, model, dim)` 冗余存储，hybrid 检索可忽略换 embedding 配置后的陈旧向量并报告缺失诊断 |
| `page_feedback` | 追加式 `memory_feedback` 信号（`helpful`/`not_helpful`/`stale`/`wrong`），按页**版本**键控，可选脱敏 reason 和 `salience_after`。是派生列 `pages.salience` 的真源 |
| `page_access` | 每个最新页 + 合格操作者身份一行；供可选的访问广度保留项 |
| `client_activity` | 服务端 MCP 工具调用计数（读/写分列），按 UTC 日分桶；每天最多 128 个脱敏 client 标签 + `other`，防未信任 `clientInfo.name` 制造流量正比行 |
| `auto_improve_proposals` | 分阶段的学习/维护编辑，含不可变目标快照和追加式决策事件 |
| `entities`, `entity_page_links` | V38 实体名词索引，来自规范化 frontmatter。名称小写、空白归一、项目内唯一；链接指向不可变页版本而检索只过滤最新版；scope 配对触发器防跨项目链接。驱动第四路 RRF 检索流 |
| `audit_log` | 每次变更，可按 `at DESC` 寻址 |

#### 页面 frontmatter（可手工声明）

```yaml
---
title: Queue choice
entities:
  - nats jetstream
  - delivery guarantees
expires_at: 2026-12-31   # TTL，RFC3339 或日期
pinned: true             # 豁免一切衰减
---
```

实体名称：小写、空白归一、去重、每页上限 10 个、每个 ≤64 字符，可由 markdown 在 clean-store `reindex` 时重建。

### 1.3 记忆生命周期

**写入（三条路径）**：

1. **生命周期 hook 自动捕获**（主路径，fire-and-forget）：SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PreCompact / SessionEnd 等事件 POST 到服务器，落为有界脱敏 observation（用户提示与 compaction 后摘要 ≤16 KiB；通知与工具摘录 ≤2 KB；每条 observation body 有 16 KiB 持久兜底）。会话结束或 PreCompact 时，把 observation **编译**成连贯 markdown 页（Karpathy "compile-not-retrieve" 模式）——不是检索原始日志。无真正 SessionEnd 事件的客户端可手动 `ai-memory finalize-session --agent <agent>`。
   - 每 repo 捕获排除：最近 marker 的 `[capture] ignore_paths` 策略在进 spool 前丢弃匹配的文件工具事件；`install-hooks --capture-mode allowlist` 反转为无 marker 即零捕获。
   - 空 SessionStart/SessionEnd 会话不产页/handoff；已接受启动上下文的空会话其 handoff 归还开放池。
2. **显式永久页**：用户说"记住…"时 agent 调 `memory_write_page`（或 CLI `ai-memory write-page --path decisions/0007-db.md --body '…' --pinned`）。与 handoff（一次性）和自动会话页（整固时重写）不同，write-page 页归用户所有、进 `/web` 渲染、直到用户修改。
3. **冷启动 bootstrap**：`ai-memory bootstrap` 一次性汇总 git log、README、docs/、模块头、项目规则成种子 wiki 页。

**检索**：MCP `memory_query` = **四路 RRF 融合**——FTS5 全文 + 实体精确/前缀/复合词匹配（project 作用域 RRF 流）+ 图邻居扩展（`links` 表）+ 可选向量 RRF（配置了 embedder 时，OpenAI/Voyage/Gemini/openai-compat 本地引擎均可）→ 有界"权威调整"（偏向受维护的 `_rules/`、`decisions/`、`procedures/`、`gotchas/` 页，tier / `pinned` / `canonical`/`active`/`source-of-truth` 或 `superseded`/`historical` 标签参与但不做绝对过滤）→ 有界原始 observation 回退（非 global 检索）。
- `explain: true` 输出每命中的 `score_details`（各流排名、matched_entities、原始 FTS/cosine/实体逆频率分数、RRF 贡献、图来源、权威乘数、可选 rerank 分数）+ 顶层 `streams_active`。
- `global: true` 跨项目搜索用独立的 FTS-only ranker；默认作用域额外 union `_global` 偏好域为 `global_scope_hits`。
- 可选 `AI_MEMORY_RERANKER=llm`：融合候选后至多一次 LLM 重排（查询 + ≤30 个有界标题/片段，JSON 编码视为不可信数据；超时/出错/并发饱和 ≥4 时保留原序）。
- **LLM 完全可选**：零 LLM 模式仍有 FTS5 + 手工实体 + 图邻居检索与规则化摘要；配置 provider 后解锁整固页、矛盾 lint、staged auto-improvement。
- 每整固页 frontmatter 存 ≤10 个具体名词（技术/组件/服务/文件/领域名词），词面不同也能召回。

**衰减/淘汰（三项目中最完整）**：

四层 memory tier（M8 策略）：

| Tier | 生命周期 | 衰减 |
|---|---|---|
| Working | 仅当前会话 | 会话结束硬丢（`observations` 留档供 forensics） |
| Episodic | 30d 热 → 180d 冷 → 逐出 | `salience · exp(−λΔt) + σ · log(1+access_count) · exp(−μ · days_since_access) · (1 + breadth_weight · ln(1 + max(distinct_actors−1, 0)))` |
| Semantic | 无限期 | 无衰减——仅可通过 M7 LLM 重写 supersede |
| Procedural | 无限期 | 不再被观察到则频率衰减 |

治理闭环：
- `pinned: true` 豁免所有衰减路径；TTL（`expires_at`）优先于 pin，到期页从 search/recent/briefing 消失（`include_expired: true` 可见），下次 forget sweep 硬删文件和行；`memory_lint` 对 pinned+expiring 组合告警。
- `memory_feedback`：`helpful`/`not_helpful` 调节 sweep 资格页的 salience（缩放衰减公式的时间项）；`stale`/`wrong` 给 salience 设下限并把当前页标记为 `feedback_flagged` lint 发现。**feedback 从不删除任何东西**，只降置信度并标记待审；反馈绑定到记录时的页版本，后续重写自动清标记。
- `memory_forget_sweep`（`dry_run=true` 可预览）：逐出冷页、清理老化墓簿祖先、硬删 TTL 过期页。
- `memory_lint`：规则 + LLM 矛盾检查 → `wiki/_lint/`。
- `curator`：无 LLM 规则化维护报告（冷 episodic 页、陈旧 slot、重复标题、悬空跨项目链接），report-only，`--stage` 才入审批队列。
- **auto-improve 闭环**（Hermes 启发）：后台调度器复习每个项目新完成的会话，产出 wiki 编辑提案进 pending-writes 审计轨迹，默认自动走正常 wiki 写路径批准，可设 `[auto_improve] require_approval = true` 转人工审；per-project 首跑水位防止升级时回扫历史会话；失败复习按 per-session claim 不无限重试。
- 会话结束 LLM 整固为 opt-in（`AI_MEMORY_CONSOLIDATE_ON_SESSION_END`）；无论如何实质会话结束都写规则化摘要页 + handoff。provider 失败回退确定性规则页。

**Handoff（跨 agent 交接）**：类型化记录（open/accepted/expired）；下一个支持的 hook 客户端 SessionStart 时预注入"where you left off"块（开放问题、下一步、会话摘要）。接受即过期，同 cwd 的自动 handoff 单取最新、接受时过期旧的，重复 SessionEnd 不累积——**一次性语义**防重复注入。

### 1.4 与 agent/harness 集成方式

- **MCP（18 工具）+ 生命周期 hook 双通道**：`install-mcp --client <x>` 与 `install-hooks --agent <x>` 幂等安装，带时间戳 `.bak` 备份，保留其他服务器/hook 条目；hook 脚本 staged 到 `~/.local/share/ai-memory/hooks/<agent>/`。
- 支持约 20 个 agent CLI（Claude Code、Codex、OpenCode、Cursor、Gemini CLI、Devin CLI、Kimi Code、Kiro CLI、Grok Build CLI、Antigravity CLI、Command Code、OMP、Pi、OpenClaw、Crush、Zero、Swival、Pool、Zed、VS Code Copilot…）。无 hook 的客户端降级为 MCP-only，用 `memory_handoff_accept` 恢复 handoff。
- **托管工作流**：`ai-memory run claude` → `ai-memory run codex --yolo` 透明续接同一逻辑 workstream（原生 per-harness session resume + 可移植可见事件账本 + 全账本检索）；`ai-memory continue` 免选目录续接最近 launch。
- per-session 路由：`[auto_scope] mode = "per_session"` + `install-mcp --session-aware` stdio 桥，把 Claude 生命周期 session id 附到每个 MCP 请求。
- 认证阶梯：loopback 无认证（默认）→ bearer token → DB 用户 token（`ai-memory user add`，写入归因到人，v0.8）→ OIDC device auth / SSO actor proxy。`[slots] per_user = true` 提供共享服务器上的 per-operator 记忆 slot 隔离（上下文注入隔离而非 RBAC）。
- 只读 `/web` HTML UI（项目树、FTS5、markdown 渲染）+ `/api/v1` JSON 前端 API + `GET /admin/activity/by-client` MCP 客户端活动统计。
- 项目内路由指令：`ai-memory install-instructions` 写入精简 `<!-- ai-memory:start -->` 块 + 托管 Agent Skills（静态 SKILL.md 教 agent 何时调哪个 MCP 工具）。

### 1.5 亮点设计（可借鉴）

1. **wiki 为真 + SQLite 为索引**：记忆可 grep、可 Obsidian、git 时间旅行（checkpoints / restore-page / 原生 git log），索引可随时从文件重建——数据主权和可恢复性对单机场景极友好。
2. **compile-not-retrieve**：会话结束时把 observation 编译成连贯决策页，检索命中是"决策页"而非原始聊天日志。
3. **显式衰减公式 + pinned/TTL/feedback/lint/curator/auto-improve 全生命周期治理闭环**；feedback 只降置信度不删数据、绑定页版本。
4. **零 LLM 起步 + 四路 RRF 可解释检索**：FTS5 为主线，向量只是可选增强；`explain` 暴露每命中的完整打分细节。
5. **一次性 handoff + 水位幂等**：observation generation 水位代替墙上时钟做 resumed-session 重结束判定，重复 SessionEnd / 时钟偏移收敛。

### 1.6 局限

1. 依赖 agent 提供 hook 机制；无 hook 的 harness 只剩 MCP 手动查询路径，捕获面不完整（脱敏投影而非完整原生 transcript）。
2. 系统复杂度高：18 个 MCP 工具 + 大量 CLI 子命令 + 多层配置，个人单机使用有学习曲线。

---

## 2. OpenViking（volcengine / 字节跳动火山引擎）

### 2.1 一句话定位

AI Agent 的"上下文数据库"（Context Database）——把记忆、资源、技能统一成一个 `viking://` 虚拟文件系统下的目录树，agent 用 `ls`/`tree`/`find`/`grep` 浏览自己的上下文，而不是查询黑盒向量库。

### 2.2 核心架构

服务端（`openviking-server`，pip 安装，写 `~/.openviking/ov.conf`）+ 客户端 CLI（`ov`，Rust crate，Apache-2.0）+ Python SDK（openviking_sdk）+ 可选 VikingBot agent 框架和桌面 Helper。支持 Volcengine/OpenAI/Codex OAuth/Kimi/GLM/本地 Ollama 等 provider。

**双层存储**（内容与索引分离）：

| 层 | 职责 | 内容 |
|---|---|---|
| **AGFS**（内容层） | 内容存储 | L0/L1/L2 全文、多媒体文件；已用 Rust 重写为 RAGFS；默认单后端（本地目录为主），配置 `storage.agfs.backends` 后进入多写模式（主后端为权威写目标，backups 为副本/迁移/读加速） |
| **Vector Index**（索引层） | 语义检索 | 只存 URI、向量、元数据，**不存文件内容**（省内存、内容单源、可独立扩展） |
| **VikingFS** | URI 抽象层 | `viking://resources/docs/auth` → `/local/{account_id}/resources/docs/auth`；`viking://~/memories` → `/local/{account_id}/user/{user_id}/memories` |

URI 命名空间：

```
viking://
├── resources/              # 资源：项目文档、repo、网页（用户添加，静态）
└── user/{user_id}/
    ├── memories/           # 记忆：agent 提取的认知（动态更新）
    │   ├── preferences/    #   writing_style、coding_habits…
    │   ├── entities/ events/ cases/ trajectories/ experiences/ …
    ├── resources/          #   私有项目资源
    ├── skills/             #   {skill_name}/SKILL.md
    └── peers/{peer_id}/    #   稳定对端的记忆空间
```

**数据模型（三类上下文）**：

| 类型 | 用途 | 生命周期 | 发起方 |
|---|---|---|---|
| Resource | 知识与规则（API 文档、代码库、论文） | 长期、相对静态 | 用户添加 |
| Memory | agent 的认知 | 长期、动态更新 | agent 记录 |
| Skill | 可声明的能力配置 | 长期、静态 | 用户或系统 |

**L0/L1/L2 三层信息模型**（渐进加载的核心）：

| 层 | 名称 | 存储位置 | 默认 body 上限 | 用途 |
|---|---|---|---|---|
| L0 | Abstract | 目录内 `.abstract.md` | 256 字符 | 向量检索、快速相关性过滤 |
| L1 | Overview | 目录内 `.overview.md` | 4000 字符 | rerank、内容导航、决定是否读 L2 |
| L2 | Detail | 原始文件/子目录 | 无统一限制 | 全文，按需加载 |

- L0/L1 是**目录级语义 sidecar**，描述目录而非每个普通文件（文件摘要作为输入聚合进所属目录的 L1）；`mkdir` 初始只生成 L0（目录名或 `description` 为默认 body）；两者不保证共存。
- 新 sidecar 用最小 OKF Markdown：YAML frontmatter（directory、source.kind/uri、generated_by.component/trigger、freshness…）+ 可见 markdown body；L0 从 L1 body 提取（H1 后、首个 `##` 前的 Brief Description 段）。
- 上限由 `semantic.abstract_max_chars` / `semantic.overview_max_chars` 配置，只限 body 不截断元数据。

内置 memory 类型（可用模板扩展）：`profile`（~/memories/profile.md）、`preferences`、`entities`、`events`、`identity.md`、`soul.md`（原则/边界/风格/连续性）、`cases`、`trajectories`、`experiences`（启用后激活完整 Agent Evolution 管线并自动激活 cases/trajectories）。`memories/tools/`、`memories/skills/` 两个 schema 类型已禁用（Skills 独立存于 `~/skills/{name}/SKILL.md`）。允许 Peer memory 时写入 `~/peers/{peer_id}/memories/…`。

### 2.3 记忆生命周期

**写入**：
- 用户/agent `add_resource`（URL/repo/PDF…）→ Parser → TreeBuilder → AGFS → SemanticQueue → Vector Index（写入时即生成 L0/L1/L2）。
- **Session 生命周期**：create（`create_session(session_id=…)`；按 ID get 不创建）→ `add_message(role, content/parts, options, peer_id)`（Part 类型：TextPart / ImagePart（提取时可用 VLM 描述）/ ContextPart（URI+abstract 引用）/ ToolPart（工具调用输入输出））→ `commit()`：
  - **Phase 1（同步，立即返回）**：递增 compression_index → 写 `messages.jsonl` 归档 → 清空当前消息列表 → 返回 `task_id` 和 `archive_uri`。
  - **Phase 2（异步后台，`get_task` 轮询 pending/running/completed/failed）**：LLM 生成结构化摘要（一行概览 + Analysis + Primary Request and Intent + Key Concepts + Pending Tasks）写 `.abstract.md`/`.overview.md` → 提取长期记忆 → 写 `memory_diff.json` 到归档目录 → 更新 active_count → 写 `.done` 完成标记。

**提取与去重（两级 LLM 决策）**：

```
Messages → LLM Extract → Candidate Memories
    ↓
Vector Pre-filter → Find Similar Memories
    ↓
LLM Dedup Decision → candidate(skip/create/none) + item(merge/delete)
    ↓
Write to AGFS → Vectorize
```

| 级别 | 决策 | 含义 |
|---|---|---|
| Candidate | `skip` | 候选与现有重复，跳过 |
| Candidate | `create` | 创建候选（可先删除冲突的现有记忆） |
| Candidate | `none` | 不创建候选，仅按 item 决策解决现有记忆 |
| Per-item | `merge` | 把候选内容合并进指定现有记忆 |
| Per-item | `delete` | 删除指定冲突记忆 |

**memory_diff.json（变更审计/回滚）**：每次 commit 写入归档目录，记录该次全部记忆变更——`operations.adds`（uri、memory_type、after）/ `updates`（before + after）/ `deletes`（deleted_content）/ `skipped_operations`（稳定 reason_code，如 `invalid_ranges`）/ `summary`（各类计数）；全零也写空 diff。

**检索（两阶段：意图分析 + 层级递归 + rerank）**：
- `find()`：单查询直接语义搜索，低延迟，适合简单查询，不需要 session 上下文。
- `search()`：需要 session 上下文。IntentAnalyzer 用 LLM 分析（输入 = 会话压缩摘要 + 最近 5 条消息 + 当前查询）生成 **0–5 个 TypedQuery**（`query`/`context_type`/`intent`/`priority 1-5`；闲聊问候返回 0 个不检索；复杂任务可能同时要 skill+resource+memory）。查询风格：skill 动词开头（"Create RFC document"）、resource 名词短语、memory "User's XX"。该阶段模型可由 `query_planner` 配置，未设回退 `vlm`。
- **HierarchicalRetriever 目录递归检索**：① 按 context_type 定根目录（MEMORY→`viking://~/memories`，RESOURCE→`viking://resources`，SKILL→`viking://~/skills`）→ ② 全局向量搜索定位起始目录 → ③ 合并起点 + rerank 评分 → ④ 优先队列递归（`final_score = score_propagation_alpha · embedding_score + (1−α) · parent_score`，`retrieval.score_propagation_alpha` 默认 1.0；超过阈值的非叶目录继续入队）→ ⑤ 转 MatchedContext。**收敛检测：topk 连续 3 轮不变即停止。**
- **检索轨迹可观测**：每次查询保留目录浏览轨迹，结果可疑时可定位是哪条路径产生的。

**衰减/淘汰**：主文档（storage/session/architecture/retrieval 概念页）中**未找到**显式衰减/淘汰/TTL 机制（grep decay/gc/cleanup/evict/forget/ttl 无结果）。文档站存在 freshness-aware 上级摘要冒泡、文件使用事件日志（usage count）、git 版本管理（基于 Gitoxide 的 in-process 集成）等**设计稿**，属演进方向，**无法确认已实现**。合并机制即上述 LLM 两级去重决策；`rm(uri)` 删除文件并同步删除向量，`mv` 同步更新向量 URI。

### 2.4 与 agent/harness 集成方式

- **官方插件**：Claude Code、Codex、OpenClaw、Hermes、Cursor、TRAE/TRAE CN/TraeCode CLI 2.0、OpenCode、pi——注入 recall 进上下文 + 自动 commit session memory。
- **MCP clients**（通用）、**LangChain/LangGraph** 集成、**Agent Plugins 1.0** 规范。
- **本地 agent 日志导入**：`openviking-server ingest`。
- **OpenViking Helper**（桌面控制台，beta）：可视化配置各 agent 的 plugin/MCP/Hook/CLI 集成；解析 Claude Code/Codex/Trae 会话展示 recall、prompt 注入、MCP 调用、capture、commit 事件；本地记忆/规则文件与 SKILL.md 管理和同步。
- CLI 日常操作：`ov status / add-resource / ls / tree / find / grep`（`ov grep` 是 URI 内文本搜索）。

基准：LoCoMo 用户记忆——OpenClaw 原生 24.20% vs +OpenViking 82.08%；Hermes 33.38% vs 82.86%；Claude Code 57.21% vs 80.32%；输入 token 降 34.3–91.0%，查询延迟降 58.45–66.10%。tau2-bench 任务成功率 Retail 70.94%→77.81%、Airline 54.38%→66.25%。

### 2.5 亮点设计（可借鉴）

1. **虚拟文件系统范式**：记忆有确定性 URI、可用 ls/tree/find/grep 浏览——把"黑盒检索"变成"白盒文件系统"，调试和审计体验质变。
2. **L0/L1/L2 渐进加载**：相关性判断只花 ~100 token（L0），规划用 ~2k（L1），确定相关才读 L2 全文——token 花费与信息深度解耦。
3. **目录递归检索 + 轨迹可观测**：先向量定位最高分目录再逐层下钻，结果自带邻域上下文；坏结果可定位到具体路径。
4. **memory_diff.json 变更审计**：每次 commit 的记忆增删改全量记录（含 before/after），可审计可回滚；LLM 两级去重（candidate + per-item 的 skip/create/merge/delete）显式解决记忆膨胀。

### 2.6 局限

1. 主仓 AGPLv3（CLI/examples 为 Apache-2.0），对闭源/商用集成有传染性顾虑。
2. 语义处理管线强依赖 LLM + embedding provider（L0/L1 生成、意图分析、去重决策都要模型），离线/零 LLM 能力弱。
3. 无显式衰减/淘汰/TTL（未确认实现），长期运行记忆只增不减的风险靠去重缓解。
4. 重型 server 方案：独立 HTTP 服务 + 配置体系 + provider 管理，对单机轻量场景偏重。

---

## 3. TencentCloud/TencentDB-Agent-Memory

### 3.1 一句话定位

团队级 Agent 记忆中枢（Memory Hub）——把对话、文档、代码变成四种可治理、可共享、可"装备"（loadout）给 agent 的记忆资产（Chat Memory / Skill / LLM-Wiki / CodeGraph），口号"Agents remember. Humans innovate."

### 3.2 核心架构

v3（`feat/server_team` 分支）为**三容器 + 代理**：

| 服务 | 端口 | 职责 |
|---|---|---|
| Memory Core | 8420 | 记忆读写、认证、skill/RAG 数据面；**L0 原始对话存 SQLite**；`/health` 可看 pipeline worker 的 tasksConsumed/tasksCompleted |
| Knowledge Service | 8424 | Wiki（Karpathy 式结构化页面 + 链接图）+ CodeGraph（符号/文件/调用关系/影响路径）异步构建 |
| Panel UI | 8125 | 团队记忆控制面板（团队/资产/绑定/ACL 管理） |
| Proxy | 8096 | Anthropic/OpenAI 双协议 LLM 请求代理（管线：`auth` 验 user_key → `sessionInit` 交互选 team/agent/task → `injection` 注入 → 转发上游） |

v2（`main` 分支，个人版）默认本地 **`SQLite + sqlite-vec`** 后端，可选腾讯云向量数据库 TCVDB。

**数据模型：L0–L3 语义金字塔（长期记忆）**

| 层 | 存什么 | 主要用途 |
|---|---|---|
| **L0 Conversation** | 带完整上下文的原始对话 | 核对原话、时间戳、来源 |
| **L1 Atom** | 从对话提取的原子事实、偏好、约束、事件 | 精确召回可执行信息 |
| **L2 Scenario** | 围绕项目/场景组织的知识块 | 快速恢复工作上下文 |
| **L3 Core / Persona** | 长期画像、稳定模式、高层认知 | 让 agent 快速进入用户/团队上下文 |

- 生成与检索都分层：平时 L2/L3 提供快速上下文引导；需要具体事实时 **BM25 + 向量检索 + RRF** 回落到 L1/L0；结果受**条数上限 + 字符预算 + 超时**三重约束，防记忆淹没上下文窗口。
- 每条记忆挂 **`team / agent / task` 三元组**（task 可选，跳过则 L2/L3 失去 Task 维度）。
- 资产元数据：owner、version、status、visibility（`private` 仅 Owner 可读连团队管理员都不行 / `team` 团队可读 / `restricted` User·Role·Agent ACL 精确授权 / `agent` 同团队定向装备）、usage_count、Agent 绑定。
- 角色两层：全局 System Admin（管用户/团队，也可用资产功能）+ 团队级 Admin/Member。
- **异构存储 + 渐进披露**：底层（事实/日志/trace）入库做全文检索；顶层（persona/scene/canvas）存人读 Markdown（高信息密度、白盒可检）。"**下层存证据，上层存结构**"。
- **全链路回溯**：保证从高层抽象到 ground truth 的确定性下钻路径——"顶层符号（Persona/canvas）→ 中层索引（Scenario/jsonl）→ 底层原文（L0 Conversation/refs）"，压缩不可逆的问题被显式规避。

**v2 符号化短期记忆（Symbolic Memory，main 分支核心特性）**：

- 冗长中间日志（搜索结果/代码/错误 trace）offload 到外部文件 `refs/*.md`；
- 提取任务状态转移为高密度 **Mermaid 符号图**（带 `node_id`）；
- agent 上下文只保留轻量 Mermaid 任务图（几百 token），推理在图上进行；需验证细节时按 `node_id` grep 回捞全文。
- 实测（OpenClaw 连续长程会话）：WideSearch 成功率 33%→50%（+51.52% 相对）、token −61.38%；SWE-bench 58.4%→64.2%、token −33.09%；AA-LCR 44.0%→47.5%、token −30.98%；PersonaMem 48%→76%（+59% 相对）。

四种记忆资产：Chat Memory（偏好/事实/决策/交互史）、Skill（不止 prompt 片段——有版本、资源文件、触发边界、执行步骤、验证规则；个人默认私有，审核后可团队共享；复用 Hermes Agent 的 Skill 相关代码）、Wiki（受 Karpathy LLM 知识库启发）、CodeGraph（复用 colbymchenry/codegraph 代码）。

### 3.3 记忆生命周期

- **写入**：Proxy 截获 agent 的 LLM 请求——L0 原始对话落 memory-core SQLite；后台 pipeline worker 在阈值触发后异步逐级提取 L1 → L2 → L3（`promptMode=chat` 从普通对话提取，`code` 模式下闲聊会返回 0 条不持久化）；LLM 判定"可复用 how-to"时自动提取为 Skill；文档/代码导入后异步构建 Wiki/CodeGraph（需等 `ready` 状态）。
- **检索/注入**：会话绑定 team/agent/task 后，**每轮自动把该 agent 绑定的 L2/L3 记忆 + skills + 知识注入 system prompt**（如 `<session_context>`、`<available_skills>`、`<tdai_profile_memory>` 块）；具体事实按需 BM25+向量+RRF 下钻 L1/L0；Wiki/CodeGraph 不整块注入——agent 先 `/v3/tools/list` 发现能力，再 `/v3/tools/call` 按需读相关页面/源码/影响路径。
- **衰减/淘汰**：README/INSTALL 中**未找到**显式衰减/淘汰机制（未确认存在）；有 usage_count 与版本/状态管理。
- **冷启动**：可直接导入已有代码库（CodeGraph 自动索引）、文档（Wiki 自动生成）、历史 agent 会话（Skill 与 Chat Memory 自动提取）——"加载存档再开工"。

### 3.4 与 agent/harness 集成方式（与 dsh 直接相关）

**Proxy 反向注入范式：零代码、零插件、零 hook、零 MCP**——把 agent 的 LLM base URL 指向 Proxy 即完成记忆注入与捕获，协议不变（Anthropic / OpenAI 双协议各设路径）。支持 8 个客户端：Claude Code、CodeBuddy、WorkBuddy、Codex、**DeepSeek Harness (dsh)**、OpenCode、Hermes、OpenClaw + 通用 header 预选。

**dsh 专属适配（`agents/dsh/`，细节非常值得参考）**：

- **配置**：`~/.dsh/settings.yaml` 中 `llm-deepseek.apiKeyEnv: PROXY_USER_KEY` + `baseURL: http://127.0.0.1:8096/dsh/default`（⚠️ 不带 `/v1`——dsh 硬编码 `${baseURL}/chat/completions`）；key 放 `~/.dsh/.credentials.yaml`（dsh 启动硬校验 `chmod 700 ~/.dsh` + `chmod 600` credentials）。
- **请求路径**：主路径 `POST /dsh/:spaceId/chat/completions`，也接受 `/dsh/:spaceId/v1/chat/completions`。
- **Session ID**：优先 `x-deepseek-harness-session-id` header，其次 `x-session-id`；dsh 客户端自动生成携带，proxy 只从 header 取、无 body 兜底。
- **Session Init 表单**：用 `ask_user_question` tool call（call ID 前缀 `call_dsh_session_init_`，OpenAI Chat Completions SSE 协议）走状态机 `asset_confirm → team_select → agent_task_select → initialized`；dsh 选项列表无数量限制不需分页。
- **Headless bypass（dsh 独有）**：检查 `body.tools`——非空但不含 `ask_user_question` tool 即判定 headless，**完全跳过 session-init 直接透传**，使 API 直调/batch 模式正常工作。
- **thinking 模式兼容**：dsh 用 DeepSeek thinking mode，硬校验 assistant 消息必须含 `reasoning_content` 字段——proxy 生成表单响应时需填非空占位。
- **请求分类**：`compact` 请求以 `x-deepseek-harness-compact: 1` header 识别，跳过注入（辅助请求）；`title-gen` 以 body 特征（无 tools + thinking.di…）识别。
- **跳过 Session Init 的三种方式**：headless bypass / 用户输入"跳过"/"skip" / asset_confirm 选"否"。
- **Web UI 首次会话**：`pnpm dsh web --port 3080` 发一句话触发 4 步按钮表单（是否关联团队资产 → Team（仅一个自动跳过）→ Agent → Task（首项为虚拟"本次不关联任务"）），之后每轮注入记忆块；`mem:help` / `mem:sync` / `mem:create-skill` 等 mem 命令在 init 后可用。
- **本地历史导入**：`agents/dsh/asset-import.md` 提供 dsh 本地会话历史导入 Memory Hub 的手册。

### 3.5 亮点设计（可借鉴）

1. **Proxy 反向注入范式**：劫持 base URL 即完成捕获+注入，对任何 OpenAI/Anthropic 协议客户端零改造；其 dsh 适配细致到 compact/title-gen/headless/reasoning_content 等边角，证明该路径对 dsh 完全可行。
2. **L0–L3 金字塔 + 渐进披露 + 全链路确定性回溯**（符号→索引→原文），省 token 同时不丢可验证性。
3. **记忆即资产**：owner/version/visibility/ACL/绑定装备（loadout）+ 人审共享——把记忆治理从"聊天日志仓库"提升为知识管理；"新会话选 Agent 即继承团队经验"的冷启动设计。
4. **Mermaid 符号图 + node_id 回捞**的短期记忆压缩：最高语义密度编码任务状态，几百 token 维持全程可验证。

### 3.6 局限

1. 三容器 + 两组 LLM 配置（memory 组 + proxy 组），对单机个人使用明显偏重。
2. L2/L3 依赖异步阈值触发、Wiki/CodeGraph 需构建等待；team/agent/task 团队语义对个人场景是概念负担；无显式衰减机制。

---

## 4. 综合对比结论（对 dsh 的借鉴价值）

**三个流派**：

- **ai-memory = 文件/wiki 编译派**：markdown 为真 + SQLite 索引，hook 捕获 → 会话结束编译成页 → 显式衰减治理。主线是"compile-not-retrieve"。
- **OpenViking = 上下文数据库/检索增强派**：`viking://` 虚拟文件系统 + L0/L1/L2 渐进加载 + 意图分析/目录递归两阶段检索 + memory_diff 审计。
- **TencentDB = 数据库服务/代理注入派**：L0–L3 语义金字塔 + LLM proxy 反向注入 + 资产化治理与团队共享。

**对"单机个人使用、会话持久化为 jsonl 事件流的 CLI agent harness（dsh）"最有借鉴价值的点**：

1. **"原文为证、编译为记"**（ai-memory）：dsh 已有的 jsonl 事件流天然就是 L0/observations 层——保持其不可变、脱敏有界，在其上异步编译会话摘要页/决策页，索引层可随时从文件重建。不要丢弃事件流去只存摘要。
2. **会话级 L0 摘要 + L1 概览 sidecar**（OpenViking）：每个会话 jsonl 旁挂 ~100 token 抽象 + ~2k 概览（含 Pending Tasks），相关性判断只读 L0，确认相关才读全文——旧会话回捞的 token 成本可控。
3. **LLM 两级去重 + memory_diff 变更审计**（OpenViking）：提取候选记忆先向量预筛再 LLM 决策（skip/create/merge/delete），每次提取写 adds/updates/deletes（含 before/after）的 diff 日志，可审计可回滚。
4. **显式衰减闭环**（ai-memory）：四层 tier（Working/Episodic/Semantic/Procedural）+ 时间×访问×广度的衰减公式 + pinned/TTL 豁免 + feedback 调 salience（只降置信不删数据）+ lint 查矛盾 + dry-run 可预览的 forget sweep。
5. **零 LLM 起步 + 多路 RRF + explain**（ai-memory）：FTS5（或 sqlite-vec/LanceDB 等）本地即可跑通全链路，向量与 LLM rerank 都是可选增强；检索可解释（每命中暴露打分明细）。
6. **一次性 handoff + 会话启动注入**（ai-memory）：跨会话/跨 harness 交接用 open/accepted/expired 状态机，接受即过期防重复注入；用事件数水位而非墙上时钟做幂等判定。
7. **按需注入而非整块注入**（TencentDB）：高层（L2/L3/规则/偏好）每轮轻量注入 system prompt，具体事实按需检索下钻；注入受条数+字符+超时三重预算约束。
8. **符号化压缩 + node_id 回捞**（TencentDB v2）：长会话中冗长工具输出 offload 到 refs 文件，上下文里只保留带 node_id 的状态图，验证时回捞。
9. **Proxy 注入作为补充通道**（TencentDB）：dsh 若要服务无 hook 的第三方客户端，可参考其 base URL 劫持 + header 传 session id + compact/title-gen 请求分类 + headless bypass 的做法；但对 dsh 自身 harness 而言，内置 hook/事件流直采更简单可控（ai-memory 路线）。

**需要规避的坑**：AGPLv3 传染（OpenViking）；无衰减机制导致记忆只增不减（OpenViking/TencentDB）；重型多容器部署对单机的负担（TencentDB）；检索内容不可信——三者的共识是把检索到的历史文本当"不可信证据"，绝不因 namespace/tier/排名获得指令权威（ai-memory 把这一点写进了不变量）。
