# 界面与正则分册

界面（ui 板块）与文本正则（prompt-regex 板块）都住在 `extensions.regex_scripts[]`，区别只在字段组合。**梨园显示侧与送模侧都只应用 placement 含 2（AI 输出）的正则**；placement 1（用户输入）、3（斜杠）、5（世界书变换）不消费，导出酒馆时保留原样。

## 两侧的筛选判据

- **显示侧（displayRules）**：placement 含 2、未停用、非「纯 promptOnly」（`promptOnly=true && markdownOnly!==true` 跳过）。替换串里的页面级 `<style>/<script>` 会被包成围栏整份文档（framePageScopedStyles）。
- **送模侧（promptRules）**：placement 含 2、未停用，且不是纯显示。`promptOnly=true` 只改发给模型的内容；两个 only 都不勾的在酒馆是落盘改原文，梨园无原文概念，归送模侧。它们决定模型看到什么——裁剪 `<think>`、隐藏状态栏标签都靠这类。
- 替换体带 HTML 且走显示侧 → ui 板块；其余 → prompt-regex 板块。`facts.literalTag` 标出「find 是一个字面标签」的绑定子集（梨园原生绑定的形态）。

## 替换串的展开语义（cardSkin）

- **短模板（< 8000 字符）**：`$$` → `$`；`$1`…`$n`（n ≤ 实际捕获组数）→ 对应捕获组；`{{match}}` → 整段命中。名字代入走替换函数，不会把名字里的 `$&` 当替换模式。
- **长程序卡（≥ 8000 字符）**：`$` 一律按字面，只认 `{{match}}`——整页替换串里的 jQuery 链不该被当捕获组展开。
- `trimStrings` 只作用于**代入的捕获组/整段命中**（与酒馆 filterString 同义），不动模板字面文本。

## 深度限定

`minDepth / maxDepth` 按消息深度过滤（0=最新一条，往回数；按显示气泡计数不是原始 message）。深度限定的规则只在对应深度的消息上应用；无限定的全局应用。

## 挂载点判据（与 MVU 分册衔接）

`isMvuPanelMount` 只认「整条正则恰好是 `<StatusPlaceHolderImpl/>` 字面量」——一个元字符都不能有。实测 13 张卡里另有四条「固定字面量+整份界面」的显示规则不是挂载点（开局认证屏、建卡屏、整页皮肤、成对状态栏标签），它们的触发字由剧情/开场白产出，harness 不替它们补挂。想让界面**每拍都在**，用字面挂载点；只想让它**出现一次**（开局屏），把触发字写进开场白。

## 模板里能跑什么

消息帧是沙箱 iframe，模板里的 `<script>` 在帧内运行，能用垫片面（jQuery/lodash/`getAllVariables` 等，见 scripts 分册）。外链资源（CDN 图床字体）能加载；`connect-src 'none'`，任何 fetch/WebSocket 都会被 CSP 拦下。远程 import 的库走 CDN，离线环境会失败——依赖记录在 deps 板块，写新界面尽量自包含。
