# 回到 agent 架构：槽位归属与迁移映射（刀0）

2026-09-08 立。用户定案：**不是删除预设，是回到 agent 的形式**——把「追加 system 的编辑」和「AGENTS.md 的编辑」这两个本该属于用户的能力重新开放给用户。预设因此要改，它的前端也要改。

本文是刀0 的唯一交付物：**把今天所有能到达模型的通道逐个点名，各自指定目标槽位。** 后面每一刀都引用本文，不再临时发明位置（临时发明＝又一次堆叠，铁律二）。

判据是**通道**不是段落。按「这张卡的这一段去哪」写会漏——换一张没见过的卡，段落形状全变，通道不变。

## 一、pi 的真实槽位（`resource-loader.ts:1023-1049`、`system-prompt.ts:28-169`）

```
buildSystemPrompt =
    customPrompt            ← .pi/SYSTEM.md（项目，需 trust）→ <agentDir>/SYSTEM.md（全局）
  + appendSystemPrompt      ← .pi/APPEND_SYSTEM.md（项目，需 trust）→ <agentDir>/APPEND_SYSTEM.md（全局）
  + <project_context>       ← AGENTS.override.md / AGENTS.md / CLAUDE.md（逐目录、祖先继承、带路径）
  + skills 索引             ← 名字+描述常驻，正文靠 read 按需取
  + Current working directory: <cwd>
```

`agent-session.ts:1104-1121` 把这五样拼成 `_baseSystemPrompt`，连**拼它的 options 对象**一起交给 `before_agent_start`（`runner.ts:1135-1139`）。

**梨园今天的病，一句话**：`.liyuan/extensions/roleplay.ts:1289` 收下这两样，整份丢掉，自己另拼一根（`agent-session.ts:1332` `this.agent.state.systemPrompt = result.systemPrompt`）。三个文件槽位在扮演路径上从未生效。

pi 递的是 options 不只是字符串 ⇒ **「不替换、只贡献」是原生支持的，不用发明机制。**

## 二、今天全部送模通道 → 目标槽位

### A. 常驻侧（`buildStageSystemPrompt`，assemble.ts:278-362）

| # | 通道 | 今天位置 | 目标 | 理由 |
|---|---|---|---|---|
| A1 | **梨园身份 / 一拍是什么 / 稿纸纪律 / 检索纪律** | **不存在** | **SYSTEM.md** | 这就是「agent 很傻只会思考输出」的空缺。60 个工具全靠 pi 原生工具描述自我介绍，没有一个字讲流程 |
| A2 | `# 消息流约定`（标注表 ~470 字） | system 内 harness 段 | SYSTEM.md | 梨园自己发行的协议，与卡无关，字节永久稳定 |
| A3 | `# MCP 外设`（说明 + 三条纪律） | system 内 harness 段 | SYSTEM.md（工具纪律一节） | 同上；当前索引仍随会话动态生成 |
| A4 | **梨园默认预设 7 块 299 字** | `presetBefore` 顶部，无标题裸句 | **删** | 见 §三 |
| A5 | 用户预设（`presetBefore` 全部） | system 主体，排最前 | **APPEND_SYSTEM.md**（一次性转译） | 用户的规矩就该住用户的槽 |
| A6 | `card.description` / `personality` / `scenario` / `mesExample` | system 兜底段（受 `filledMarkers` 保护） | **卡 AGENTS.md** | 卡的常驻文本 |
| A7 | `card.systemPrompt` | system 末尾「优先级最高」 | **卡 AGENTS.md** | 同上 |
| A8 | **蓝灯 `constantLore`** | `# 世界设定（常驻事实）` | **卡 AGENTS.md** | 蓝灯的真身就是常驻文件；见 §四 |
| A9 | `# 用户扮演：<userName>` + `userPersona` | system，无条件出 | **待定，见 §六岔口2** | 人设是用户的，但 `userName` 按 RpConfig 归属表是卡级 |

### B. 每拍注入侧（`buildStageInjection`，assemble.ts:436-513；以 user 角色落在历史末端）

| # | 通道 | 目标 | 理由 |
|---|---|---|---|
| B1 | 【世界状态】`formatState(state)` | **保持注入** | 真的每拍在变 |
| B2 | 【登场名录】`rosterIndex` | 保持注入 | 同上 |
| B3 | 【活跃面板】`panelIndex` | 保持注入 | 同上（用户可能手改过） |
| B4 | 【剧情记忆】`memoryRecall`（向量库召回） | 保持注入 | 同上 |
| B5 | 【语言纠正】`languageMismatch` | 保持注入 | 真的是每拍判定的条件块 |
| B6 | **【相关设定】绿灯命中**（off 给正文 / 其余给标题） | **改形状，刀5** | 两条路都失败，见 §五 |
| B7 | **【设定集索引】`loreIndex`** | 改形状，刀5 | 同上 |
| B8 | 【卡作者末端指令】`card.postHistoryInstructions` | **卡 AGENTS.md** | 它是常驻文本，每拍不变，住在注入层是错位 |
| B9 | 【语言】`config.language` | **待定，见 §六岔口3** | 每拍不变 ⇒ 该常驻 |
| B10 | `本拍约 N–M 字`（`extractDraftRules` 从预设提取） | 跟随 A5 进 APPEND_SYSTEM.md | 预设死后这条没有来源了 |

### C. 历史侧（`rebuildHistory`，assemble.ts:140-239）

| # | 通道 | 目标 |
|---|---|---|
| C1 | 【开场】`rp-greeting`（`firstMes` / `alternateGreetings[greetingIndex]`） | 保持历史 |
| C2 | 【前情提要】`rp-summary` + 跨会话常驻摘要 | 保持历史 |
| C3 | 往拍定稿正文（补丁已套） | 保持历史 |
| C4 | `promptRules` 送模侧作者正则 | 保留 | 它是数据变换不是文案，不占槽位 |
| C5 | **预设 after 段**（`assemblePresetAfter`，历史之后的元指令/格式/CoT 开头；末条 assistant 预填位丢弃） | 随 A5 进 APPEND_SYSTEM.md | 转译时要处理「它原本在历史之后」这个位置语义 |

### D. 非文案通道（不占提示词槽位，但属于预设/卡的资产，删预设时不能一起丢）

| # | 通道 | 今天 | 目标 |
|---|---|---|---|
| D1 | `presetDoc.samplers` → `providerPayload` | 预设文件 | 迁进配置，**不进任何文案槽** |
| D2 | `presetDepth`（`injection_position=1` 深度注入） | 数据层保真，**未消费** | 转译时如实报告「这部分从未生效」 |
| D3 | 60 个工具的 description | pi 原生声明 | 保留；刀3/刀5 后自然收缩 |
| D4 | `skillFiles` → `skill_read` 渐进披露 | 卡目录 skills/ | 保留，但要跟 pi 原生 skills 索引对齐（两套渐进披露并存要查重） |
| D5 | `cardAuthorScripts`（MVU prefault 播种） | 给场记，不给主模型 | 不动 |

## 三、A4：默认预设为什么全删

`presets/默认.json` 7 块 299 字，`materials.ts:292` 在 `config.preset` 为空时装。**「完全抛开预设」当时没有抛开它。**

逐块处置：

| 块 | 内容 | 处置 |
|---|---|---|
| `liyuan-default-sovereignty` | 「绝不替 {{user}} 说话、行动或代述内心想法」 | **必须死** |
| 视角与排版 / 感官落地 / 剧情推进 / 活人角色 / 忌AI腔 / 篇幅 | 文风要求 | 不进 SYSTEM.md。无预设态平淡是**条件不是回归**，该空着就空着；用户要文风，写 APPEND_SYSTEM.md |

主权那句必须死的证据（2026-09-08 09:11 / 09:13 两拍，同卡同输入「离开监察院」，deepseek-v4-pro）：

| 档 | 思考总量 | 纠结这条硬边界 | 占比 |
|---|---|---|---|
| low | 1104 字 | 514 字 | **47%** |
| high | 4986 字 | 1965 字 | **39%** |

机制：**用户输入的每一个行动指令本身就是替角色行动**，而这句话禁止模型执行它。模型只能每拍重新跟自己谈判一次边界，谈完才开始想剧情。high 拍思考里反复出现「那怎么办？」「让我重新审视规则」。

按铁律一的判据「删掉哪句能解决」——这一句删得掉。

## 四、A8：蓝灯的真身是常驻文件

酒馆没有分层：一切都是每拍重拼的一根字符串，「蓝灯」只是「每拍都拼进去」的别名，是预算管理不是架构。

搬到 agent 里，两者是完全不同的东西：

- **蓝灯常驻 → `cards/<卡>/AGENTS.md`**（文件，前缀缓存友好，人能读能改能删，模型能 read 能 edit）
- **绿灯命中 → 检索库**（刀5 改形状）

实测这张卡（大乾风华录 Ver1.7）：`description` / `personality` / `scenario` / `mesExample` / `system_prompt` / `post_history_instructions` **全是 0 字**，148 条世界书就是它的全部。10 条蓝灯共 29463 字。

对比 system prompt 总长 30354 字：**梨园自己 789 字 : 卡 29463 字 = 1:37。**

## 五、B6/B7：检索为什么两条路都失败

`assemble.ts:462-482` 按档位分策略：off 给正文、thinking 给标题。两条都通向零检索。

- **off 给正文**（8/23 注释已记）：模型读到就下结论「查了也没有」，不再调工具
- **thinking 给标题**（2026-09-08 新证）：模型把 harness 拼的标题列表**当成全库目录**，扫一眼没关键词就判「不需要查」

09:13 那拍思考原话：

> 「相关设定命中3条武学（金刚不坏神功、韦陀伏魔杖、大日如来掌）……我可以不调用lorebook」
> 「设定索引里没有'烂柯寺'条目……**我不需要查**」

**根因**：标题列表是 harness 拼的，模型无法区分「库里没有」和「被 harness 筛掉了」。它说「我查过了」的时候其实是在猜。

**方向**（刀5 细化）：绿灯变成模型能自己查的东西（文件 + 检索，参照 pi 的 skills 渐进披露形状），「我查过了」这句话才第一次有真实依据。

## 六、架构凌驾于模型之上：成因与解法

### 怎么造成的（一条必然的链）

1. 梨园整份替换 systemPrompt ⇒ 送给模型的每个字都是梨园拼的
2. 「每个字都是我拼的」⇒ 梨园必须对每个字负责 ⇒ 得判断哪些字该进
3. 「判断哪些字该进」只能靠 harness 自己的判据 ⇒ 正则、名单、签名识别
4. **判据错了，模型没有申诉渠道**——它看不到被删的东西，甚至不知道有东西被删

第 4 条是要害。**「凌驾」的准确定义：一个不可观测、不可申诉的决定。**

为什么必然？酒馆的模型只有一个入口（拼好的字符串），所以酒馆的引擎**必须**替模型做完全部筛选。梨园照抄了筛选层，没照抄它的前提——**酒馆的筛选是可观测的**（用户在世界书界面逐条看见、逐条开关）。梨园把筛选搬进源码正则，可观测性在搬家途中丢了。

### 坐实的现场：状态栏

卡的状态栏版式住在世界书条目 #9【核心：格式规范】，1842 字、蓝灯常驻，内容是 `<normal_status>` + ```yaml 『时间』『地点』『在场人物』的完整规范。

`stripProtocolEntries`（`materials.ts:296` → `protocol-detect.ts:53`）把它**整条**置 `enabled:false`。触发的是**一个 strong 信号** `tag:UpdateVariable`，命中位置是这条内容里的一句英文：

> `You must output the status bar wrapped in <NextCharacterPanel> tags (after <UpdateVariable> tags)`

为这半句话，1842 字版式全丢。实测 148 条里**只有这一条被判死，正好是唯一写着状态栏怎么出的那条**。

后果分档：high 拍靠模仿开场白憋出半个状态栏（缺『在场人物』，也没有 `<normal_status>` 外壳，前端 CSS 认不出）；low 拍一点没出。

**这不是模型不听话，是数据在到达模型前被删了，而没有人知道。**

### 三条解法

1. **数据落地成文件，harness 不再是唯一持有者。** 卡的常驻内容在 `AGENTS.md` 里是文本。protocol-detect 想删某段，就在文件里注释掉、或挪进旁边一份导入报告——**改的是文件，不是运行时行为**。用户打开就看见，模型 read 就看见。错还会错，但错在看得见改得动的地方（铁律三原话）。
2. **harness 只发行自己的协议，不识别别人的措辞。** 今天 protocol-detect 在认别人发明的名字（`<UpdateVariable>`），铁律三禁的正是这个。改成：导入时让**读得懂卡的模型**声明一次「这卡的状态栏版式是这样、这几条是插件协议」，声明落成数据，harness 死板执行数据。
3. **给模型看到全集的能力。** 见 §五。

三条合起来是同一件事：**把 harness 从「上下文的唯一作者」降级成「上下文的装配工」**——作者是卡、是用户、是模型自己。

## 七、六刀与依赖

| 刀 | 做什么 | 依赖 | 验收 |
|---|---|---|---|
| **0** | 本文 | — | 用户过目 |
| **1** | SYSTEM.md 立起来（A1/A2/A3）+ 默认预设删除（A4）+ 梨园从「替换」改「贡献 customPrompt」 | 刀0 | 无预设态送模文案；思考里不再纠结主权；工具调用从 0 变成几 |
| **2** | APPEND_SYSTEM.md 接上（A5/B10/C5/D1/D2）+ 预设页签→「我的规矩」编辑器 + 酒馆预设一次性转译 | 刀1 | 用户写一段规矩，出现在送模串的正确位置 |
| **3** | AGENTS.md 加入（A6/A7/A8/B8）+「这张卡」编辑器 + diff | 刀1 | 蓝灯离开 system；卡内容可读可改可回退 |
| **4** | protocol-detect 从运行时正则改导入期数据（§六解法1、2） | 刀3（需要 AGENTS.md 这个落点先存在） | 状态栏版式到达模型；被丢的东西用户看得见 |
| **5** | 检索闭环（B6/B7） | 刀3（蓝灯已离开检索路径） | 模型自己查得到，「查过了」有依据 |

**工具收缩（今天 60 个）不单独立刀**：刀3/刀5 落完会自然多出一批废工具（`card_*` 6 / `lorebook_*` 10 / `stage_skill_*` 3 里一大半是在给文件读写套私有协议），那时候删。跟着走，不另开一战。

## 七A、刀1 执行记录（2026-09-08）

**接线形状**：`roleplay.ts` 的 `before_agent_start` 从「返回梨园自拼串（整份替换）」改为
「pi 基座串在前 + `activeStage.systemPrompt`（用户身份/卡字段/蓝灯/消息流约定/MCP）接在其后」。
SYSTEM.md 缺席（`systemPromptOptions.customPrompt` 为空）时退回随包骨架原文并**每拍告警**——
不是隐形兜底：告警可见，用户要么建回文件、要么看着告警知道发生了什么。

**配套改动**：
- `assets/SYSTEM.md` 随包发行（参照 `assets/cards`、`assets/lorebooks` 的先例）；
  `src/paths.ts seedStageSystemPrompt()` 在启动时播种到 `<agentDir>/SYSTEM.md`，已存在不覆盖（改了就是用户的）。
- `server/assistant.ts` 助手会话显式退出两个槽位（`systemPromptOverride: () => undefined`、
  `appendSystemPromptOverride: () => []`）——agentDir 被扮演与助手共用，不退出则助手基座被换成扮演骨架。
- 默认预设删除：`presets/默认.json` 整份移除（§三），`materials.ts` 的装载分支与缓存指纹随之退役。

**执行中发现的新问题（当场收口，不能留给刀3）**：打开文件槽位后，**仓库根目录自己的
AGENTS.md（开发者指令：铁律、src 索引、测试命令）顺着 cwd 进了扮演基座**——那是给改梨园
代码的 agent 看的，不是剧情素材。且发布包剔除清单有 `CLAUDE.md` 却漏了 `AGENTS.md`，生产同样中招。
刀1 之前整份替换把它挡在外面，刀1 的接线一落地它就漏进来，故属刀1 引入、刀1 修复：
- `server/main.ts` `agentsFilesOverride` 只滤**应用根那一层**的 AGENTS.md/CLAUDE.md/AGENTS.override.md；
  卡目录及用户自建文件（刀3 的正主）照常继承。判据是路径相对位置，不是文件名名单。
- `scripts/pack-release.ps1` 剔除清单补 `AGENTS.md`。

## 八、五个岔口的裁定（2026-09-08，用户授权我定）
**1. project trust —— 问题不存在，无需选。**

读码坐实：`SettingsManager` 的 `projectTrusted` 默认 `true`（`settings-manager.ts:362` `options.projectTrusted ?? true`），梨园两处 `SettingsManager.create` 都没传过 `false`（`server/main.ts:269` 经 `createAgentSessionServices`、`server/assistant.ts:1241`）。⇒ `.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md` 的项目级发现本来就通。

**不发信任、不绕道。** 但要留一条纪律：日后若引入 trust 门（多用户/远程部署），项目级两文件会静默失效——那时必须**报出来**，不许静默回落全局（静默回落就是又一个「不可观测的决定」，正是 §六 那个病）。

**2. `userName` / `userPersona` → 留在 harness，不进任何文件槽。**

理由：这两个是**每局可变的运行时事实**（换人设不该改文件），而 `userName` 是「用户扮演谁」到达模型的唯一通道（梨园消息流是裸 `role:"user"`）。它长得像常驻，实际是**局的参数**。
落点：仍由 `buildStageSystemPrompt` 出，但归入「梨园装配段」而非「卡段」。`userPersona` 若用户想让它长期生效，写 APPEND_SYSTEM.md——那是用户自己的槽，与本条不冲突。

**3. B9【语言】留注入；B10 字数随预设一起死。**

【语言】虽每拍不变，但它是**配置的投影**，改设置要立刻生效；进文件就得管同步，凭空多一个双主人。**代价承认**：它每拍占几十字。
字数（`extractDraftRules` 从预设提取）：预设死后无来源，**不补兜底**。要字数就自己写进 APPEND_SYSTEM.md。铁律一——不为一个消失的来源新造一句送模文案。

**4. 卡 → AGENTS.md：agent 自己读卡写（`/init`），harness 只做兜底投影。**

- **主路径**：agent 读卡 → 写 `cards/<卡>/AGENTS.md`。归属对（作者是模型，不是正则），且顺手就是第二步「角色卡制作」的能力。
- **兜底**：没跑过 `/init` 的卡，harness 按今天的版式**投影**卡字段+蓝灯进常驻段（＝今天的行为），但**必须显式告知**「这张卡还没有 AGENTS.md，当前是自动投影」。兜底是可见的临时态，不是隐形的永久机制。
- 判据：`cards/<卡>/AGENTS.md` 存在与否。存在即以文件为准，harness 不再投影（否则双份）。

**5. 现有预设库：转译落盘 + 原文只读留档，不做历史视图。**

- 转译：预设 → 一份 `APPEND_SYSTEM.md`（`presetBefore` + after 段 + 字数规则），**转译报告同时落盘**，逐块写明去向；`presetDepth`（D2，从未消费）如实报告「这部分在梨园从未生效」。
- 原文：`presets/*.json` **不删**，转为只读留档，可重新转译。
- **不做只读历史视图**：22 张卡的既有会话读的是会话树里已落盘的历史，不依赖预设活着；为「看旧预设长什么样」新建一套 UI 是纯负债。要看就看留档的 JSON。

## 九、这一轮同时是第二步的地基

卡变成文件夹里的 markdown 之后，「角色卡制作」不需要再补 `card_*` 工具——它变成**agent 用普通读写工具维护自己的 AGENTS.md**，也就是 Claude Code `/init` 的那个动作，以及 pi 比 Claude Code 多出来的那个能力（追加 system 可编辑）。

`docs/PLAN-RP-AGENT-NEXT.md` 的第一步和第二步，在这个架构下是同一件事的两面。
