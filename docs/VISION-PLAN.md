# 识图方案：从"整会话切视觉模型"到"外挂识图工具"

> 参考：[Scorp1o117/dsh-tool-vision](https://github.com/Scorp1o117/dsh-tool-vision)（MIT，已克隆到 `D:\qjcNetDiskDownload\dsh-tool-vision` 做过代码级研读）

## 现状（V0.2 的做法）与问题

现状：用户发图 → 若当前模型不声明图片输入 → 拒图卡（一键切换按钮）→ 切到 `glm-4.5v`（整会话）→ 重发图片 → 图片作为 user message 内容直达模型。

问题：

1. **整会话降级**：glm-5.3（200k 上下文、coding 强化）→ glm-4.5v（64k、通用视觉），识一张图的代价是后续所有回合都在弱模型上跑。
2. **两次往返**：切模型 → 重发图，用户操作多。
3. **能力声明的脆弱性**：识图完全依赖 settings.yaml 的 `input` 声明与端点真实能力一致——上午事故（glm-5.3 谎报 → 1210 连挂 8 回合）就是这类脆弱性的直接体现。

## dsh-tool-vision 的核心思路（值得借鉴的部分）

读完 `index.js` + `lib/vision-tools.js`（2481 行），关键设计：

1. **`inspect_image` 系列工具**：把图片发给任意 OpenAI 兼容 `/chat/completions`（`image_url` 内容分片），把视觉模型的**文字回答**带回主模型上下文。主模型完全不用换。
2. **不动持久日志不变量**：DSH 强制 `llm/stream` 请求与持久会话日志的推导一致（agent-loop 不变量）。dsh-tool-vision 因此把图片桥接放在 `agent/pre-step` 瀑布（唯一能替换入日志消息的缝隙），并明确说"模型的 `inputModalities` 声明不可信，因为 profile 常常为了过准入检查乱声明"。
3. 全局工具层注册（`ctx.tools.register`），纯对象定义（JSON-Schema parameters + `output:{schema,render}` + execute 返回规范值/抛错），字符串输出用 `stringOutput = {schema:{type:'string'}, render:(_,v)=>[{type:'text',text:v}]}`。
4. 请求体像素预算（约 400 万像素 downscale）、内容安全拒绝单独分类、失败语义写进 description（"不要换个问法重试"）。

**不能直接整包挂载的原因**：它 `inject = ['tools','llm','attachments','webServer']`，而 feishu 桥 profile（dsh-base + agent-presets + feishu-bridge）**没有 webServer 服务**——直接挂载会让桥起不来（正是"接入出错让桥瘫痪"这一类风险的翻版）。它的 pre-step 图片桥接、WebUI 设置面板对本桥也都是多余件。

## 本桥的落地方案（V0.3 已实现）

**`src/vision-tool.js`：`inspect_image` 工具**，借鉴上述思路的最小实现：

- 主模型保持 glm-5.3；识图 = 一次工具调用 → coding 端点 glm-4.5v → 文字回答回上下文。
- 飞书图片现有链路不变（attachment 落盘 → agent 拿到本地路径），`inspect_image(file, question)` 直接吃本地路径（也支持 http URL）。
- 默认配置即生产可用（`GLM_API_KEY` + coding 端点 + glm-4.5v），可用 config.json `vision` 段覆盖或 `false` 关闭：

```json
"vision": {
  "baseURL": "https://open.bigmodel.cn/api/coding/paas/v4",
  "apiKeyEnv": "GLM_API_KEY",
  "model": "glm-4.5v",
  "maxTokens": 1024,
  "timeoutMs": 60000
}
```

- 失败语义（写进工具 description）：鉴权/限流/超时不要换姿势重试，向用户说明识图暂不可用——防止上午那种连环失败回合。
- 有向 e2e：请求体形状、`image_url` 分片、鉴权头、HTTP 错误文本都过单测（mock fetch，零真实调用）。

**与 V0.2 原生路径共存**：

- 快速路（推荐，默认）：发图 + 问句 → agent 自动 `inspect_image` → 直接得到分析。无需切模型。
- 原生路（保留）：仍可 `/model glm-4.5v` 整会话切换，适合连续多图的深度视觉会话；拒图一键切换卡不变。

## 后续可选升级（未做，按需）

1. **图片直答**：glm-4.5v 的回答质量不够时，`vision.model` 换更强端点（如 GLM-4.6V 或其他厂商兼容端点），只改 config 一行。
2. **多图对比**：扩展 `inspect_image` 接受 `files[]`（1–4 张，dsh-tool-vision 已验证该模式）。
3. **像素预算**：当前依赖发图前的 attachment 限制（8192px/10MB）；如遇 413/超时可加 downscale。
4. 若未来 DSH 桥 profile 提供 webServer，可评估整包挂 dsh-tool-vision 换取 14 个像素级工具（OCR/grounding/截图）。

## 结论

可以参考、且已经参考落地：**保留其"工具外挂 + 不动日志不变量 + 失败不盲试"三个核心设计，舍弃其 webServer 依赖与 pre-step 桥接**（本桥图片已走 attachment 落盘，无需 pre-step 改写）。
