# INCIDENT 2026-09-14 — GPT 满额不切 GLM（第二幕：同 provider 非默认模型）

## 现象（用户报告）
"gpt 满额后还是没有自动切换到 glm。"

09-13 的三连修复（c99b3f7 双向切换 / a3ce072 401=额度 / b2ad7a3 不回切）全部
已提交且桥进程（10:05 启动）已运行新代码，但 fallback 仍不触发。

## 证据链
1. `bridge.out.log`：三次 `fallback: quota source is not a configured
   primary/backup model — staying in wait mode`（分类成功、路由失败）。
2. 解码故障会话 `session-cbbe4b44`（逐帧解 zstd，8366 帧）的 request/context：
   - `glm_coding/glm-5.3`（启动默认）
   - **`codex-gpt/gpt-5.6-sol` @02:29**（用户切到 GPT 的 sol 模型干活）
   - `glm_coding/glm-5.3` @03:23（满额后用户手动切回——自动切换从未发生）
3. settings.yaml 注册表：codex-gpt 下有 luna/sol/terra/astra 四个模型；
   glm_coding 下有 5.3/5-turbo/4.7/4.5v/4.6v。
4. 旧 `#routeFor`：`#same(current, primary) || #same(current, backup)` 要求
   provider **和** model 双全等；fallbackBackup 只配了 `gpt-5.6-luna`。
   会话跑在 sol 上 → 两边都不等 → routeFor=null → 永不切换。

## 根因
额度是**账号级**的（codex-proxy 登录 / GLM coding 套餐）：GPT 满了，sol/luna/
terra/astra 一起满；GLM 满了，5.3/4.7/5-turbo 一起满。配对却按精确
provider+model 全等——用户只要不在"配置里那一个模型"上，安全网整体失效。
诊断盲点：warn 文案只说 "not a configured model"，不带实际模型对，导致第一幕
修复（401 分类）之后误以为问题已闭环。

## 修复（b?/2026-09-14）
`#routeFor` 改为 **provider 级路由**：`current.provider === primary.provider`
即算 GLM 侧（takeover=backup canonical pair），等于 backup.provider 即算 GPT
侧（takeover=primary canonical pair）；`limited` 记录**实际耗尽模型**（橙卡文
案准确），takeover 仍切到配置的 canonical pair。第三方 provider 维持纯等待。
`#onTakeoverSideError` 的"用户切回受限侧"判据同步放宽到 provider 级（切回该
侧任何模型都是回到受限通道）。warn 日志带上实际模型对。

## 测试
test/autocontinue.test.mjs 新增 3 例：
- sol 上的 401 → 切 glm-5.3（复刻本次事故，回归锚点）
- glm-4.7 满额 → 切 gpt-5.6-luna（对称成立）
- 第三方 provider 满额 → 仍不切换（维持等待老行为）
全套 40/40 PASS；hardening PASS；scenario.mjs 失败为预存问题（干净 HEAD 同样
失败，与本次无关）。

## 部署
桥经 profile cordis.patch.yml 以绝对路径 `file:///D:/qjcNetDiskDownload/
dsh-feishu/src/index.js` 直载仓库 src——改完只需重启进程（飞书 `/restart`，
或一次性延迟任务 recycle），无需拷贝同步。
