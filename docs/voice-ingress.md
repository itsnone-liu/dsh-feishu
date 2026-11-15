# 语音入口（voice ingress）

把**语音转写**当作一条飞书消息投进同一个会话：用户按键说话 → ASR → 本模块 → 与打字
完全相同的 dsh session（同一份记忆、同一套工具、同一份权限）。

## 为什么在桥里做

会话的持有者是桥（`driver.ensure` / `driver.submit`），第二个进程接同一个 session 会踩
并发与状态一致性问题。实测（见 ai-passport-hardware 仓库 `docs/dsh-brain-probe.md`）：

| 路径 | 首字 | 流式 |
|---|---|---|
| `dsh --profile headless --json` | 1.9 s（预热后） | ❌ 只在**步**边界吐整块 |
| 桥的 `session/event` | 同会话、零启动 | ✅ 有 `assistant/chunk` 的 `text-delta` |

所以桥不只是"省 3 秒启动"，它是**唯一**能边生成边播的路径。

## 协议

本机 unix socket，一行一个 JSON：

```
client → {"id":1,"op":"ask","text":"今天天气怎么样"}
client → {"id":1,"op":"cancel"}          # 打断：停止生成
client → {"id":1,"op":"ping"}            # 只读探活

server → {"type":"ack","id":1,"sessionId":"session-…"}   # 新会话可能为 null
server → {"type":"delta","id":1,"text":"今天"}            # 只转发正文，不含 reasoning
server → {"type":"done","id":1,"cancelled":false}
server → {"type":"error","id":1,"message":"…"}
```

## 配置

```json
"voice": {
  "enabled": true,
  "chatId": "oc_…",                       // 语音落进哪个会话（= 用户日常那个）
  "openId": "ou_…",                       // 必须在 allowedOpenIds 里
  "socketPath": "/root/.dsh/feishu/voice.sock"
}
```

`enabled=false` 时只打一行日志，不起 socket。改动配置需要 `/restart`（桥内不能自重启）。

## 三个容易静默失败的点（都已在代码里处理）

1. **`openId` 白名单**：`router.js` 会丢弃非白名单发送者，合成 sender 会表现为
   "ack 正常、然后永远没有回复"。默认取 `allowedOpenIds[0]`，不在白名单当场报错。
2. **`reasoning-delta`**：与 `text-delta` 同构，必须按 `block-start` 的 `blockType` 过滤，
   否则会把模型的内心独白念出来。
3. **并发**：同一时刻只接受一个 ask，第二个回 `busyWith` 而不是静默排队。

## 测试

```bash
node --test test/voice_in.test.mjs      # 9 个，纯 fake，不需要飞书/dsh
node test/voice_scenario.mjs            # 沙箱 E2E：真实桥进程 + mock transport/agent
```

沙箱注意两点（脚本里已处理）：仓库的 `profile/` 模板指向 `dsh-agent-presets@rc.8`，
与 0.2.1 不兼容，所以沙箱**复制生产 profile**；`@deepseek-ai/*` 从 profile 目录向上解析，
沙箱需要 `$DSH_HOME/profiles/node_modules`（符号链接到已安装的那份，不重装）。

## 回滚

`voice.enabled=false` + `/restart`；或 `git revert` 对应提交后 `/restart`。