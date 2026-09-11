# 页面脚本分册

页面级脚本住在 `extensions.tavern_helper.scripts[]`（命名空间 `TavernHelper` / `tavern_helper` 两种拼写是同一插件的历史写法，都认）。

## 梨园怎么跑它们

- `enabled === false` 的脚本不跑；空 content 跳过。
- 每条脚本独立执行（一条语法错只废它自己）；有顶层 `import/export` 的按 ES module 跑，否则 classic。
- 宿主是 0×0 的同源 iframe（ScriptHost）：作者脚本假定自己跑在子帧里、跨一层挂父页 DOM（酒馆助手的形状），同源是必需的，否则 `parent.document` 抛 SecurityError。挂在父页的产物（悬浮球等）换卡即收回。
- 单份脚本可达数 MB（实测 3.5MB），所以正文不走 HTML 拼接，textContent 通道执行。

## 垫片提供的 API（对照酒馆助手公开调用面的最小子集）

- `$` / `jQuery`：完整 jQuery 3.7.1，离线内置。
- `_`：lodash 常用子集（get/set/has/each/isArray/isObject/escape/clone/debounce 等）。
- `getAllVariables()` / `getVariables()`：读变量 JSON（父页 postMessage 注入；默认 `{stat_data:{}}`）。MVU 面板脚本多用 `setInterval` 轮询它重画（实测有卡 1.5s 一轮），收到即生效，并同步发一次 `Mvu.events.VARIABLE_UPDATE_ENDED` 事件。
- `Mvu`：MVU 插件对象壳（事件常量＋事件总线）。
- `eventOn` / `eventEmit`：事件总线。
- `triggerSlash(text)`、`TavernHelper.generate(params)` / `stopAllGeneration()`：接到梨园聊天总线——`generate` 把用户输入发进对话并触发生成；预览沙箱里只记录不执行。
- `toastr`：折成梨园自己的通知条（success 归 info 档）。
- `errorCatched(fn)`：包装函数、报错走 console、功能照跑。
- `waitGlobalInitialized(name)`：目标已存在立即 resolve。
- `substitudeMacros` / `getLastMessageId` / `getChatMessages`：读/util 族安全降级。

**没有的**：写正文 API 一律不提供；`getChatMessages` 等读族是降级桩，别指望拿到完整历史。

## 写入边界（红线）

变量写入按作用域分家：

- `global` / `script` 作用域（作者脚本的界面自留地，典型：存悬浮球坐标）→ 落 localStorage，允许。
- `chat` / `message` 作用域（＝梨园账本）→ **读可以，写一律拒绝并 warn**。账本只由 agent 与场记推动；界面递条子，不拧旋钮。

给卡写新脚本时：界面状态（坐标、开关、缓存）用 global/script 作用域；要让剧情数值变化，走 MVU 规则让场记判断（见 MVU 分册），不要从脚本直写。

## buttons / data 字段

`tavern_helper.scripts[].button`（按钮声明）与 `.data`（任意数据）梨园只统计不渲染——outline facts 里可见（buttons 数、data 键数），没有按钮 UI 消费它们。酒馆里靠它们挂按钮的脚本，在梨园要自己把 DOM 挂到父页（`parent.document`），走 ScriptHost 的同源通道。

## 语法检查

`check` 只对改过的脚本做语法检查（不执行、无副作用）；HTML 内脚本的运行时错误由 `preview` 报告。改完脚本至少过一遍 check，再 preview 看运行。
