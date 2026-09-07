# 回归 pi · 第一刀落地记录

2026-09-07。起点：`8229365`。范围是最新执行计划 §5、§9.5 的主循环与钩子归位，运行时保持 **pi 0.80.3**。0.84.4 升级、正文工具与探索工具属于后续工作。

## 已落地的结构

主模型现在通过真实的 `AgentSession.prompt()` 生成，由 pi 校验工具参数、顺序执行工具并续轮。`StageEngine` 的自建 `#agentLoop`、两处主模型直连与对应流式转发已移除；留下的 `sideStreamFn` 只服务场记、摘要等旁路调用。

RP 扩展是钩子的唯一入口，领域计算继续放在 `src/stage/`：

| pi 通道 | RP 职责 |
|---|---|
| `before_agent_start` | 使用本拍的 RP system prompt |
| `context` | 输出同一份历史、状态、世界书、预设和记忆装配；追加 pi 持有的本拍工具过程 |
| `before_provider_request` | 投影原有预设采样参数 |
| `message_update` / `message_end` | 接收流式增量与完整模型消息，保留时间线和原有直出代收行为 |
| `tool_call` | 唯一调用 `checkWriteGate`，按当前用户原话判断写入许可 |
| `tool_result` / `turn_end` | 记录工具回执，处理旁白清屏与轮数上限 |
| `agent_end` | 合并定稿、落正文与媒体、场记、存档、压缩 |
| `session_start` / `session_shutdown` | 建立、撤销当前会话的 RP 连接 |

装配在进入 `prompt()` 前准备，避免装配失败后被 pi 的扩展异常隔离机制变成缺少 RP 上下文的请求。它仍按拍现读素材；`resources_discover` 的会话级生命周期不适合代替这一行为。

**修正了计划中的一个 API 对应关系**：`after_provider_response` 提供的是 HTTP 状态与响应头，不是模型输出。生成内容的入口必须是 `message_update` 和 `message_end`。

原有八项 RP 语义继续由领域层掌管：20 轮后撤工具并留最后一次调用、直出代收、定稿合并、ask 无限等待并透传停止、封笔后存档、媒体落树、全流程留档、旁白清屏与 strayText。拍级输入队列也继续保留。

## 会话持久化与宿主衔接

pi 默认保存每条 assistant/toolResult，RP 历史则只保留定稿和展示媒体。若直接接受默认持久化，中间工具消息会改变回复树形，重生成还会把旧工具过程带进下一拍。因此为当前 runtime 增加三个明确的接口：

- `message_end` 可返回 `persist: false`。消息继续供本次工具循环使用，在 `agent_end` 钩子之前从 agent 内存移除，不写会话树；`agent_end.messages` 仍保留完整过程。多个 handler 之间不允许撤销这个标记，临时响应也不触发会话级重试或压缩。
- `AgentSession.appendMessage()` 同时写会话树和 agent 内存，用于已有定稿与媒体。宿主不再于每拍结束时直接修补 `agent.state.messages`。
- `setLeaf()` 精确切换叶位，`prompt({ reuseUserMessage: true })` 校验并复用当前 user。重生成不追加第二条输入，旧回复和旧分支账本不会进入新请求。

`src/stage/bridge.ts` 只定义结构接口，通过按 session ID 索引的 `globalThis` Map 连接原生 ESM 宿主与 jiti 装载的扩展。临时工具集在拍结束后恢复。新建项目时使用 `runtime.dispose()` 发出真正的 shutdown；仅调用 `session.dispose()` 不会发出该事件。

宿主对 RP 拍只广播一次增量和结束事件。停止时也采用同一规则；否则接回 pi 后，原来的 `session.isStreaming` 分支会额外广播一次结束。向量记忆入库使用生成结束时捕获的节点与分支坐标。

## 验证结果

| 检查 | 结果 |
|---|---|
| 改动前全量测试 | 676 项，674 通过，2 项既有失败 |
| 本刀全量测试 | **689 项，687 通过，同样 2 项失败** |
| 真实 AgentSession + RP 扩展的引擎测试 | **26/26** |
| runtime 五个专项文件 | **42 项，41 通过，1 项既有失败** |
| TypeScript runtime 全包构建到隔离输出目录 | 通过 |
| 本次 runtime 模块按源码重新生成 dist | 通过 |
| HTTP 服务启动与接口探活 | 通过 |
| 真实模型五拍 | **5/5 正常交稿，5/5 场记落盘** |
| 真实模型重生成、停止、新项目、同项目新会话 | 通过 |

全量测试原有两项失败：

1. `实卡: first_mes/备选开场白 一律 html 皮肤、零 status 段`
2. `实卡：初值只写在 schema prefault 里的卡能被播种`

runtime 原有失败是 `should queue extension-origin steering messages while streaming`。用 Vite 只读加载 HEAD 中原始 `agent-session.ts`、`runner.ts`、`types.ts`，重跑该并发文件得到同样的 6/7 和同一断言失败；本刀没有修改其语义。专项测试的会话目录已改为显式临时目录。

新增回归覆盖原生工具续轮、树与内存一致、重生成隔离、ask 阻塞与停止、空回复与错误、排队、轮数上限、写入许可、媒体顺序及 reload。另有本地 HTTP provider 测试，实际验证 SDK 发出的 RP 消息、采样参数、鉴权以及工具回执续轮。

用 HEAD 旧引擎和本刀引擎对照三组固定夹具：无预设、有预设、面板写入。每组比较首轮和工具回执后的请求，去除时间戳、usage 统计后，**system、messages、工具描述与 schema 全部一致**。该结论限于这些夹具；真实生成采用下表的结构指标对照。

### 真实模型五拍

采用 `_baseline0/BASELINE-无预设.md` 的条件：同卡、独立挂载同一本内嵌世界书、无用户预设、固定 `/greeting 1`、原五条输入、ask 选择第一个选项。主模型 `claude-opus-4-6-thinking`，思考档 low；场记沿用已有旁路模型。端口 7621，cwd 和 agent home 均为 `_pi-return/` 下的隔离目录。

数据来自落盘消息的 `details.rpTimeline[]`，时间核对 JSONL 行内 timestamp，并按北京时间解释。

| 拍 | 耗时秒 | 思考字 | 正文字 | 工具 | ask | 正文 |
|---|---:|---:|---:|---|---:|---|
| 1 | 108.8 | 742 | 2074 | lorebook_search ×2、world_state_get | 0 | 直出 |
| 2 | 109.8 | 867 | 1445 | ask、lorebook_search | 1 | 直出 |
| 3 | 117.8 | 1563 | 2201 | lorebook_search ×2、memory_search | 0 | 直出 |
| 4 | 102.6 | 1571 | 1610 | 无 | 0 | 直出 |
| 5 | 123.7 | 924 | 2123 | 无 | 0 | 直出 |
| 合计 | **562.7** | **5667** | **9453** | **8 次** | **1** | **5/5** |

第零步对应结果为 552.2 秒、4726 思考字、7491 正文字、8 次工具、2 次 ask、5/5 直出。两次采样证明检索、询问、交稿链路仍可用；不能据单次随机生成的字数和 ask 次数差异判断能力改善或退化。

五拍正文均为 user 的直接子节点，过程消息没有重复落树。额外实测确认：重生成产生两个回复变体而不增加 user；停止只发一次结束，保留半拍正文并跳过场记；切项目后旧连接移除，只剩当前连接；同项目新会话可继续运行。

### 明确的行为边界

原引擎会执行模型幻觉出来的、已从工具清单撤下的 `draft_write`。原生 pi 会拒绝未注册工具。本刀接受这项原生校验行为，并新增拒绝后恢复到正文通道的测试。原有一条依赖隐形 `draft_write` 的格式合并夹具，已改为当前有效的“正文 + 读工具 + 格式尾巴”路径；正文、尾巴、历史断言保留，时间线按实际直出代收合并。不能把这次验证描述为“所有旧断言原封不动”。

面板树形还存在一个**改动前已有的问题**：宿主在工具期间同步写入 `rp-panels`，会让最终回复挂在该快照下面。旧、新引擎的面板夹具都复现同一父节点；本刀保留原时序。故“正文直接挂 user”适用于本次普通回复、媒体和实弹路径，尚不能覆盖面板写入拍。面板快照时序应单独处理。

现有 `isBackstageText` 对整段括号输入的兼容过滤也保留；实弹重生成按宿主选出的最后一条剧情 user 验证，而非无条件取最后一条原始输入。

## 构建与复现

仓库原来缺少继承用的根 `tsconfig.base.json`；本刀补齐与 vendored 输出匹配的配置。AI 的源码已有 `streaming` / `GoogleCompat` 类型，dist 声明落后导致 runtime 类型检查失败；本刀只重新生成该声明及 map，AI 实现未改。

完整 runtime 构建已在隔离输出目录通过。仓库另有历史 source/dist 差异，日常补丁可用新脚本只生成指定模块；常规模式先检查整个包，再输出指定源文件。`--declarations-only` 只检查选中的声明源，不输出 JS。AI 全包另有两处既有的 `Required<…Compat>` 与 `streaming` 类型不一致，本刀只同步声明，不改这些 provider 实现。

```powershell
node scripts/build-runtime-modules.mjs --declarations-only packages/ai/src/types.ts
node scripts/build-runtime-modules.mjs packages/coding-agent/src/core/agent-session.ts packages/coding-agent/src/core/extensions/runner.ts packages/coding-agent/src/core/extensions/types.ts
node node_modules/typescript/bin/tsc -p packages/coding-agent/tsconfig.build.json --noEmit
node --test test/*.test.ts
```

本机原始证据留在忽略目录 `_pi-return/`：`final-pi-return.*`、`runtime-final.json`、`runtime-baseline.json`、`context-comparison.json`、`live-analysis.json`、`live-controls.json` 与隔离服务的 `pi-audit.jsonl`。卡内容、模型正文和连接凭据不加入仓库文档。开工前含 cards 的专门快照在 `.liyuan-cache/backup/pre-pi-return-2026-09-07T13-39-04.zip`。

## 离分轮演出流程近了多少

对照 `PLAN-ROUND-FLOW.md`，本刀完成了生成和工具循环的底座归位，RP 各通道有明确入口，场记与定稿也有统一的结束点。现有提示词文案、注入位置和素材顺序保持；没有新增作者措辞识别。

实际演出仍是现有工具加直出正文。计划、探索、可修改正文等能力留到运行时升级之后；本次 5/5 直出正是后续需要改变的结构指标。0.84.4 升级结果见 [第二刀落地记录](PI-RETURN-KNIFE2.md)。
