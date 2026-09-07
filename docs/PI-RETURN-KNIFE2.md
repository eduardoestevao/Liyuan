# 回归 pi · 第二刀落地记录

2026-09-07。按本轮批准的执行计划 §5.3、§8，第二刀完成 **pi 0.80.3 → 0.84.4**。第一刀已经把主演生成与工具循环交回 `AgentSession`，本刀升级运行时并保留这套接线。**没有新增面向 RP 主演的工具，也没有修改 RP 提示词、注入通道或卡作者措辞识别。**

实施时 Git 起点为 `8229365`，第一刀与第二刀当时均未单独提交；2026-09-08 已与第三刀、上一拍修订一起归档为 **`1a3142d`**。本刀对照基线是第一刀完成后的工作树，而不是 Git HEAD：升级前将 2,705 个文件、40,585,849 字节快照到本机 `_pi-upgrade/before/`，并保存 SHA-256 清单。

## 升级内容

官方来源是 pi `v0.84.4`，tag commit 为 `b79e4cc834970cca69daebffab7df1da7d1e52c4`。以官方 `v0.80.3` 为三方合并基线，保留梨园改动；本机另一个版本号仍写 0.80.3 的 pi checkout 含有后续提交，不能当作该 tag 的替代品。

以下七个本地包均为 **0.84.4**，继续使用 `@liyuan/*` 命名与 `file:` 依赖：

| 包 | 本刀处理 |
|---|---|
| `@liyuan/ai` | 升级 provider、模型目录与类型 |
| `@liyuan/agent-core` | 升级原生循环与 harness |
| `@liyuan/tui` | 同步运行时依赖 |
| `@liyuan/agent-runtime` | 升级 coding-agent 与宿主 API |
| `@liyuan/telemetry` | 新增上游所需依赖 |
| `@liyuan/protocol` | 新增上游所需依赖 |
| `@liyuan/client` | 新增上游所需依赖 |

TypeBox 升为 **1.3.7**，OpenAI SDK 升为 **6.40.0**。梨园名称、`.liyuan` 配置目录、未打包的 CLI/RPC 入口保留。移除上游发布用的 `npm-shrinkwrap.json` 和 `install-lock/`，避免它们把本地依赖重新指向已发布的 pi 包；安装以根 `package-lock.json` 为准。

### 宿主 API 适配

- `AgentSession.modelRegistry` 改用 `session.modelRuntime`；扩展中的 `ctx.modelRegistry` 仍然有效，不能一并替换。
- 模型选择、可用目录、provider 信息、鉴权和旁路请求改走新的 ModelRuntime 接口。持久鉴权使用 `login(..., "api_key", ...)` / `logout()`。
- 配置加载、保存、渠道增删改、配置启用、鉴权变更及启动重绑，均等待异步刷新完成后再返回结果。
- 旁路请求保留鉴权解析出的 endpoint、环境与可为空的 header；宿主通过 `modelRuntime.streamSimple()` 发起。
- 原生 Agent 的可写属性改为 `streamFunction`；构造参数仍叫 `streamFn`。等待空闲改用会话级 `waitForIdle()`。

### 保留的梨园语义

第一刀的临时过程消息 `persist: false`、`appendMessage()`、`setLeaf()`、`reuseUserMessage` 和 `SessionManager.flush()` 已与新版实现合并。过程仍留在本次原生工具循环中，定稿与媒体才进入 RP 历史；重生成不重复追加 user。新版对消息替换的规范化也继续保留。

停止继续清理待处理输入、终止工具后的续轮，并保留已有的 8 秒兜底；等待对象适配到新版会话级 settlement，计时器及时清除。没有用新版默认中断行为覆盖梨园的 Stop 约定。

模型配置的梨园差异迁入新版的 `model-config.ts` / `provider-composer.ts`：

- 自有 endpoint 加非空模型目录，替换同名内置目录；只覆盖 endpoint 时仍继承内置目录。
- 显式 `thinkingLevel`（包括 `off`）保留思考档控制，但显式 `reasoning: false` 优先。
- `streaming` 开关、各层模型覆盖，以及自定义 OpenAI-compatible 默认使用 `max_tokens` 的行为保留。
- Anthropic、OpenAI Completions/Responses、Google/Vertex 的非流式兼容与上游请求重试合并；既有 DeepSeek 判断不扩名单。

## 两项计划假设的修正

**现有会话不需要转成 v4。** 0.84.4 的 coding-agent 仍使用 **v3 JSONL `SessionManager`**，梨园走的就是这个入口。v4 `SessionRepo` 变更属于另一套 agent-core harness API，不能套到当前卡会话上。本刀没有转换真实用户会话。

**内部流事件没有变成只含 delta。** 新版削减累计消息的是 JSON/RPC 序列化输出；内部 Agent/扩展的 `message_update` 仍有累计消息。梨园原有消费者继续取内部增量并转发，未增加一次无必要的流协议重写。

新增的 `agent_settled`、工具终止、`defaultTools`、`AGENTS.override.md` 等原生能力已随升级可用并作专项验证。原生可选 PowerShell 工具属于 runtime 能力；本刀没有把它或新的计划、正文、探索工具接入 RP 主演。

## 构建与分发

新增 `scripts/build-runtime.mjs`，按依赖顺序检查、编译全部七个包。输出先写入 `.liyuan-cache/runtime-build/`，所有选中包通过类型检查后才替换 dist；同步模型数据、主题和导出资源，清掉已移除模块的旧产物。根 TypeScript 配置改用 ES2024，以支持新版 Unicode `v` 正则。

源码归档不含生成后的模型 JSON，本刀从同版本官方 npm 包补齐 **40 份模型数据（含 manifest）**。原有通用 `data/` 规则会同时漏掉这些产品文件，因此补齐：

- Git 与 Docker 对这两个明确的产品目录放行：`packages/ai/{src,dist}/providers/data/`。
- 发布脚本保留原有用户数据排除，再单独复制模型目录中的 JSON；ZIP 检查要求源码与运行目录均有 manifest，且文件集合相同。

以 Git 可跟踪文件创建干净副本，离线 `npm ci --ignore-scripts` 安装 **352 个包**，完整构建七个包成功。重新生成的 **2,029 个 dist 文件与当前目录逐字节一致**；CLI `--version` 返回 0.84.4。另用真实发布函数生成本地测试 ZIP，**2,047 个条目**通过分发检查，源码与 dist 的模型数据各 **40 份**且哈希一致。没有发布该 ZIP，也未执行完整 Docker 构建。

```powershell
npm ci
npm run runtime:build
npm test
```

本次执行环境为 Node 24.14.1。离线安装验证使用本机已有依赖缓存并跳过安装脚本；它不等于验证所有平台的原生依赖安装。

## 验证结果

| 检查 | 结果 |
|---|---|
| 梨园全量测试 | **689 项，687 通过，2 项既有失败** |
| 其中：真实 AgentSession + RP 扩展集成 | **26/26** |
| runtime 会话、鉴权、模型兼容等专项 | **186 项，185 通过，1 项既有失败** |
| AI 流式/非流式兼容 | **8/8** |
| 新原生能力定向检查 | **10 通过，0 失败**；同批未选中的 40 项跳过 |
| 隔离服务 HTTP | **14 次请求通过** |
| 七包完整构建、干净副本离线安装与重建 | 通过 |
| 发布暂存树与本地 ZIP | 通过 |
| 源码冲突标记、活动路径的旧 namespace、source map 与模型资产检查 | 通过 |
| 原始卡与配置对照开工前 ZIP | **497 个文件 SHA-256 一致** |
| `git diff --check` | 通过 |

全量测试的两项既有失败：

1. `实卡: first_mes/备选开场白 一律 html 皮肤、零 status 段`
2. `实卡：初值只写在 schema prefault 里的卡能被播种`

runtime 的既有失败为 `should queue extension-origin steering messages while streaming`，与第一刀对 HEAD 的对照结果相同。

本刀新增六项模型配置兼容回归；另外调整了上游测试中与梨园既有语义冲突的断言：自有目录替换内置目录、中断后不继续发起模型请求。用于验证“继承目录”的夹具移除 endpoint，避免误触替换规则。测试会话目录保持隔离。不能把这些结果描述为“全部上游断言原封不动”，也未运行整套上游测试。

HTTP 检查包含启动、配置、模型、卡、配置列表，以及渠道创建/编辑后目录即时更新、鉴权持久保存/删除和渠道删除。

### 真实模型五拍

沿用第零步与第一刀条件：同卡、同一本独立挂载的内嵌世界书、无用户预设、`/greeting 1`、原五条输入、ask 选第一个选项。主演 `cpa-my/claude-opus-4-6-thinking`，思考档 low，context 1,000,000、maxTokens 32,000；场记 `claude-sonnet-4-6`，off。

数据读取落盘消息的 `details.rpTimeline[]`，核对 JSONL 行内 timestamp，以北京时间解释。

| 拍 | 耗时秒 | 思考字 | 正文字 | 工具 | 场记快照 |
|---|---:|---:|---:|---|---:|
| 1 | 103.9 | 395 | 1290 | lorebook_search ×3 | 1 |
| 2 | 231.0 | 573 | 1249 | ask、lorebook_search | 1 |
| 3 | 154.8 | 861 | 1310 | lorebook_search ×2 | 1 |
| 4 | 102.6 | 1637 | 1518 | lorebook_search ×2 | 0 |
| 5 | 106.8 | 1048 | 1691 | 无 | 1 |
| 合计 | **699.1** | **4514** | **7058** | **9 次，其中 ask 1 次** | **4** |

五拍均正常交稿，每拍各一次 start/end，无报错；正文均为 user 的直接子节点，没有过程消息重复落树。场记五次均调用完成；第 4 拍没有非空补丁，没有解析失败或叶守卫丢弃，其余四拍落盘。五拍仍然 **5/5 直出**。

第一刀对应 562.7 秒、5667 思考字、9453 正文字、8 次工具。这些是单次随机样本，不能据耗时、字数或工具次数差异判断升级提高或降低了演出能力。

### 重生成、停止与会话切换

- Opus 重生成成功，产生两个回复变体，user 数量不增加。
- Opus 的半拍停止、新项目生成后停止通过：每次只发一次结束，保留已输出正文，跳过场记。
- 生命周期日志确认旧项目 `session_shutdown` 后连接为 0，新项目运行时只有 1 个连接。
- 同项目新会话创建与半拍停止以 Sonnet/off 完成，仍只发一次结束、保留半拍正文、跳过场记。

**实弹期间共遇到三次 Opus 网关 HTTP 504**：首次重生成、补验新项目、补验同项目新会话。首次重生成重试成功；最后的同项目停止检查改用相同 Anthropic 接口的 Sonnet 完成，不能宣称该项也以 Opus 成功。错误过程与成功过程均保留，未加提示词或产品级重试补丁。

本地生命周期审计脚本起初仍被已运行进程使用的旧扩展版本遮住，重启隔离服务后加载新审计钩子并补验。该插桩只记录事件、session ID 与连接数量；没有改送模内容。

## 边界与后续

第一刀已记录的两个边界继续保留：未注册的 `draft_write` 由原生 pi 拒绝；工具期间写入的 `rp-panels` 快照仍可能位于 user 与定稿之间，影响面板拍的变体树形。本刀没有扩大范围处理这些问题。

对照 `PLAN-ROUND-FLOW.md`，本刀使原生循环、会话结束点、模型配置和后续工具所需的上游接口处于同一版本。它完成的是运行时基础升级；分段演出、计划可改、探索与可修改正文的能力尚未落地。现有 RP 装配与工具清单保持第一刀的状态，下一步才进入能力工具层。

原始证据位于本机忽略目录 `_pi-upgrade/`：`pre-upgrade.json`、`upgrade-first.*`、`runtime-second.json`、`streaming-first.json`、`native-hooks.json`、`http-smoke.json`、`live-analysis.json`、`live-scribe-audit.json`、`live-controls.json`、`controls-frames.jsonl`、`server-data/pi-audit.jsonl`、`final-audit.json`、`checkout-check.json`、`pack-smoke.json`、`user-data-verification.json`。卡内容、模型正文与连接凭据不加入本文。
