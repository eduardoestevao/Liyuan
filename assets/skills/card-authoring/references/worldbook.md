# 世界书分册

## 梨园实际消费的条目字段

条目在梨园里的身份与行为由这些字段决定（`src/lorebook.ts` normalizeEntries）：`keys`（或 v1 的 `key`）、`secondary_keys`（或 `keysecondary`）、`constant`、`enabled`（或 `disable` 取反）、`selective`、`insertion_order`（或 `order`）、`comment`（或 `name`）、`content`、`uid`（或 `id`）。

**不消费**：`position / depth / role / probability` 只影响酒馆的插入位置；梨园按自己的版式注入，这几个字段在 outline 的 facts 里可见（方便你理解卡的意图），但不改变梨园的行为。

## 注入规则（这决定你写的条目有没有用）

- **蓝灯（constant=true）**：全文每拍常驻 system，进 `# 世界设定（常驻事实）` 段，逐条 `- 【备注】正文`，按书内顺序排列。`{{char}}/{{user}}` 宏求值。
- **绿灯（带 keys、非常驻）**：正文**不进** system。梨园只给一行标题索引（`共 N 条：标题A、标题B……`，预算约 2000 字），模型靠 `lorebook_search` 主动检索全文。没有 keys 的条目还能靠标题分词被检索命中（keysFromTitle），但最好还是给 keys。
- **索引截断是永久的**：名字没列进索引，那条设定对模型就等于不存在。条目多时标题要短。
- **停用（enabled=false）**：不注入、不进索引；导出时保留在卡里。
- 挂载的独立世界书与卡内嵌书合并，内容相同的条目去重。

## 卡带 AGENTS.md 档案时的让位规则（最容易踩的坑）

卡目录下若有 `AGENTS.md` 演出档案，**卡常驻内容的注入以档案为准，整组让位**：人物字段段落与世界书常驻块都不再进 system，由档案文本取代（一份不双份）。给这种卡加常驻条目不会生效——要么把设定写进 AGENTS.md，要么确认这张卡没有档案。预设若填了 worldInfo 槽位，同样让位。

## 用户的停用清单与指纹

用户停用条目（面板蓝绿灯开关）按**内容指纹**（正文 md5 前 12 位）记录在 config，不写回卡。改了条目正文，指纹就变了，用户之前的停用对这个新内容不再适用。这不是 bug：停用针对的是「那段内容」。

## 协议条目会被整体剥除

第三方插件协议条目（要求模型每拍输出 `<UpdateVariable>`＋JSON Patch 之类、`[mvu_update]` 命名约定的）由协议识别器按多签名共现判定，**对主模型整条退场**——写给酒馆插件的指令协议在梨园没有解析器，留着只会造成双份记账和正文污染。MVU 的更新规则条目是例外：它们保留给场记读（见 MVU 分册），对主模型剥除。写新卡时不要发明这类协议，梨园的原生通道是场记记账。

## 元数据字段在 card_project 里的写法

`meta key fields` 支持：`comment / keys / secondary_keys / constant / enabled / selective / insertion_order / position / depth / role / probability`。其中 position/depth/role/probability 写进 `extensions` 并镜像 v2 字段串（position 同时写两处），只为酒馆兼容；梨园行为不因此改变。`keys` 传字符串数组。
