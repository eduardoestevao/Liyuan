# 工作模式沙箱：卡目录为界，卡外申请

2026-09-12 用户提出并定案。后端已项目化（`cards/<卡>/` 一卡一工作空间），扮演不需要碰卡目录之外的东西；
但也不能一刀切禁止——卡外访问改为**申请**。本文是实施依据，动手前先答铁律四的三问。

## 一、用户定案（原话大意）

1. 「现在的后端是项目化了，是一个个的文件夹，那么是不是就可以设置沙箱把权限限制在文件夹。」
2. 「也不能就完全禁止访问文件夹之外，不过需要申请。」
3. 追问「挂载另一张卡的资源会不会突破当前卡的文件夹，是不是要扩到 `cards/` 那一层」——结论：**不扩**。
   边界不画在某一层目录上，画在「这个会话声明过要用的东西」上：当前卡目录 ∪ 已挂载的资源；
   放开整个 `cards/` 等于让卡 A 的工作模式自由读写卡 B 的会话记录与记忆，正是沙箱最该拦的。

## 二、铁律四三问

**问 1 全集**：需要沙箱的只有**工作模式**开放的七个 pi 原生工具 `read / bash / edit / write / grep / find / ls`
（`src/stage/authoring.ts AUTHORING_NATIVE_TOOLS`）。扮演模式的工具清单（`engine.ts` rpTools）全是梨园自己发行的
数据工具，各自落在卡的数据文件里，本就无路可出。右栏助手曾是另一个扩展、另一条钩子——**2026-09-12 同日已整体删除**（见「六」）。

工作模式合理要碰的卡外内容，按来源分四类；前两类由 harness 已有的数据推出、不问，后两类问：

| 来源 | 例 | 处置 |
|---|---|---|
| 当前卡 | `cards/<卡>/` 全部（含 `创作/`、`对话/`、`记忆/`） | 自由 |
| 已挂载的资源 | `config.lorebooks` 指向的书文件；将来多卡挂载的卡目录 | 自动进允许集（挂上就有、卸下就没） |
| 公共库 | `assets/lorebooks`、`assets/presets`、`skills`、`.liyuan-skills` | 读放行，写申请 |
| 其余 | 梨园自己的代码（`web/`、`src/`）、别的卡、工程根外、密钥文件 | 申请 |

密钥文件（`liyuan.config.json`、`~/.liyuan/agent/models.json`）不单列名单：它们都在卡外，走同一条申请路；
选择卡上写明路径，用户自己看得见在批什么。

**问 2 负责人**：已经有唯一的一个——每次工具调用（含原生七个）都经 pi 的 `tool_call` 钩子：
`.liyuan/extensions/roleplay.ts` → `engine.ts` hooks.toolCall → `src/tools/gate.ts`。写入门禁住在这里，
判据是「工具名 + 用户原话」；沙箱给它多一维「路径 + 允许集」，判定仍是纯函数（`src/sandbox.ts`）。
「申请」也走现成通道：钩子是 async 的（pi `runner.ts emitToolCall` 对 handler 取 `await`），停在那里等用户；
用户作答走 `askUser`（`server/main.ts askChoice` 的选择卡，扮演里 `ask` 工具用的同一张）。
被拒/待批的结果作为工具回执回给模型。越界判定复用 `card-authoring.ts` 已有的 `inside()`＋`realpath`
（`card_project` 靠它挡符号链接把写入带出作品目录），搬到 `src/paths.ts` 成唯一实现。

**问 3 没见过的卡**：规则只看路径与允许集，不看卡内容，任何卡行为一致。卡的脚本/前端引用了卡外资源、
模型跟着去读时弹一次申请——预期行为，不是污染。

## 三、铁律自检

- 铁律一：不加一句提示词。模型不从 system prompt 得知沙箱，从工具回执得知「被拒」；申请文案只给用户看。
- 铁律二：不新增注入点。拦截在既有 `tool_call` 钩子，回执走既有工具通道，询问走既有选择卡。
- 铁律三：不建识别器。工具→路径参数的映射是梨园自己发行的协议（pi 工具的 `path`/`command` 字段）；
  **不做「危险命令识别」正则**（用户本机 pi 的 `permission-gate.ts` 是那种形状，梨园里不照搬）。
  允许集与授权都是看得见改得动的数据（会话树条目 / `卡.json`）。
- 铁律四：本文第二节。

## 四、规则

### 判定（`src/sandbox.ts sandboxVerdict`，纯函数）

```
工具不在 read/grep/find/ls/edit/write/bash 之列   → 放行（梨园工具各有自己的门禁）
bash                                              → 已授权 bash ? 放行 : 申请
路径类：target = resolve(cwd, input.path ?? cwd)，取最近存在祖先的 realpath
  target ∈ 允许根（当前卡目录、创作目录、挂载卡目录）  → 放行
  只读工具 且 target ∈ 只读根（公共库、挂载书文件）     → 放行
  target ∈ 已授权目录（会话级 ∪ 永久）                → 放行
  否则                                              → 申请
```

### 授权单位（`grantUnit`）

申请的不是单个文件而是一个范围，否则改一次前端要点十几次：

- 工程根内：**顶层目录**（`web/`、`src/`）；`cards/` 与 `assets/` 下到**第二层**（`cards/<卡>`、`assets/<库>`）——
  这两个是并列无关内容的口袋，不能整袋批；
- 目标本身是根下的单个文件（如 `liyuan.config.json`）：只批那个文件；
- 工程根本身（`ls`/`find`/`grep` 不带 path）：单位＝工程根，选择卡上明写「整个工程根，含其他卡」；
- 工程根外：目标所在目录。

### 申请（选择卡）

- 路径类：`请求读取/修改/写入/列出/查找/搜索：<路径>` ＋ `范围：<单位>`；
  选项 `允许一次｜本会话允许｜永久允许（本卡）｜拒绝`。
- bash：`请求执行命令（bash 不受卡目录限制）：<命令>`；选项 `允许一次｜本会话允许 bash｜永久允许 bash（本卡）｜拒绝`。
- 自由输入、关闭卡片＝拒绝；用户按停止＝本拍停止（与扮演 `ask` 同）。
- 卡不在 `cards/` 里（导入暂存区的旧卡、测试卡）：没有「永久」项——没有 `卡.json` 可落。
- 宿主没注入 `askUser`（无法询问的环境）：卡外一律拒绝，回执说明原因。

### 授权数据

- **本会话**：会话树自定义条目 `liyuan-sandbox`（`{ dir }` / `{ bash: true }`），沿当前分支重放；
  回退到授权之前的剧情点，授权随之消失；重开会话仍在。
- **永久（本卡）**：`cards/<卡>/卡.json` 的 `sandboxAllow: string[]`（工程根内存相对路径，根外存绝对）与
  `sandboxBash: true`。这是 `CARD_LEVEL_KEYS` 的两个新成员——跟卡走的字段第一次有了运行时消费方。
  改文件即改授权；删掉那行即收回。

### 不改的东西

- 原生工具的 cwd 仍是工程根：与 `read/write` 相对路径基准、提示词里的「工作目录」一致；bash 靠申请不靠换 cwd。
- `backendControl` 语义不变（关＝分发模式，连工具都没有）；沙箱是它与「全开」之间缺的那一档。

## 五、已知代价（认下，不当 bug 查）

1. bash 不是真沙箱：批了 bash 就是批了整台机器的 shell。选择卡上写明。OS 级沙箱三平台＋Docker 做不齐，不做。
2. MCP 工具（playwright、1shell host_exec…）在文件沙箱之外，边界是「启用了哪些 MCP」，沙箱不假装覆盖。
3. 「本会话允许工程根」是一把大钥匙（含其他卡）；只在用户看着「整个工程根」四个字点下去时发生。
4. 永久授权按卡存：换一张卡改前端要再批一次。取「声明跟卡走」的代价。

## 六、不做什么

- ~~右栏助手~~：**2026-09-12 用户定案删除**（「没什么用了」）。剧情侧委托 `assistant_run` 早已无人挂清单，
  写卡入口 9/9 已进主会话工作模式，剩下的唯一活口「让助手生成」卡档案按钮也一并删（「工作模式就用上面那个」）。
  删除范围：`server/assistant.ts`、`server/tool-adapter.ts`、`src/assistant-gateway.ts`、`src/stagehand.ts`、
  `src/stage/assistant-stage.ts`、前端 `AssistantPanel.tsx`＋发送钮旁入口＋十来种 `assistant_*` 帧、
  `config.assistantModel`、`DIRS.assistant` / `CHAT_ASSISTANT_DIR` 与迁移段、Docker 卷；三份助手测试。
  存量 `.liyuan-assistant/` 与子项目里的 `助手会话/` 目录**不动**（用户数据；不再备份、不再迁移）。
  `ToolSurface` 的 `"assistant"` 值与只挂在它上面的 spec 暂留（`src/tools/registry.ts` 文件头有说明），
  是工作模式收编的候选，不是活代码。沙箱由此没有例外：会碰文件的模型通道只剩工作模式一条。
- 不做授权管理界面：v1 只有数据文件（`卡.json`）与会话树；要不要面板由实际使用决定。
- 不给模型任何关于沙箱的提示词。

## 七、改动清单

| 文件 | 改动 |
|---|---|
| `src/paths.ts` | `insidePath()`（从 card-authoring 搬来成唯一实现）；`SHARED_LIBRARY_DIRS` |
| `src/sandbox.ts` | 新：工具访问映射、目标解析、授权单位、判定、允许集、授权读写、申请文案与门（`createSandboxGate`） |
| `src/card-authoring.ts` | 改用 `insidePath` |
| `src/stage/authoring.ts` | `AUTHORING_NATIVE_TOOLS` 由沙箱映射派生（一份来源） |
| `src/stage/bridge.ts` | `toolCall` 可返回 Promise |
| `src/stage/engine.ts` | toolCall 变 async；原生工具经 `createSandboxGate` |
| `.liyuan/extensions/roleplay.ts` | `tool_call` 钩子 `await` |
| `src/types.ts` / `src/cardspace.ts` | `sandboxAllow` / `sandboxBash` 进 RpConfig 与 `CARD_LEVEL_KEYS` |
| `test/sandbox.test.ts` | 纯函数：越界、`..`、符号链接、授权单位、只读根、bash、无 askUser 拒绝 |
| `test/stage-engine.test.ts` | 真 pi＋faux 模型：卡内写静默、卡外读拒绝→本会话允许→同单位不再问、bash 永久→`卡.json` |

## 八、状态

- 2026-09-12：立项，本文定稿。
- 2026-09-12：**实施完成（未提交）**，改动与第七节清单一致，另加两处：
  - `web/src/app.css .choice-q` 加 `white-space: pre-wrap`——申请文案第二行是路径/命令，要原样呈现；前端已重建。
  - 授权单位多认一档：目标是 `cards/` 或工程根本身时单位就是它，选择卡上明写「整个卡库／工程根（含其他卡）」。
  - 验证：`test/sandbox.test.ts` 9/9（卡内自由、`..` 逃逸、Windows 目录联结逃逸按真实位置授权、授权单位、
    只读根、bash、会话树重放、`卡.json` 落盘去重、申请文案、无 askUser 拒绝、四种答复、停止交还、旧布局卡）；
    `test/stage-engine.test.ts` 新增一项真 pi 循环：卡内写静默 → 卡外读被拒（回执可见、文件未读）→ 本会话允许 →
    同单位不再问 → bash 永久授权落 `卡.json` → 下一拍树上授权与永久授权都不再问。
    全量 811 项 807 过，4 红为既有实卡环境失败（与本刀无关）。
  - 用户侧 7620 需重启＋强刷才生效；真模型下的体感（问得多不多、单位粒度合不合适）等实际使用反馈再调。
- 2026-09-12（同日）：右栏助手整体删除（见「六」）。全量 800 项 796 过，4 红既有；前端 typecheck＋构建过；
  隔离端口起服务 HTTP 探活 200（`server/*` 无测试覆盖，按 AGENTS.md 纪律实跑）。
