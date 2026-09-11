# 预览与验证分册

`card_project action=preview` 是 agent 的眼睛。它让用户打开的页面渲染当前创作稿（与正式对话同一条显示路径：宏 → 显示正则 → HTML 分块 → 消息帧＋脚本宿主帧），收回错误、交互与 DOM 摘要。

## 参数

- `message`：要渲染的消息正文，默认第一条开场；`greeting`（序号，0=默认开场）二选一即可。
- `variables`：测试变量，默认卡内初值。**预览数据不落任何真实账本**。
- `wait`：页面就绪后再观察多少毫秒（500–15000，默认 3000）。动画/轮询重的界面给长一点。

## 回执怎么读

```json
{ "ok": bool, "ready": bool, "errors": [], "warnings": [], "actions": [],
  "frames": [{ "source", "text", "elements", "tags", "images", "brokenImages", "height" }],
  "message": "渲染的消息", "build": {…}, "note": "没有页面时是说明而非错误" }
```

- `ok` = 就绪且零错误且构建无误。`ready=false`：壳没起来（脚本把页面搞崩、data URL 被拦）。
- `errors`：脚本异常、资源加载失败、console.error。`warnings`：console.warn、CSP 拦截。`actions`：组件触发的 triggerSlash / generate（预览里只记录不执行）。
- `frames`：每个帧一份 DOM 摘要——可见文本前 3000 字、元素数、标签分布、图片数与坏图数、渲染高度。
- 没有页面连接时返回 `note` 说明；这不是错误，让用户打开页面再试即可。

## 常见故障的定位法

- **frames 空、text 空**：模板没渲染。查显示正则的 find 是否匹配正文（长程序卡 ≥8000 字符时 `$` 按字面，不展开捕获组）。
- **elements 很少（个位数）**：HTML 没进帧或被剥壳策略剥掉了。
- **brokenImages > 0**：图片地址不可达（图床、防盗链、离线）。
- **warnings 里有 connect-src**：脚本在 fetch——预览沙箱 `connect-src 'none'`，正式环境同样被拦，这个功能在梨园就是不可用。
- **actions 里有 generate**：界面想把用户输入发进对话；预览只记录。确认正式环境这是不是你想要的行为。
- **height 异常（0 或爆高）**：帧高自适应被脚本破坏（常见：CSS 把 body 高度锁死）。

## 迭代循环

改 → `check`（语法）→ `preview`（运行）→ 发现问题 → 再改；全绿后 `apply`。预览渲染的是**当前稿**（含未应用改动），不必先应用再试。多帧界面（消息帧＋宿主帧）逐帧看 `source` 字段区分归属。

## 预览与正式环境的差异

预览用 data: URL 的独立 origin、独立变量副本；`TavernHelper.generate` / `triggerSlash` 是记录桩；没有正式的消息历史与账本。预览全绿不等于所有宿主语义通过（EJS、逐消息历史变量、未覆盖的 TavernHelper API 预览里也没有），但运行时错误、布局、坏图、协议拦截这些硬故障预览都能看见。
