# Agent 记忆方案调研（第二轮）：OpenClaw、Hermes、geneticagent 与主流记忆层

> 状态：调研中。第一轮见 `research-memory.md`（ai-memory / OpenViking / TencentDB-Agent-Memory）。
> 方法：Hermes 为本地实例解剖（`/root/.hermes/` 真实安装 + 完整源码），其余为仓库文档调研。

---

## 1. Hermes Agent（本地实例解剖）

> 本机跑着 hermes-agent（gateway + CLI），以下来自真实安装的源码与数据，不是 README 转述。

### 1.1 总体：三层记忆 + 插件适配层

```
┌────────────────────────────────────────────────────┐
│ SOUL.md          persona，每条消息新鲜加载（改文件即生效） │
├────────────────────────────────────────────────────┤
│ memories/MEMORY.md   agent 长期记忆（§ 分隔条目流）      │
│ memories/USER.md     用户画像（Name/Notes/Context 行）  │
│   注入上限：memory 2200 字符 / user 1375 字符（可配）    │
├────────────────────────────────────────────────────┤
│ state.db         会话历史（SQLite messages + FTS5）    │
├────────────────────────────────────────────────────┤
│ MemoryProvider 插件（8 个后端，一次只激活一个）           │
│ holographic(自研) mem0 honcho openviking hindsight    │
│ supermemory byterover retaindb + 用户自装目录          │
└────────────────────────────────────────────────────┘
```

### 1.2 内置记忆的写入时机：nudge + flush（最值得抄的设计）

`run_agent.py` 里的两个参数控制写入节奏：

- `memory_nudge_interval: 10` —— 每 10 轮对话**提醒** agent："检查这次对话有没有值得记进 MEMORY.md 的"
- `memory_flush_min_turns: 6` —— 距上次写盘不足 6 轮不允许 flush（防抖，避免每轮都写文件）

即：**不是每轮都写，也不是只靠会话结束**——周期性提醒 + 最小间隔防抖。写入者是 agent 自己（通过 memory 工具追加/编辑 § 条目）。

### 1.3 MEMORY.md 格式：§ 分隔的条目流 + 硬预算报错拒写

每行一条记忆，`\n§\n` 分隔，新条目追加；可带来源标题前缀。**整个记忆就是一个小到能整块塞进 system prompt 的文件**，没有检索层。

关键行为（`tools/memory_tool.py` 本地源码证实）——**超预算不截断、直接报错拒写**：

```python
if new_total > limit:
    return {
        "success": False,
        "error": (f"Memory at {current:,}/{limit:,} chars. "
                  f"Adding this entry ({len(content)} chars) would exceed the limit. "
                  f"Replace or remove existing entries first."),
        "current_entries": entries,   # ← 把现状全部回给模型
        "usage": f"{current:,}/{limit:,}",
    }
```

即"**错误驱动的同轮整理**"：不压缩、不截断、不需要任何后台设施——写入放不下时把 current_entries 全量附在错误里，逼模型**当场** replace 合并或 remove 腾位后重试。加上精确重复自动拒绝（幂等）和写入前的注入/渗出/隐形 Unicode 扫描（因为要进系统提示词），构成了零基础设施的策展闭环。

USER.md 固定字段：Name / What to call them / Pronouns / Timezone / Notes / Context 行。注入带用量表头（`MEMORY [67% — 1,474/2,200 chars]`）。

**反面教材（真实数据所见）**：本机 MEMORY.md 里存着飞书 app secret **明文**、API key。文件 0600 也挡不住 agent 把密钥写进会被注入 prompt 的记忆文件——记忆内容需要脱敏/lint 规则。

### 1.4 holographic provider（自研默认）：信任分 + 实体 + HRR

（**frozen snapshot 注入**：`format_for_system_prompt` 返回 `load_from_disk()` 时冻结的快照而非活状态——会话中途写入的记忆**不进本会话**的 system prompt，保持 prompt 逐字节稳定以**保住 provider 的 KV prefix cache**。记忆注入以会话为粒度，这是成本上的深思熟虑。）

SQLite 单文件，零依赖（NumPy 可选）：

```sql
facts(fact_id, content UNIQUE, category, tags,
      trust_score REAL DEFAULT 0.5,     -- 信任分，fact_feedback 训练
      retrieval_count, helpful_count,   -- 使用统计
      created_at, updated_at, hrr_vector BLOB)  -- HRR 二值化向量
entities(entity_id, name, entity_type, aliases)
fact_entities(fact_id, entity_id)      -- 事实↔实体多对多
facts_fts(FTS5, triggers 同步)
```

- **fact_store 工具 9 个动作**：add/search/probe/related/reason/contradict/update/remove/list —— `contradict`（找矛盾事实）和 `reason`（推理链）是少见的显式操作
- **fact_feedback 工具**：helpful/unhelpful 反馈训练 trust_score；检索带 `min_trust: 0.3` 阈值，排序 FTS rank → trust_score
- **HRR（Holographic Reduced Representation）**：1024 维组合向量做 related/reason 的关联检索，无需 embedding 模型

### 1.5 会话压缩与辅助模型

`config.yaml`：`compression: {enabled: true, threshold: 0.5, target_ratio: 0.2, protect_last_n: 20}`——上下文用量过半触发压缩，目标压到 20%，最近 20 条消息受保护不压。

**auxiliary model 槽位**：vision / web_extract / compression / session_search 四类杂活各有独立辅助模型配置（`provider: auto` 时自动挑便宜的）——**压缩与检索预处理永远不该占用主模型**，这个职责分离值得照搬。

### 1.6 Provider 插件接口

`MemoryProvider` ABC，`plugins/memory/<name>/` 内置 + `$HERMES_HOME/plugins/` 用户自装，`memory.provider` 配置单选。第三方记忆服务（mem0/honcho/…）做成适配器——**"内置够用的文件记忆 + 可插拔升级路径"** 的分层产品思路。

### 1.7 与 OpenClaw 的同源关系（本地证据）

`hermes-agent` 内置 `optional-skills/migration/openclaw-migration/`：SOUL.md / MEMORY.md / USER.md 逐一同名导入，字符上限完全一致（2200/1375），skills 归入 `openclaw-imports` 类目。**Hermes 的文件式记忆范式直接源自 OpenClaw**——OpenClaw 是该范式的源头实现（详见 §2）。

### 1.8 借鉴点与局限

**借鉴**：① nudge+flush 写入节奏（轮次驱动而非纯事件驱动）；② 2200 字符硬预算的整块注入（简单到不会出错）；③ trust_score + retrieval_count + helpful_count 三计数器（衰减的廉价替代）；④ Provider ABC 适配层；⑤ `contradict` 显式矛盾检测动作。

**局限**：策展容量极小（~1.3K token）；条目只增、无系统性淘汰（靠报错逼模型整理，模型偷懒就会卡在满员）；无版本/审计；明文密钥风险；一个 Hermes home 只许一个 agent 进程；FTS5-only 无向量检索；多用户/共享记忆明确不支持（要靠外部 provider）。

**补充（子代理核实 + 本地互证）**：会话全文入 `state.db` 供 `session_search` 工具 FTS5 检索（发现/滚动/浏览三形态，返回真实消息、无 LLM 摘要、~20ms 查询）——"上周我们聊过 X 吗"这类问题走这条免费 episodic 通道，不占 2200 字符预算。后台自改进 review（每轮 fork 隔离 LLM 回放快照，`auxiliary.background_review` 可路由便宜模型，~3-5× 降本）；`write_approval: true` 时所有写入（含后台 review）staged 进 `/memory pending` 审批队列——"agent 存了关于你的错误假设"的治理解法。SOUL.md 占系统提示词**第 1 槽**（身份位），只从 HERMES_HOME 加载不查 cwd（防跨项目人格漂移）。

---

## 2. OpenClaw（文档调研，openclaw/openclaw @ main）

> Steve Krouse 的开源个人 AI assistant（"Your own personal AI assistant. The lobster way."）。Hermes 记忆范式的源头（§1.7）。以下来自官方 concepts 文档。

### 2.1 五层 tier 模型（一表看懂）

| Tier | 载体 | 谁写 | 注入 |
|---|---|---|---|
| Instructions | `AGENTS.md` 等 | **仅人写** | 会话启动，永远 |
| Curated core | `MEMORY.md` + `USER.md` | dreaming 整固；用户直接要求 | 会话启动（provenance 合格时），有预算 |
| Episodic | `memory/YYYY-MM-DD.md` 每日笔记 + 会话转写 | agent 工作中随手记 | **永不注入**，按需 `memory_search` |
| Prospective | standing intents（SQLite）+ cron | `intent` 工具 | 触发条件满足时 |
| Review | `DREAMS.md` + dreaming 报告 | dreaming 各阶段 | 永不（给人看） |

关键边界：**curated core 与 episodic 之间**——精选层小、常驻上下文、只经门槛整固写入；工作层大、不进上下文、纯检索。

### 2.2 Dreaming：三阶段后台记忆整固（最独特的设计）

每个 sweep 依次跑 Light → REM → Deep 三阶段（实现相位，非用户配置）：

- **Light**：读近期短期 recall 状态 + 每日记忆文件 + 脱敏会话转写 → 去重、staging 候选行，记录强化信号。**不写 MEMORY.md**
- **REM**：从短期痕迹构建主题与反思摘要，记录 REM 强化信号。**不写 MEMORY.md**
- **Deep**：确定性打分 + 三重门槛（`minScore` + `minRecallCount` + `minUniqueQueries` **全部通过**才晋级）；从活文件重新水化候选片段（已删素材自动跳过）；把过门槛的候选 + 当前 MEMORY.md 交给 consolidation subagent 重写——**重写结果必须：保留足够旧条目 + 含候选来源引用 + 不超 bootstrap 预算**，否则验证失败回退到 append-only 晋级。产出写 `DREAMS.md` 供人审查

晋级条目带内联元数据：`<!-- trigger: 短语1, 短语2 -->`（最多 3 个概念标签）+ `<!-- importance: 1-10 -->`；整固保持未触碰条目**逐字节不变**。

**会话转写摄取**：只摄取交互式会话；cron/heartbeat/subagent 会话不进候选语料；敏感内容先脱敏；**已标记为 recall 的上下文移除**——被召回的片段不会再被当作新记忆学一遍（防自增强循环）。

**Consolidation 安全（taint gate）**：进入整固 prompt 前，provenance 为 `untrusted` 或 `system` 的候选被**结构性排除**（不是扣分，是直接出局）；候选携带来源、会话种类、观察时间、可选 supersession key。

### 2.3 五大设计原则（原文，值得逐条抄进任何方案）

1. **No hidden state** —— 模型只记得写进工作区文件的东西；每个记忆面都能用文本编辑器检查。
2. **Writing is the hard part** —— 对笔记文件做检索足以和重得多的设计竞争；让记忆系统退化的是**不可靠的写入时策展**（引 LongMemEval, arXiv:2410.10813：写了什么比怎么索引更重要）。所以把策展**移出忙碌的回复路径**，放进专用后台 pass。
3. **The write path is the security boundary** —— 记忆内容级扫描不可靠地抓住投毒事实；在**写入时**强制 provenance、用结构门槛守晋级，而不是事后检测坏记忆。
4. **Deterministic gates, model judgment inside them** —— 打分、阈值、资格、匹配、生命周期全是确定性代码；LLM 只在真正需要语言判断的地方用，且始终在确定性代码划定的边界内。
5. **Failures never block replies** —— 回复路径上每个记忆步骤都有超时、回退或两者兼有；记忆子系统挂了只降低召回质量，**绝不吃掉一个回合**。

### 2.4 检索：双车道（Lane 1 零 token / Lane 2 子代理）

- **Lane 1（零模型调用、零延迟）**：
  - bootstrap 注入：MEMORY.md/USER.md 会话始加载，长会话按预算每轮刷新
  - `memory_search` 混合检索 = BM25(FTS5) + 向量（400 token/80 重叠分块）× 30 天半衰期新近衰减 × 写时一次性打的 importance(1-10)，再 MMR 去冗余
  - **trigger 注入**：策展层条目行尾注释 `<!-- trigger: 网关配置, 安全 -->`，每条入站消息跑词法+向量预筛，≥0.72 分注入为隐藏上下文块，每轮最多 3 条，**仅限策展层**（episodic 永不自动注入）
- **Lane 2（升级车道）**：消息显式表达回忆意图且 Lane 1 无强命中时，起**阻塞式 recall 子代理**跨会话翻 transcript——LongMemEval 证明时序/多跳问题恰是扁平检索最弱处
- **项目域记忆**：条目带 `<!-- project: github.com/... -->`（取 git origin remote），会话维护最近 4 个活跃 repo key 加权/降权——一码库学到的 build workaround 不会溜进另一码库

### 2.5 其他机制

- **溯源列（防投毒的结构手段）**：SQLite 索引给每条候选记 origin class（`owner`/`agent`/`untrusted`/`system`）+ session kind + 观测时间戳 + supersession key。模型无法通过散文改写自己的信任级别；untrusted/system 在任何 prompt 构建前就被结构性排除
- **两条卫生规则**：cron/heartbeat/subagent 会话不产生可晋升候选（生产审计发现自动捕获的"记忆"绝大多数是脚手架复述与心跳噪声）；被注入过的内容结构性标记、永不再提取（防 recall 回环）
- **MEMORY.md 重写用乐观并发**（内容哈希 + 原子 rename），preimage 存 DREAMS.md；compaction 前先跑 **memory flush turn** 把未写内容落地到当日笔记，压缩才不会抹掉知识
- **USER.md 原地 supersede**：偏好变更时替换条目（带 observed-date + active/superseded 元数据），不追加矛盾指令（依据 PrefEval ICLR 2025：偏好仅在上下文"存在"几个回合后就失效）
- **预算截断信号**：MEMORY.md 超预算时磁盘保留、注入截断，`/context list` 可看 raw vs injected
- **HEARTBEAT.md 已退役**（2026-08 文档现状）：心跳指令迁入 system-owned monitor 的 cron scratch；心跳本质 = 主会话里的周期性 agent turn（默认 30m），可开 isolatedSession/lightContext
- **Action-sensitive memories**：涉及审批/临时约束/交接/过期的记忆要求记录何时可安全行动（生效条件、解锁条件、过期时间、来源权威）——"记忆保存审批上下文，但不执行策略"
- 从 Codex / Claude Code / Hermes 一键导入记忆（放 `memory/imports/`，只索引不合并）

### 2.6 借鉴点与局限

**借鉴**：① 五层 tier 的"curated 常驻 / episodic 只检索"二分；② dreaming 三阶段 + 确定性三重门槛 + subagent 重写带验证回退——比 ai-memory 的 SessionEnd LLM 整固更成熟（多轮强化信号 + 查询多样性门槛）；③ "写入即策展、检索够用"的反共识定位（有论文支撑）；④ provenance taint gate（结构性排除而非评分惩罚）；⑤ 转写摄取的 recall 标记防自增强；⑥ 双车道检索 + 行尾注释元数据（零 token Lane 1 + 子代理 Lane 2）；⑦ 项目域隔离（project 注释 + 活跃 repo 加权）。

**局限**：代码量 ~53 万行，dreaming/心跳依赖常驻 Gateway，单机 CLI 场景拿不动整套；SQLite 索引是派生态、会漂移需 watcher/重建；门槛参数（thresholds/预算/supersession key）多，调参面大。

---

## 3. geneticagent → GenericAgent（"技能结晶"流派）

> 用户口述名的最接近实体：**GenericAgent**（lsdefine，MIT，Python，3.3K 行种子 + ~3K 行核心循环；拼写最近且思想吻合——技能树"生长/进化"）。备选解读：genesis-agent（Garrus800-stack，episodic memory + Obsidian vault + idle dreaming）。若用户另有所指可再调研。

### 3.1 核心思想：Skill Crystallization（技能结晶）

多数开源 computer agent 把每个任务当全新问题——LLM 探索、烧 token、会话结束洞见蒸发。GenericAgent 反其道：**一次成功的运行就是可复用资产**。

- 任务完成时，其 **plan + tool calls + 最终确认**序列化为 JSON 技能树里的命名技能
- 未来调用**先查树**：命中则最小化 LLM 参与、直接重放存储路径
- 效果：首次 20,000 token 摸出来的任务，重放几百 token
- 技能树本身是**可读、可检查的持久记忆**：工程师能读树、修剪腐烂技能、跨机晋升——黑盒向量库"记忆"做不到

### 3.2 分层文件记忆：L0-L4 五层

memory/ 目录按抽象度分五层（与"遗传/进化"直觉吻合：记忆是长出来的，不是预装的——哲学口号 "don't preload skills, evolve them"）：

| 层 | 内容 | 作用 |
|---|---|---|
| **L0** Meta Rules | 核心行为规则 | 行为约束 |
| **L1** Insight Index | **极简记忆索引** | 快速路由（检索的零 token 入口） |
| **L2** Global Facts | 长期稳定知识 | 事实层 |
| **L3** Task Skills/SOP | 可复用工作流（morphling_sop.md…） | 程序性记忆 |
| **L4** Session Archive | 完结会话蒸馏归档（2026-04 增） | 长程回忆 |

记忆专用工具仅两个：`update_working_checkpoint`（短期便签）+ `start_long_term_update`（蒸馏长期记忆）。上下文窗口压在 **<30K token**（对比其他 agent 的 200K-1M）——方法论是论文标题里的"contextual information density maximization"（上下文信息密度最大化）：与其堆窗口不如压密度。自称在 SOP-Bench/LoCoMo/20-skill 压力测试上"凝练分层记忆胜过全量/冗余记忆与 embedding 检索器"；跨任务自进化评估第 2/3 次执行收敛到稳定低成本区间。

### 3.3 定位与风险

模型无关（任意 OpenAI 兼容端点）、本地优先、MIT（作者 bendusy / lsdefine，arXiv:2604.17091，2026-01 V1.0）。building block 而非产品：安全面激进（真浏览器注入+系统级控制）、评测为自报、无遗忘/收敛机制——skill 树只增不减，长期膨胀由用户自担。

### 3.4 对 dsh 的意义

程序性记忆（procedural memory）的极致形式：**不是记事实，是记"怎么做"——成功执行路径结晶为一行可调用物**。与 dsh 已有的 skills 体系和 TencentDB 的 Skill 资产（版本/触发边界/执行步骤/验证规则）三方呼应：dsh 记忆方案的 procedural 层可以直接落在 skill 格式上。两个直接可抄的点：**L1 Insight Index**（在原始事件与完整技能之间加一层极简路由索引，零 token 检索的便宜实现）；**密度优先预算观**。代价：重放的前提是环境稳定（路径变了技能就"腐烂"，需要修剪——正好用 ai-memory 的衰减闭环治理）。

---

## 4. 意外高价值发现：dsh-evolve（专为 dsh 写的记忆插件）

> **github.com/chenzheshushi-commits/dsh-evolve**（2026-08-23 新建，MIT）——社区已有人为 DeepSeek Harness 写了自进化记忆+技能生命周期插件，与"演化式记忆筛选"思想完全对口，是 dsh 记忆机制的**直接参考实现**。

- **数据模型**：结构化记录（fact/preference/decision/lesson/todo/note；scope user/project；importance 1-3），**JSON 为源 + Markdown 镜像可手改**（人改 md 后同步回 JSON）
- **零 token 确定性检索**：bigram-Jaccard 与 SQLite FTS5 BM25 经 **RRF 融合**——无 embedding API、无每轮模型调用，CJK 分词正确（这对中文用户是硬需求）
- **分级审批门只看模型拍不了马屁的属性**：可逆性、与已确认记忆冲突度、重叠度、是否可溯源到用户原话；**刻意无视模型自报的 kind 字段**
- **强化而非重复写入**：同义复现提升 observation count 与 importance、保留更优措辞，暴露 low/medium/high 置信度
- **技能生命周期**：active → stale(30d 闲置) → archived(60d)，**永不删除**，每次变更前备份可回滚；project 记忆满强化后晋升 global
- **反膨胀收敛**：近重复检测、合并为伞形 skill、folding 压缩、2 万字符硬预算（超限只返回修剪候选、绝不静默丢弃）
- **后台 review**：隔离单发 LLM 调用，reviewer 只建议不直写，失败安全跳过
- **prune**：幂律冷度 `H=1/(1+λΔt)^α` 排序，时间基取 accessedAt 而非 updatedAt（防"改写冒充访问"）；pinned 三级保护、软删 tombstone、JSONL 审计、两段式 preview→execute 带原子 claim 与 ETag 乐观锁
- **无内部定时器**（外部 cron 调工具）；明确排除向量/语义检索/知识图谱（"对优化而言太重"）

---

## 5. 主流记忆层简述（Mem0 / Letta / Zep-Graphiti / Cognee）

### 5.1 Mem0（mem0ai/mem0，YC S24）

经典两阶段管线：LLM 抽取候选记忆 → 对相似旧记忆做 ADD/UPDATE/DELETE/NOOP 决策。**注意 2026-04 已改算法**：单遍 **ADD-only 抽取**（一次 LLM 调用、不再 UPDATE/DELETE、记忆只积累不覆写）+ agent 生成事实一等公民 + 实体抽取链接跨记忆 + 检索端多信号融合（语义+BM25+实体匹配）+ 时间感知检索。LoCoMo 92.5 / LongMemEval 94.4，~7K token、~1s 延迟。**这个转向本身就是结论：写时决策 LLM 调用贵且不稳，宁可写松、检索端融合收紧**——与 OpenClaw"写是难点、要用确定性门+离线做"殊途同归。

### 5.2 Letta（原 MemGPT，arXiv:2310.08560）

注意 letta-ai/letta 主仓库已成 landing page，活跃代码在 **letta-ai/letta-code**。经典分层：core memory（in-context、可自编辑）+ recall storage（会话史）+ archival storage（向量库）；sleep-time compute（arXiv:2504.13171，现叫 dreaming）。letta-code 新要素：`/sleeptime` 周期做梦、`/doctor` 记忆质量审计、内置 recall/history-analyzer 子代理；**MemFS——全部上下文（含 memory blocks）用 git 跟踪，可 sync 到 GitHub 私有仓库**；agent 可重写自己的 memory/skills/prompts 甚至 harness。**记忆的 git 版本化与可审计（MemFS）是全场最值得偷的单点设计**。

### 5.3 Zep / Graphiti（getzep/graphiti，arXiv:2501.13956）

时序知识图谱引擎（开源核心 Graphiti，商业平台 Zep）。**双时态模型**：每条事实同时记"世界有效性窗口"（valid_at/invalid_at）与"系统摄取时间"——事实变化时旧边**失效而非删除**，既可查"现在为真"也可查"任一时点为真"。结构：实体（带演化摘要）+ 关系三元组（带有效窗口）+ **episodes（原始摄取数据，一切派生事实的溯源底账）**。检索 = 语义 + BM25 + 图遍历混合。**invalidate-not-delete + episode 溯源**与 OpenClaw 的 supersession key 是同一洞见的图版实现；代价是图数据库 + 每 episode LLM 抽取的重基建。

### 5.4 Cognee（topoteretes/cognee，arXiv:2505.24478）

开源记忆平台：任意格式摄取 → 自建知识图谱 + 向量嵌入，`add → cognify → search` 的 dataset 式 API。本质是"**编译派**"：记忆 = 对原始语料跑一次编译管线产出派生索引——与第一轮 ai-memory 编译派同一谱系，适合作为 dsh 的可选重型后端（有官方 OpenClaw 插件先例）而非内核。

---

## 6. 两轮调研综合结论（对 dsh）

### 6.1 三派画像

| 派系 | 代表 | 记忆形态 | 前提 |
|---|---|---|---|
| 文件式+轻索引 | OpenClaw / Hermes / GenericAgent / dsh-evolve | 人可读 Markdown + SQLite FTS5（可选向量） | 零常驻服务、可 git、可手改 |
| 服务式 | Mem0 / Letta cloud | API/daemon 持有，写时 LLM 决策，检索融合 | 常驻服务 + API 预算 |
| 知识图谱派 | Graphiti / Cognee | 时序三元组 + episode 溯源 | 图数据库 + 每 episode LLM 抽取 |

### 6.2 裁决

对"单机 CLI agent + jsonl 事件流 + dsh 插件体系"，**文件式 + SQLite 轻索引是唯一合身的内核**：

1. 单机没有常驻 Gateway 供 dreaming/心跳挂靠（服务式前提缺失）
2. **dsh 的 jsonl 事件流本身就是现成的 episodic tier + episode 底账**——OpenClaw transcript ingestion、Hermes state.db、GenericAgent L4、Graphiti episodes 四家同构，dsh 白得这一层
3. dsh 插件体系恰好对应 OpenClaw memory 插件槽与 Hermes provider 机制——KG/向量可以后挂插件，不烧进内核

第一轮"ai-memory 编译派为主"的结论**被本轮强化**：OpenClaw dreaming、dsh-evolve crystallize、Mem0 ADD-only、Cognee cognify、Letta sleep-time 全是"原始事件 → 离线编译 → 策展产物"同一模式。**本轮增量是补上了编译的门与方向**：确定性门（溯源/预算/重复/冲突）在前，有界 LLM 整理在后，产物是文件而非库。

### 6.3 落地骨架（融合两轮，v2）

1. **四层**：jsonl 原始事件（不可变，episodic + provenance 底账）→ SQLite FTS5 索引（纯派生态，可随时重建——"canonical 在文件、索引可丢"）→ 策展核心 `MEMORY.md`/`USER.md`（祈使指令 + 就地覆写 + 行尾 trigger/importance 注释）→ skill/SOP（程序性记忆：GenericAgent 式结晶 + dsh-evolve 式生命周期）。SOUL.md 类人格文件可选，占系统提示词第 1 槽、只从固定 HOME 加载
2. **写路径**：每轮结束的隔离 review（可路由便宜模型、digest 回放、reviewer 只建议）→ 确定性审批门（无视模型自报分类；查可逆性/冲突/重叠/是否锚定用户原话；工具输出与子代理产物标 untrusted 结构性禁入策展层）→ staged 或直写；**同轮报错驱动整理（Hermes 式硬预算）兜底无后台场景**
3. **读路径**：会话始注入冻结快照（保前缀缓存）+ 每步零 token 检索（BM25 × 新近衰减 × 写时 importance + trigger 注入，仅策展层可自动注入）+ 回忆意图触发时子代理查 jsonl（dsh 已有 subagent 能力，Lane 2 现成）
4. **遗忘**：复现强化不重复写入；幂律冷度只排候选；人工显式修剪（软删 tombstone + pinned 保护）；永不静默删除；变更前备份；**git 版本化整个记忆目录（Letta MemFS 思路）**
5. **记事性记忆单列**：时间意图编译成 cron/定时器、事件意图编译成确定性 prefilter 的 intent 记录，绝不存散文（TriggerBench：散文意图几乎必失）

---

## 附：调研方法与可信度

- Hermes：本机 `/root/.hermes/` 真实安装 + 完整源码解剖（run_agent.py / tools/memory_tool.py / plugins/memory/*），非文档转述
- OpenClaw：docs/concepts 原文（memory.md / dreaming.md / memory-architecture.md @ main）
- GenericAgent / dsh-evolve / Mem0 / Letta / Zep / Cognee：子代理经 raw.githubusercontent.com + GitHub API 核实（2026-08-26 快照）
- 交叉验证：Hermes 本地源码逐条证实子代理论断（冻结快照/超限报错/注入扫描/精确去重/§分隔）；OpenClaw↔Hermes 同源关系有本地迁移脚本实证
- 第一轮（research-memory.md）：ai-memory / OpenViking / TencentDB-Agent-Memory；其中 OpenViking 在 Hermes provider 列表复现，互证生态位

---

## 附2：dsh-evolve 已安装（2026-08-26 09:20）

- 版本：v0.4.2（tgz pin 安装，不追 main），feishu profile
- 命令：`dsh plugin --profile feishu add ".../dsh-evolve-0.4.2.tgz"`
- peer 依赖警告（react ^18.2）仅影响 web 设置界面，headless feishu 不受影响；核心 lib 无 react 加载验证通过（10 工具 + evolve-protocol systemPrompt 段）
- 存储域：`~/.dsh/`（evolve-workspace，JSON 源 + Markdown 镜像 + node:sqlite FTS5）
- 默认配置未改：autoConfirm=true、review 每 5 轮、Tier1 2200 字符、注入 ≤1200 字符 ×3 条、记忆预算 20000 字符
- 首轮观察点：bridge.log 应出现 evolve 工具注册；记忆为空白出厂，需对话喂养
