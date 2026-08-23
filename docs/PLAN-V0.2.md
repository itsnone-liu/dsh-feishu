# dsh-feishu V0.2 完整实施方案

> 负责人：dsh 主 agent（本文档作者）实施除 research 外的全部内容。
> 配套文档：`research/BRIEF.md`（Codex 独立执行的调研方案，含接口契约）。
> 基线：V0.1 识图模式已合入（commit `6146a2f`，离线 e2e 4/4 通过，桥已重启运行）。

## 1. 目标

把飞书机器人从「能识图」推进到 **V0.2 完整可用**：

- 识图体验收尾（诊断命令、一键切换识图模型、连发图片合并）
- 文件（非图片）消息可用
- 群聊 @ 触发可用
- 长输出转文件 + 卡片更新限速保护
- 会话被占用时的友好报错
- 文档 / 版本 / 回归测试齐备

## 2. 分工与依赖

| 角色 | 负责 | 交付物 |
|---|---|---|
| **Codex**（独立进行） | R1 GLM 视觉模型事实核查、R2 飞书能力矩阵 | `research/*.json`（按 schema）+ 探针脚本 |
| **dsh 主 agent**（我） | P0–P5 全部实施 + research 成果集成 + 测试 + 提交 | 代码 / 测试 / 文档 |
| **用户** | 飞书控制台开权限（im:resource、群聊、im:file）、真机走验收清单 | 控制台操作 + 真机反馈 |

依赖关系：**P4（长输出转文件、卡片限速参数）依赖 R2**；settings.yaml 中视觉模型 contextWindow 等参数的校正依赖 R1；P1–P3、P5 与调研完全并行。

## 3. 阶段计划

### P0 方案与骨架（本步完成）

- 本文档 + `research/BRIEF.md` + `research/schema/*.schema.json`
- `research/out/`（探针结果目录，gitignore）+ `tools/apply-research.mjs` 骨架
- `.learnings/` 记录本会话已踩坑（PS5.1 编码、进程输出死锁、URL→路径、mock 步骤优先级）
- **验收**：文档合入 git；schema 可被 JSON.parse。

### P1 识图体验收尾（无外部依赖）

1. **`/doctor` 命令**：一张诊断卡片，逐项检查——
   - 当前会话模型是否识图（`/model` 列表 📷 依据同一数据源）
   - 附件服务可用性：内嵌 1×1 PNG 走一次真实 `saveImages`（结果进 attachments，无害）
   - 传输模式（sdk/lark/mock）、WS 连接状态
   - 飞书权限清单：无法服务端探测的项（im:resource、群聊 scope）输出「请到控制台核对」条目
2. **识图被拒卡片加一键切换按钮**：卡片 action 走现有 `value.bridge` 分发（ask/approval 同通道），新增 `bridge: 'model'` 动作 → `driver.setModel` → 绿色确认卡。列出所有 📷 模型按钮（≤3 个）。
3. **连发图片合并窗口**：`imageBatchMs`（默认 1500，0=关闭）。窗口内的连续 image 消息合并为一个回合（上限 `min(模型 maxImages||5, 9)`）；窗口内来 text 消息立即冲队并作为说明文字。实现于 router 的 per-chat 待发队列。
- **验收**：mock e2e 新增断言——连发 2 图 1 文字 → 单回合「附图 2 张」；doctor 卡片各 ✅；按钮点击后 `/status` 显示新模型。

### P2 文件（非图片）消息

- 传输层：`message_type === 'file'` → `messageResource.get`（type=file）→ 字节落盘 `<cwd>/.feishu-files/<yyyymmdd-hhmmss>-<name>`（名称清洗，10MB 上限，防路径穿越）。
- 不进附件服务（其只有 saveImages）：改为**文字通知 agent**「收到文件 <name>（<size>，<扩展名>），路径 <path>」。文本类文件提示 agent 可直接读；二进制提示可用对应工具。文本模型即可用，与识图解耦。
- **验收**：mock e2e 发 .py 文件 → agent 收到含路径的说明；真机发 csv → agent 读出表头。

### P3 群聊 @ 触发

- 配置 `groups: 'off' | 'mention'`，**默认 off**（fail-closed，与 open_id 白名单同哲学）。
- `chat_type === 'group'` 且 mode=mention：事件 `mentions` 数组含 bot 的 open_id 才响应；剥离 `@_user_N` 占位符后取剩余文字；发送方 open_id 仍须在 allowedOpenIds。
- bot 自身 open_id：启动时经 `bot.info` API 取一次并缓存（R2 若给出更优获取方式则采用）。
- 回复：向群 chat_id 发卡片（与私聊同 API），卡片 note 里 @ 发送者。
- **验收**：mock e2e 模拟 group 事件（带 mentions JSON）→ 未 @ 不响应、@ 后响应；真机拉群验证。

### P4 长输出转文件 + 卡片限速（依赖 R2）

- 正文 > 3000 字：卡片截断 + 尾注「完整内容见附件」，经 `im/v1/files` 上传纯文本后发文件消息。参数（大小上限、scope、接口细节）全部取自 R2；R2 未交付前先上线保守截断（不阻塞）。
- 卡片更新限速：以 R2 的 `cardPatchRateLimit` 校准 `throttleMs`（当前 40ms），patch 429/失败时指数退避 + 丢弃中间帧（renderer 已以 `assistant/message` 快照落定，丢帧安全）。
- **验收**：mock e2e 长文本回合卡片含截断标记；真机长输出收到文件。

### P5 会话占用 + 发布

- driver 附着失败若为「会话正被其他进程使用」类错误 → 专属卡片（提示 WebUI 占用、`/resume` 或关闭另一端）。
- README / SKITCH 更新、version 0.2.0、全量回归、清理 `已知限制` 中已完成项。

## 4. Research 成果集成方式（我方）

`tools/apply-research.mjs`：

1. 读 `research/glm-vision-models.json` / `feishu-capabilities.json`，逐条按 schema 手写校验（无 ajv 依赖）；**校验失败即整体拒收并打印首个字段错误**。
2. R1 → 合并进 `C:\Users\pc\.dsh\settings.yaml` 的 `glm_coding.models`（只覆盖 `contextWindow` / `maxOutputTokens`，新增带 `recommended` 的模型行；**绝不**把 `input` 改成超出事实的值）。YAML 依赖经 `createRequire` 从 `DSH_ROOT`（默认 `D:\dsh-install`）解析 js-yaml（已验证仅该处可解析）。
3. R2 → 生成 `research/out/applied.json`（P4 参数快照），代码从该文件读限速/上传参数，缺省回退保守值。
4. 与基线冲突的字段（`conflictsWithBaseline`）打印给用户人工裁决，不自动覆盖。

## 5. 测试与质量门槛

- **离线**：`test/image-mode.ps1` 扩展为 `test/e2e.ps1`（≥10 断言：图片单发/连发合并/拒图按钮/doctor/文件/群聊@/未@静默/长文本截断/占用报错/model 列表）。全程 mock 传输 + mock agent，不碰真实凭据。
- **真机清单**（用户）：① 开 im:resource 后 glm-5.3 发图 → 拒图卡片带按钮 → 点击 → 复发图成功；② 连发 3 图合并；③ 发 .py/.csv；④ 拉群 @ 问答；⑤ 长输出收文件；⑥ `/doctor` 全绿。
- **DoD**：e2e 全绿 + 真机清单全过 + README 更新 + git 干净 + 版本 0.2.0。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| coding 端点视觉支持可能未文档化、随时收紧 | R1 核实；1210 错误卡片已给出切换建议，P1 按钮化 |
| 卡片 patch 限速未知，流式更新可能被限流 | R2 核实；renderer 快照落定保证丢帧安全 |
| 群聊/文件上传需用户开新 scope | `/doctor` 列出待开权限清单 |
| Codex 交付 schema 漂移 | apply-research 严格校验拒收，冲突字段人工裁决 |
| 文件消息恶意文件名 | 清洗 + 拒绝 `..`/绝对路径 + 10MB 上限 |

## 7. 里程碑

P0（今日）→ P1 → P2 → P3 →（R1/R2 到手后）集成 + P4 → P5 发布 0.2.0。
