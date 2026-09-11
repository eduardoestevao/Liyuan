# 写卡平台与写卡工具完善：全集矩阵、结构操作、验证通道、skill

2026-09-11 立项。用户对写卡平台提出四个问题：一张卡的全部组成部分平台是否都包含了；这些板块 agent 是否都能编辑；为什么没有教 agent 用写卡平台的 skill；agent 写完前端怎么验证、怎么观察前端有什么问题。本文先回答四问，再给出实施顺序。上一阶段的板块投影与全屏工坊见 [PLAN-CARD-STUDIO.md](PLAN-CARD-STUDIO.md)，资源工程的保真规则见 [CARD-AUTHORING-SLICE1.md](CARD-AUTHORING-SLICE1.md)。

## 一、四问的取证结论（2026-09-11）

1. **没有全部包含。** 资源层只认字符串槽位（`src/card-authoring.ts` `cardResources`）：12 个文字字段、开场、条目正文、正则匹配/替换、脚本正文。条目/正则/脚本的元数据只在 outline 的 facts 里能看不能改；群聊开场、tags、世界书本身的字段、v3 的 assets/nickname/source、封面像素完全没有通道；**任何东西都不能新增或删除**。工坊界面有三处假编辑：世界书板块的常驻/启用/备注/关键词只改内存对象从不落盘（`CardStudio.tsx:695-740`）；封面选图只是本地预览；页面脚本（含 zod schema 与 1MB 组件）在十个板块里没有入口。`assign` 在两个前端都没有交互。
2. **agent 射程与上面一致**，只能改字符串槽位或用原生文件工具改 sources 文件。写卡台上并存两条写路径：`card_update`/`card_greetings` 直写原卡，`card_project` 走工程；工具描述没说互斥，模型用了前者工程即进入 conflict，而工程没有重新同步操作，只能手工重建。
3. **零 skill。** 机制在（`skills/<name>/SKILL.md` 全局根 ＋ 卡目录 `技能/`，`skill_read` 已挂到写卡模式），目录为空。写卡知识（卡 spec、正则 placement 语义、MVU 三种初值来源、宿主 API、梨园与酒馆的差异、工程操作流程）没有任何落点；`assets/AUTHORING.md` 只有身份文字，且让模型「用面板预览」——它做不到。
4. **agent 全盲。** `check` 只做 JS/正则语法与卡结构校验；预览只能用户在面板点；预览壳有完整错误上报（error / unhandledrejection / CSP / console.error，`web/src/cardAuthoringPreview.ts:17-21`），但只有旧面板接收，全屏工坊的预览弹窗不监听，错误直接丢；正式对话里 HtmlFrame/ScriptHost 的运行时错误不回服务器；没有截图或 DOM 观察通道；playwright 只是 devDependency。

## 二、覆盖矩阵

「可读」＝outline/inspect 能看到；「可改」＝有写通道；「增删」＝能新增/删除；「agent」＝写卡模式的工具能到达。○ 有 · ✕ 无 · ◐ 本轮补。

| 组成 | spec 来源 | 可读 | 可改 | 增删 | agent | 本轮 |
|---|---|---|---|---|---|---|
| 卡名/描述/性格/场景/示例/作者注/作者/版本 | `data.*` | ○ | ○ | — | ○ | 不动 |
| 卡内系统提示 / 末端提示 | `system_prompt` / `post_history_instructions` | ○ | ○ | — | ○ | 不动 |
| tags | `data.tags` | 只有数量 | ✕ | — | ✕ | ◐ meta |
| 深度提示 | `extensions.depth_prompt` | ○ | ✕ | — | ✕ | ◐ meta |
| 默认开场 / 备选开场 | `first_mes` / `alternate_greetings[]` | ○ | ○ | ✕（`card_greetings` 直写原卡） | ○ | ◐ 走工程增删 |
| 群聊开场 | `group_only_greetings[]` | ○ | ✕ | ✕ | ✕ | ◐ 资源＋增删 |
| 世界书本身 | `character_book.name/description/scan_depth/token_budget/recursive_scanning` | ✕ | ✕ | — | ✕ | ◐ 读＋meta |
| 条目正文 | `entries[].content` | ○ | ○ | ✕ | ○ | ◐ 增删 |
| 条目元数据 | `comment/keys/secondary_keys/constant/enabled/selective/insertion_order/position/depth/role/probability` | ○ facts | ✕（工坊假编辑） | — | ✕ | ◐ meta |
| 条目其余字段 | `case_sensitive/use_regex/group/sticky/cooldown/…` | ✕ | ✕ | — | ✕ | 留在原包保真，不做 |
| 正则匹配 / 替换 | `regex_scripts[].findRegex/replaceString` | ○ | ○ | ✕ | ○ | ◐ 增删 |
| 正则元数据 | `scriptName/placement/disabled/markdownOnly/promptOnly/minDepth/maxDepth/trimStrings/substituteRegex/runOnEdit` | ○ facts | ✕ | — | ✕ | ◐ meta |
| 页面脚本正文 | `tavern_helper.scripts[].content` | ○ | ○ | ✕ | ○ | ◐ 增删；工坊补入口 |
| 脚本元数据 | `name/enabled/type/button/data` | ○ facts | ✕ | — | ✕ | ◐ meta（name/enabled） |
| 卡级变量初值 | `tavern_helper.variables` | ○ | ✕ | — | ✕ | ◐ meta（整对象） |
| 板块归属声明 | `创作/sections.json` | ○ | ○（`assign`） | — | ○ | ◐ 工坊补交互 |
| 封面像素 | PNG 图像 | ○ | ✕（工坊选图不落盘） | — | ✕ | ◐ `cover` 操作换图 |
| v3 assets / nickname / source / 多语言作者注 | `data.*` | ✕ | ✕ | — | ✕ | 保真留原包，不做 |
| 外部依赖 | 从正文汇总 | ○ | 只读 | — | ○ | 不动 |
| 卡档案 AGENTS.md / 技能 | 卡目录 | 另有通道 | 另有通道 | — | ○ | 不动 |

「不做」项的理由：它们在五张样本卡上全空或只有生态私有含义，梨园不消费；原包保真已保证它们不丢。需要时再按同一 meta 通道加白名单。

## 三、三刀

### 刀 1：结构操作、元数据、单写路径、重新同步

**责任人**：`src/card-authoring.ts`。原则不变：`创作/` 工程是真源，原包快照只读，sources 是字符串槽位。新增一份 **`changes.json`** 作为结构性改动的账本：

```
{ version: 1,
  removed: string[]                             // 待删项的路径（JSON 串）
  meta: { [pathJSON]: { field: value } }        // 对某项非字符串字段的浅覆盖，白名单按类型
  added: [{ path: string[]; payload: object }]  // 追加项：路径＝草稿中的尾部位置，载荷是 spec 形状的完整对象
}
```

- **草稿视图** = 基线快照 ＋ meta 覆盖 ＋ 追加项（就地追加）；待删项**留在原位只做标记**。资源与目录都从草稿视图派生，因此所有资源 ID 在整个稿件周期内稳定，`changed` 判断与结构报告都精确。
- **构建** = 草稿视图 ＋ sources 覆盖 → 剔除待删项（数组按下标倒序 splice）→ `normalizeCard` → hash。
- **应用**后基线变为新快照，索引已移位，因此 sources 按新基线**全部重写**并清理孤儿文件，`changes.json` 清空；应用前的账本存入 manifest 的 `previousChanges`。
- **撤回**恢复上一快照与 `previousChanges`，sources 按「保留项在应用后快照中的位置」映射回来，草稿仍可再次应用。
- **新增**只接受 harness 自己定义的四种：`lore` / `greeting`（含群聊）/ `regex` / `script`，服务端生成 spec 形状的默认载荷，字段可传入覆盖。条目 id 取现有最大数字 id＋1；对象式 entries 取最大数字键＋1。
- **元数据**白名单按类型：条目 `comment/keys/secondary_keys/constant/enabled/selective/insertion_order/position/depth/role/probability`（position 写 v3 `extensions.position` 数字并镜像 v2 字符串）；正则 `scriptName/placement/disabled/markdownOnly/promptOnly/minDepth/maxDepth/trimStrings/substituteRegex/runOnEdit`；脚本 `name/enabled`；卡级 `tags`、`depth_prompt`、`tavern_helper.variables`；书级 `name/description/scan_depth/token_budget/recursive_scanning`。不在白名单的字段留在原包。
- **封面**：`cover` 操作接收 PNG 字节（base64），只换 PNG 图像、tEXt 原样；JSON 卡不支持。
- **单写路径**：写卡模式只保留 `card_project`（与 `card_read`/`card_create`/`card_list`）；`card_update` 与 `card_greetings` 退出 authoring 面（收缩，不是加法）。工坊界面全部走工程通道，三处假编辑接真通道。
- **重新同步** `rebase`：原卡被其他入口改动后（面板改字段、世界书面板、手工替换文件），把当前原卡设为新基线：未改过的源文件按新基线重写；改过且基线同路径值未变的保留；改过且基线也变了的保留并列为冲突；账本里路径已不存在的 removed/meta 丢弃、added 保留。不做静默合并，冲突列表随状态返回。

**目录项寻址**：outline 项新增 `path`（拥有 JSON 节点的项）、`removed`、`addition` 三个字段；`remove` / `restore` / `meta` 都按 outline 的 `key` 寻址，与 `assign` 同一套。

### 刀 2：验证通道

**责任人**：预览壳（`web/src/cardAuthoringPreview.ts`）＋ 服务端挂起请求（同 `askChoice` 形状）。不引入 headless 浏览器：产品没有这个依赖，用户的页面本身就是渲染器，而且它反映的是真实运行环境。

- `card_project` 新增 `preview` 操作：参数 `message`（默认第一条开场）、`greeting`（序号）、`variables`（测试变量，默认卡内初值）、`wait`（就绪后再等多少毫秒，默认 3000）。服务端组装预览数据，广播 `card_preview` 帧，挂起等待；连接的页面渲染预览并在超时后回报 `POST /api/card/authoring/preview-report`。没有页面连接时工具如实返回「没有连接的页面」。
- 预览壳在每个消息帧与脚本宿主帧里补一个 **DOM 摘要**上报（可见文本前 3000 字、元素数、标签分布、坏图数、frame 高度），在 `ready` 与父页请求快照时各报一次。
- 回执结构：`{ errors[], warnings[], actions[], frames[]: { source, text, elements, tags, brokenImages, height }, ready: boolean }`。这是数据回执，不是措辞。
- 页面侧新增 `PreviewRunner`：接到帧就在浮层里可见地跑（用户看得到 agent 在测什么），事件列表同屏；全屏工坊的预览弹窗同时接上事件列表，不再丢错误。
- 正式对话里 HtmlFrame/ScriptHost 的运行时错误回传：本轮不做，记为缺口——它需要页面到服务端的新数据通道，先看预览通道够不够用。

### 刀 3：skill 与身份文字收缩

- 发行一份 `assets/skills/card-authoring/SKILL.md`，启动时播种到全局技能根 `skills/card-authoring/`（缺失才播种，改过就是用户的，与 SYSTEM.md 同一规则；Docker 的 `skills` 卷同样生效）。
- frontmatter 新增 `mode: authoring`：只上写卡模式的 `skill_read` 清单，扮演模式不见。这是数据字段，不是新注入点。
- skill 内容按板块组织，与工坊十板块和 `card_project` 操作一一对应：一张卡的构成与 spec 位置、工程操作流程（outline → read → write/add/meta → check → preview → apply）、正则 placement/markdownOnly/promptOnly 的实际语义、MVU 三种初值来源与 `<UpdateVariable>` 规则、宿主提供的 API 与预览的限制、导出酒馆时的退化、常见错误。只写事实与流程，不写催告。
- `assets/AUTHORING.md` 删掉「需要预览时使用卡面板」那句，改为指向工具本身；只减不增。

## 四、铁律自检

- 铁律一：送模文案只减不增。`card_project` 的参数描述随新操作增加，那是工具协议不是提示词；skill 是按需读的数据通道。
- 铁律二：不新增注入点。`preview` 回执经工具结果回来；skill 走既有 `skill_read`。
- 铁律三：新增/元数据只认 spec 字段与 harness 自己定义的四种类型，白名单是数据不是猜测；不按作者措辞归类。
- 铁律四：全集＝任意 v2/v3 卡上的任意 JSON 节点；责任人＝工程层的 `changes.json`；没见过的卡：不在白名单的字段留在原包保真，账本路径失效时丢弃并报告，不静默。

## 五、状态

- 2026-09-11：立项，四问取证完成，矩阵定稿。
- 2026-09-11：**三刀全部落地**（同日提交）。
  - 刀 1：`src/card-changes.ts`（账本纯函数：节点类型按路径形状、元数据白名单、草稿视图、构建剔除、追加项重排）＋ `src/card-authoring.ts`（add / remove / restore / meta / cover / rebase / discard / guide，`read resource=draft`；应用后 sources 按新基线整体重写，撤回恢复账本与稿件；`undo-sources.json` 存应用前的正文稿）。目录项带 `path / addition / removed`，新增 `book` 项与群聊开场资源。写卡面只留 `card_project`，`card_update` / `card_greetings` 退出 authoring surface。
  - 刀 2：`server/card-preview.ts`（请求组装、回执归并、挂起表）＋ `card_preview` 帧 ＋ `POST /api/card/authoring/preview-report` ＋ `web/src/components/PreviewRunner.tsx`（可见浮层，事件列表）；预览壳每帧上报 DOM 摘要，父页可请求快照；工坊预览弹窗接上事件列表。REST 的 `action: preview` 与工具走同一条 `runCardPreview`。
  - 刀 3：`assets/skills/card-authoring/SKILL.md`（frontmatter `mode: authoring`），启动时 `seedBuiltinSkills` 播种到 `skills/card-authoring/`（缺失才播种）。**改动一处设计**：tool 定义每轮按名注册一次，两个模式不能各带一份 `skill_read` 清单，所以手册不上 skill 索引（`mode: authoring` 的 skill 在两种模式的清单里都不出现），改由 `card_project action=guide` 按需读——它本来就是这个工具的说明书；RP 模式的送模文案零变化。`assets/AUTHORING.md` 删掉「用面板预览」一句（138 → 114 字）。
  - 工坊：02 世界书的常驻/启用/备注/关键词/位置/深度/顺序/板块归属全部接真通道，可新增、删除、撤销删除；04 开场可增删（含群聊开场）；06 并入页面脚本，界面/脚本可增删、改名、停用；07 改按目录项列出（修正了原先按 raw 下标与 prompt-regex 清单错位的 bug），含 placement / 送模侧 / 显示侧开关与增删；00 封面选图进账本；09 显示结构改动概况、冲突提示、重新同步、放弃全部改动。
  - 验证：新增 `test/card-changes.test.ts`（9 项）与 `test/card-preview.test.ts`（3 项）；全量 **788 项、786 通过、2 项既有实卡失败**；前端 typecheck 与生产构建通过；后端同参数诊断 13 条与 HEAD 完全相同。隔离服务 7699 ＋ 真实页面：工坊新增/常驻切换/改名/标记删除落盘，`preview` 2.6s 回执 ok，坏图与 console.error 被捕获、DOM 摘要含文本/元素/标签/坏图数，运行器浮层显示「已回报 · 1 个错误」；真 PNG 卡应用（21 → 21 条：一增一删）后撤回恢复稿件。7620 未重启。
  - 未做（记为缺口）：正式对话里 HtmlFrame/ScriptHost 运行时错误回传；预览截图（沙箱内无法自截）；v3 assets 等白名单外字段。
