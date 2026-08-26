/**
 * 「这段内容是不是标记语言」——显示链上**唯一**的一处判据。
 *
 * 由来（8/25 一张实卡的开场白）：同一个问题此前有四处各自为政的判断，且都以
 * 「有没有 `<!doctype>` / `<html>` / ` ```html ` 语言标记」为准：
 *   1) postprocess.isFullPageHtmlPayload —— 决定 unwrap 放不放行
 *   2) postprocess.protectFullPageBlocks —— 决定整页块要不要占位保护
 *   3) htmlEmbed.findFencedHtmlDocument —— 决定前端认不认领成一帧
 *   4) htmlEmbed 末尾的 isUiRoot 复核
 * 作者的状态栏界面是一份**省掉 `<html>` 外壳**的文档（根标签 `<head>`、收尾只到
 * `</body>`、裸围栏无语言标记），四处判据全部落空 ⇒ 服务端 unwrap 把
 * `<head>/<style>/<body>/<script>` 连壳剥掉、只留 CSS 与 JS 当正文上屏
 * （实测 16376 字皮肤产物 → 13725 字裸文本）。
 *
 * 四处平行、互相追赶正是「名单」那类事故的形状，所以这里**不再按标签名列举**：
 * 只问语法——`<` 紧跟标签名／doctype／注释。根标签叫什么与「这是不是界面」无关，
 * 于是换成 `<head>`、`<meta>`、`<table>`、注释起头的下一张卡不会再复现同一个坑。
 */

/** 首个非空即标记语言起点：`<!--`、`<!doctype `、或 `<` + 标签名 */
const MARKUP_ROOT_RE = /^<(?:!--|!doctype\s|[a-z][\w:-]*(?=[\s>/]))/i;

/** 去掉前导空白后，是不是以标记语言开头 */
export function startsWithMarkup(text: string): boolean {
	if (!text) return false;
	return MARKUP_ROOT_RE.test(text.trimStart());
}

/**
 * 一个围栏块（含开闭围栏）里装的是不是一份 HTML 界面。
 *
 * 只认「开围栏之后第一个非空字符起是标记语言」；语言标记写不写、写什么都不影响
 * （作者常写裸 ``` ）。非标记语言的普通代码块／选项块因此照旧不算界面。
 */
export function fencedBlockHoldsMarkup(block: string): boolean {
	if (!block) return false;
	// 跳过开围栏那一行（```lang\n），取其后内容
	const m = /^```[^\n`]*\r?\n/.exec(block.trimStart());
	if (!m) return false;
	return startsWithMarkup(block.trimStart().slice(m[0].length));
}
