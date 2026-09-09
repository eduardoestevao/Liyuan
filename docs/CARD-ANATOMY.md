# 一张角色卡里有什么：五张样本的解剖与板块映射

2026-09-09，[角色卡工作台计划](PLAN-CARD-STUDIO.md) 步 1/2 的产出。样本由用户圈定五张（代号 A–E，卡名不进仓库，对照表在本机 `.liyuan-artifacts/card-studio/samples.md`），全部为 `chara_card_v3 / 3.0` 的 PNG。盘点只读结构与统计，不读正文语义；脚本在同目录。

## 一、五张卡的构成

| | A 轻前端 | B 重前端·单正则 | C MVU | D 大世界书·纯文字 | E 全家桶 |
|---|---|---|---|---|---|
| PNG | 0.9MB | 4.5MB | 1.4MB | 1.9MB | 10.7MB |
| description | 332 | **0** | **0** | **0** | 297 |
| personality / scenario / mes_example / system_prompt / post_history | 全 0 | 全 0 | 全 0 | 全 0 | 全 0 |
| first_mes | 464 | 5816 [html] | 2173 [macro, `<StatusPlaceHolderImpl/>`] | 1118 | 18650 [html, script] |
| alternate_greetings | 1（3380，html） | 1（10） | 4 | 7（含 1 条空） | 1（6） |
| 世界书条目 | 21 | 52 | 84 | 148 | 356 |
| 　常驻 / 关键词 / 停用 | 21 / 0 / 0 | 29 / 40 / 1 | 27 / 79 / 1 | 13 / 136 / 2 | 56 / 290 / 38 |
| 　内容总量 | 25.7K | 48.7K | 50.3K | 100.5K | 286.8K |
| regex_scripts | 1（裁剪） | 1（**1.09MB** html+script） | 6（3 条 4~18KB 界面，3 条裁剪） | 2（裁剪） | 21（8 条界面，含 673KB / 219KB / 213KB / 88KB；6 条 placement=5 世界书变换；7 条裁剪） |
| tavern_helper.scripts | 0 | 0 | 2（zod schema 3KB；一条按钮脚本） | 0 | 6（1 条 **1.03MB** 已停用；4 条只有远程 import；1 条 zod schema 8KB） |
| tavern_helper.variables | `{}` | 无 | `{}` | `{}` | 4.3KB（非 stat_data，是页面组件自己的数据） |
| `[initvar]` 条目 | 0 | 0 | 0 | 0 | 0 |
| `<UpdateVariable>` 规则条目 | 0 | 0 | 2 | 1 | 2 |
| EJS 条目 | 0 | 0 | 0 | 0 | 2 |
| 远程依赖 | 无 | 前端里 CDN/字体/图床/第三方 API | MagVarUpdate、StageDog 两个 jsdelivr 库 | 无 | 20+ 主机：jsdelivr、作者自有 CDN、GitHub raw、图床、字体、占位图服务 |
| 其他 | — | — | — | 一条 depth=999 停用空条目 | 14 条空内容条目（tavern_sync 分隔符）；34 条停用的 before_char 条目 |

### 直接结论

1. **卡的正文在世界书，不在 spec 的人物字段。** 五张卡的 personality/scenario/system_prompt 全空，四张 description 为空。「01 人物」若映射到 `description`，五张卡里四张是空板块。
2. **世界书是三种东西的混合体**：按关键词触发的知识（before_char/after_char 的 keyed 条目，D 有 135 条、E 有 285 条）；常驻的规则/人设块（constant 且多数位于 `at_depth`，A 全部 21 条按 d0..d12 排成一份有序的提示词装配）；协议条目（`<UpdateVariable>` 规则、EJS、分隔符）。spec 的 `position / constant / keys / depth / role / enabled` 足以把这三类分开，但**分不开「人物」与「世界观」**——两者都是 keyed 或 constant 的文本条目，位置约定（墨月：世界观放角色定义之前、人设放之后、规则放 D0）是作者习惯，不是 spec 保证，E 的 285 条世界知识就全在 after_char。
3. **前端 = 显示正则 + 页面脚本，两者的判据是 spec 字段**：`placement` 含 2（AI 输出）且 `markdownOnly=true` 且 replace 含 HTML → 显示层界面；`promptOnly=true` 且 replace 为空 → 送模侧裁剪；`placement=[5]` → 世界书变换；`findRegex === "<StatusPlaceHolderImpl/>"` → MVU 状态栏挂载点。「状态栏」与「消息前端」在结构上无法区分（都是显示正则里的 HTML），只能按体量和是否含 `<script>` 标注。
4. **MVU 的现代形态不是 `[initvar]`**：五张卡零 `[initvar]`；C 和 E 的初值/结构在脚本内联的 zod schema 里，规则在 `<UpdateVariable>` 常驻条目里，运行时靠远程 import 的 MagVarUpdate 库。`src/mvu.ts` 的 `findInitVar` 在这五张卡上都命中不了，`findSchemaDefaults` 才是活路径。
5. **体量决定编辑方式**：E 的世界书 287K 字、单条正则 673K、单条脚本 1M；B 一条正则 1.09M。任何「把卡装进模型窗口」的做法都不可行，编辑必须是资源级、带行分页，和第一切片 `card_project.read` 的做法一致。
6. **依赖是一等资源**：B、C、E 都靠远程 URL（库、字体、图床、API）。没有依赖清单，导出的卡在别处能不能跑无从判断。

## 二、墨月/tavern_sync 的工程模型（步 1）

墨月本地工坊建立在 StageDog `tavern_sync` 的「卡＝项目文件夹」格式上：`index.yaml` 是清单，世界书条目是独立文件（`世界书/<文件夹>/<名>.yaml|txt`），开场是 `第一条消息/N.txt`，界面是 `界面/<名>/`（Vue+TS 工程，构建后经 jsdelivr 远程加载），脚本是 `脚本/<名>/index.ts`，正则与脚本库在 `扩展字段` 下声明；`schema.ts` 单独存放 MVU 结构。清单里用 YAML 锚点复用条目配置，用 `文件夹` 给条目分组，导出时分组退化成 `===X开始===/===X结束===` 空条目（E 的 14 条空条目就是它们）。

在线版把这套工程投影成十个板块：`00 作品设置 / 01 人物 / 02 世界书 / 03 创作规则 / 04 开场白 / 05 MVU 变量 / 06 状态栏 / 07 消息前端 / 08 EJS / 09 检查与导出`，每块带「已设置 / 未开始 / 未启用」；右栏 AI 只回答或按需查询整个作品。它的 skill 路由与板块一一对应（moyu-character / worldbook / opening / mvu / tavern-frontend / tavern-script / ejs / package）。

对梨园的意义：**板块是作者心智的分组，它在源工程里是数据（文件夹与清单），在导出的 PNG 里已经丢失**。梨园面对的主要是导出物，所以分组不能从 PNG 推出来，只能（a）按 spec 结构判据得到粗分，（b）让作者或读得懂卡的模型声明一次，声明落成 `创作/` 下的数据。

## 三、板块 ↔ spec 映射表（草案）

按铁律三：只用结构判据，不认作者措辞；归不进去的进「其他」。

| 板块 | spec 来源（结构判据） | 五张卡上的表现 | 备注 |
|---|---|---|---|
| 作品设置 | `name`、PNG 封面、`creator`、`character_version`、`tags`、`creator_notes`、`create_date`、顶层 v2 镜像键 | 五张都有；creator 只有 D 填了 | 顶层 v2 镜像与 `data` 的一致性需检查 |
| 人物 | `description`、`personality`、`mes_example`、`extensions.depth_prompt` | 4/5 为空 | 不能从世界书自动补入；世界书条目可由声明归入 |
| 世界书·知识 | `character_book.entries` 中带 `keys` 的条目 | D 135 / E 290 / C 79 / B 40 / A 0 | 展示 keys、position、probability、递归开关 |
| 世界书·常驻块 | `constant=true` 且无 keys 的条目，按 `position/depth/role/insertion_order` 排序 | A 全部 21 条即一份有序装配 | 这是「创作规则」的实际载体，但也可能是人设；标签由声明给 |
| 创作规则 | `system_prompt`、`post_history_instructions` | 五张全空 | 板块只在有内容或有声明归入的常驻块时显示 |
| 开场白 | `first_mes`、`alternate_greetings`、`group_only_greetings` | 全有；含 html/script/占位符信号 | 空字符串开场（D 的第 7 条）应显示为空项而非丢弃 |
| MVU 变量 | `<UpdateVariable>`/`_.set` 条目、`[initvar]` 条目、脚本中的 zod schema、`tavern_helper.variables`、`<StatusPlaceHolderImpl/>` 出现处 | C、E 有；D 有 1 条规则无 schema | 初值来源三选一，须标明来自哪一处 |
| 界面（显示正则） | `regex_scripts` 中 placement 含 2、`markdownOnly`、replace 含 HTML | C 3 条、E 8 条、B 1 条 | 标注体量、是否含 `<script>`、是否为占位符挂载 |
| 送模正则 | `promptOnly=true`；或 replace 为空的裁剪 | 五张都有 1~7 条 | 直接影响模型看到什么 |
| 世界书变换正则 | `placement` 含 5 | 只有 E（6 条，含 4 条停用） | 梨园显示侧与送模侧都只认 placement 2（`src/cardfront.ts:265,290`），1 与 5 目前不应用，板块里要如实标「梨园未消费」 |
| 脚本 | `tavern_helper.scripts[]`：`enabled`、`button`、`data`、内容是仅远程 import 还是内联代码 | C 2 / E 6 | 远程 import 记入依赖 |
| EJS | 条目内容含 `<% %>` | 只有 E 2 条 | 梨园无执行器，只展示 |
| 外部依赖 | 脚本/正则/开场里的 URL 汇总 | B、C、E | 一等资源，导出提示 |
| 其他 | 停用条目、空内容条目、`depth=999`、未识别 extensions 键、group/outlet/sticky/automation_id | E 38 停用 + 14 空；D 1 条 999 | 不丢弃、不猜；可由声明归入某板块 |

「板块状态」的结构定义：**未启用**＝该板块没有任何来源；**已有**＝有来源，显示条数与总字数；**待归位**＝「其他」里有条目。不做「未开始/已完成」这类进度判断——那是创作进度，归作者。

## 四、对第 3 步的直接要求

- 投影建立在 `src/card-authoring.ts` 现有资源之上；现有六种资源缺元数据（条目的 position/keys/constant/enabled、正则的 placement/flags、脚本的 enabled/button），投影层要把这些从快照读出来附在资源上，不改资源身份规则。
- 分组声明是数据：`创作/` 下一份 `sections.json`（资源 ID → 板块），由界面手动或模型通过 `card_project` 写入；投影时结构判据给默认值，声明覆盖默认值。
- 每个板块视图必须支持 E 的体量：条目列表分页、大正则按行读取、1MB 脚本只显示摘要与依赖。
- 现有 `findInitVar` 路径在样本上零命中，MVU 板块以 `findSchemaDefaults` 与 `<UpdateVariable>` 条目为主；`[initvar]` 保留为来源之一。
- 依赖清单在导出与「检查」里作为独立结果给出。

## 五、未回答的问题

- 位置约定（世界观前/人设后/规则 D0）是否值得作为**默认声明**提供给作者一键采纳？它是社区习惯不是 spec，只能作为可撤销的建议。
- 界面/送模正则的判据与 `src/cardfront.ts` 现有筛选（`placement` 含 2、`promptOnly && !markdownOnly` 归送模侧）完全一致，投影层应直接复用那两个函数，不另写一份。placement 1/5 的正则要不要开始消费是独立议题。
- 顶层 v2 镜像键与 `data` 不一致时以谁为准；导出时是否同步。
