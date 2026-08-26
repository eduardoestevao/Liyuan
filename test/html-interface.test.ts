/**
 * 整页 HTML 界面卡:显示正则 → 围栏文档 → 单 html 段(可 scripts)。
 * 夹具对齐「开局正则」形态:一个固定字面量触发字换成整份带脚本的文档(不依赖读盘也能绿)。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { displayRules, extractRegexScripts } from "../src/cardfront.ts";
import { findLocalCard } from "./fixtures.ts";
import { applyCardSkin } from "../web/src/cardSkin.ts";
import {
	claimFencedHtmlDocument,
	findFencedHtmlDocument,
	htmlLooksInteractive,
	isFullInterface,
	splitHtmlParts,
} from "../web/src/htmlEmbed.ts";
import { buildSrcDoc } from "../web/src/frameDoc.ts";
import { splitRichContentParts } from "../web/src/richContentParts.ts";

/** 内含 ``` 字符的「假大文档」——验证末闭围栏策略 */
const fakeDoc = `<!doctype html>
<html lang="zh">
<head><meta charset="UTF-8" /><title>公民档案生成器</title>
<style>.x{content:"use \`\`\` carefully"}</style>
</head>
<body>
  <h1>第一步：开局第一步</h1>
  <button type="button">男性</button>
  <button type="button">女性</button>
  <script>console.log("ok \`\`\`");</script>
</body>
</html>`;

const fenced = "```\n" + fakeDoc + "\n```\n";

test("claimFencedHtmlDocument: 首开末闭,文档内 ``` 不截断", () => {
	const c = claimFencedHtmlDocument(fenced);
	assert.ok(c);
	assert.ok(c!.html.includes("<!doctype html>"));
	assert.ok(c!.html.includes("开局第一步"));
	assert.ok(c!.html.includes("</html>"));
	assert.equal(c!.scripts, true, "含 script 应标 interactive");
	assert.ok(!c!.html.includes("```\n<!doctype"), "html 本体不应再带开围栏");
});

test("findFencedHtmlDocument: 【开场】前缀 + 围栏文档仍能认领", () => {
	const withPrefix = `【开场 · 样本卡】\n【开局占位符】`.replace(
		"【开局占位符】",
		fenced.trimEnd(),
	);
	// 模拟皮肤后: 前缀 + 围栏 HTML
	const skinned = `【开场 · 样本卡】\n${fenced.trim()}\n`;
	const found = findFencedHtmlDocument(skinned);
	assert.ok(found, "带开场前缀必须找到围栏文档");
	assert.ok(found!.html.includes("开局第一步"));
	assert.equal(found!.scripts, true);
	assert.ok(skinned.slice(0, found!.start).includes("开场"));
	assert.equal(isFullInterface(skinned), true, "短开场前缀仍算整楼界面");

	const parts = splitRichContentParts(skinned, null);
	assert.ok(parts.some((p) => p.kind === "html" && p.scripts));
	assert.ok(parts.some((p) => p.kind === "text" && p.text.includes("开场")));
});

test("claimFencedHtmlDocument: 普通代码块不认", () => {
	assert.equal(claimFencedHtmlDocument("```\n选择1: 留下\n选择2: 走\n```"), null);
	assert.equal(claimFencedHtmlDocument("```js\nconsole.log(1)\n```"), null);
});

test("splitHtmlParts / isFullInterface: 围栏整页 → 单 html 段", () => {
	const parts = splitHtmlParts(fenced);
	assert.equal(parts.length, 1);
	assert.equal(parts[0].kind, "html");
	if (parts[0].kind === "html") {
		assert.equal(parts[0].scripts, true);
		assert.ok(parts[0].html.includes("开局第一步"));
	}
	assert.equal(isFullInterface(fenced), true);
});

test("splitRichContentParts: 开局标记 + 显示正则 → 单交互 html", () => {
	const rules = [
		{
			name: "开局",
			source: "【开局占位符】",
			flags: "g",
			replace: fenced.trimEnd(),
		},
	];
	const parts = splitRichContentParts("【开局占位符】", {
		rules,
		charName: "样本卡",
		userName: "旅人",
	});
	assert.equal(parts.length, 1);
	assert.equal(parts[0].kind, "html");
	if (parts[0].kind === "html") {
		assert.equal(parts[0].scripts, true);
		assert.ok(parts[0].html.includes("开局第一步"));
		const doc = buildSrcDoc(parts[0].html, true, true);
		assert.ok(!doc.includes("white-space:pre-wrap"));
		assert.ok(doc.includes("liyuanFrameHeight"), "交互整页需高度上报");
	}
});

test("splitRichContentParts: 已是 HTML 载荷时禁止二次皮肤（防程序卡脚本重复声明）", () => {
	const rules = [
		{
			name: "token",
			source: "TRIGGER_TOKEN",
			flags: "g",
			replace: "<!DOCTYPE html><html><body><script>const X=1;</script>TRIGGER_TOKEN more</body></html>",
		},
	];
	// 模拟 wire 已 prepareDisplayText 后的正文
	const already = applyCardSkin("TRIGGER_TOKEN", rules, { charName: "a", userName: "b" });
	assert.ok(already.includes("const X=1"));
	assert.ok(already.includes("TRIGGER_TOKEN"), "产物内仍含占位串");
	const parts = splitRichContentParts(already, {
		rules,
		charName: "a",
		userName: "b",
	});
	assert.equal(parts.length, 1);
	assert.equal(parts[0].kind, "html");
	if (parts[0].kind === "html") {
		const n = parts[0].html.split("const X=1").length - 1;
		assert.equal(n, 1, "不得二次替换导致脚本重复");
		assert.ok(parts[0].html.length < already.length * 1.5);
	}
});

test("htmlLooksInteractive", () => {
	assert.equal(htmlLooksInteractive("<div>x</div>"), false);
	assert.equal(htmlLooksInteractive("<button onclick=a()>x</button>"), true);
	assert.equal(htmlLooksInteractive("<script>1</script>"), true);
});

/** 迷你完整文档（可拼多份） */
function miniDoc(title: string, name: string): string {
	return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="UTF-8"/><title>${title}</title></head>
<body><div class="status-container"><span id="n">${name}</span></div>
<script>const rawData=\`📝姓名: "${name}"\`;</script>
</body></html>`;
}

test("多份连续 ```html 文档：各自成帧，禁止捏成单帧", () => {
	const d1 = miniDoc("状态展示", "青梧");
	const d2 = miniDoc("状态展示", "店员小桃");
	const d3 = miniDoc("下一步行动建议", "opts");
	const multi =
		`RP 正文结尾。\n\n` +
		"```html\n" +
		d1 +
		"\n```\n" +
		"```html\n" +
		d2 +
		"\n```\n" +
		"```html\n" +
		d3 +
		"\n```\n";

	const found = findFencedHtmlDocument(multi);
	assert.ok(found);
	assert.equal((found!.html.match(/<!DOCTYPE/gi) || []).length, 1, "首认领只能是单文档");
	assert.ok(found!.html.includes("青梧"));
	assert.ok(!found!.html.includes("店员小桃"), "不得吞掉后续 state");

	const parts = splitHtmlParts(multi);
	const htmls = parts.filter((p) => p.kind === "html");
	assert.equal(htmls.length, 3, "state1+state2+options 各一帧");
	const bodies = htmls.map((p) => (p.kind === "html" ? p.html : ""));
	assert.ok(bodies[0]!.includes("青梧"));
	assert.ok(bodies[1]!.includes("店员小桃"));
	assert.ok(bodies[2]!.includes("下一步行动建议"));
	for (const h of bodies) {
		assert.equal((h.match(/<!DOCTYPE/gi) || []).length, 1);
		assert.ok(h.length < 25_000, "单帧不得误触 program 体量阈值");
	}

	const rich = splitRichContentParts(multi, null);
	const richHtml = rich.filter((p) => p.kind === "html");
	assert.equal(richHtml.length, 3);
	assert.ok(rich.some((p) => p.kind === "text" && p.text.includes("RP 正文")));
});

test("单文档内含行首 ``` 仍用末闭，不提前截断", () => {
	// 文档中部有行首 ```（非闭合语义），真结尾在最后
	const awkward = `<!doctype html>
<html><head><title>X</title></head>
<body>
<pre>
\`\`\`
code sample
\`\`\`
</pre>
<script>1</script>
</body>
</html>`;
	// 注意：上面 pre 里是转义的，构造真正的行首 ```
	const withInner = [
		"```html",
		"<!doctype html>",
		"<html><head><title>X</title></head>",
		"<body>",
		"<pre>",
		"```",
		"code sample",
		"```",
		"</pre>",
		"<p>尾部标记UNIQUE_TAIL</p>",
		"</body>",
		"</html>",
		"```",
	].join("\n");
	const found = findFencedHtmlDocument(withInner);
	assert.ok(found);
	// 内含行首 ``` 且中段无 </html> 时，应落到末闭并保留尾部
	assert.ok(found!.html.includes("UNIQUE_TAIL"), "内含 ``` 不得截断真文档");
	assert.ok(found!.html.includes("</html>"));
});

test("实卡: 开场占位符经显示正则 → 整页交互界面", () => {
	// 判据是形状不是卡名（见 test/fixtures.ts）：某条显示规则把一个**固定字面量**触发字
	// 换成一份带脚本的整页文档。触发字取自规则自己的正则源，不写死在测试里。
	let trigger = "";
	const card = findLocalCard((c) => {
		for (const r of displayRules(extractRegexScripts(c.raw))) {
			if (!/<!doctype|<html[\s>]/i.test(r.replace) || !/<script[\s>]/i.test(r.replace)) continue;
			// 正则能匹配它自己的源文本 ⇒ 源就是纯字面量触发字，可以直接当输入喂进去
			if (!new RegExp(r.source, r.flags.replace("g", "")).test(r.source)) continue;
			trigger = r.source;
			return true;
		}
		return false;
	});
	// 发行包与 clean clone 不带样本卡；有卡则必须全绿
	if (!card) return;
	const rules = displayRules(extractRegexScripts(card.raw));
	assert.ok(rules.length >= 1, "应有显示向规则");
	const macros = { charName: "样本卡", userName: "旅人" };

	const skinned = applyCardSkin(trigger, rules, macros);
	assert.ok(skinned.includes("<!doctype html>") || skinned.includes("<!DOCTYPE html>"));
	const parts = splitRichContentParts(trigger, { rules, ...macros });
	assert.equal(parts.length, 1, "不得撕成多段 text/html");
	assert.equal(parts[0].kind, "html");
	if (parts[0].kind === "html") {
		assert.equal(parts[0].scripts, true);
		assert.ok(parts[0].html.length > 1000);
		assert.ok(/<body[\s>]/i.test(parts[0].html), "整页文档的 body 须在框里");
	}
	assert.equal(isFullInterface(skinned), true);

	// 真实会话形态：buildGreeting 加「【开场 · 卡名】」前缀
	const greeting = `【开场 · 样本卡】\n${trigger}`;
	const greParts = splitRichContentParts(greeting, { rules, ...macros });
	const htmlParts = greParts.filter((p) => p.kind === "html");
	assert.equal(htmlParts.length, 1, "带开场前缀仍须认出整页 html");
	if (htmlParts[0].kind === "html") {
		assert.equal(htmlParts[0].scripts, true);
		assert.ok(htmlParts[0].html.length > 1000);
	}
	assert.equal(isFullInterface(applyCardSkin(greeting, rules, macros)), true);
});

/**
 * 省掉 `<html>` 外壳的界面：根标签是 `<head>`、结尾只到 `</body>`（实卡状态栏的真实形状）。
 * 认领判据一旦退回「首标签名单」，这份界面就会掉进 splitTopLevelBlocks 被撕碎——
 * CSS 进空帧、`<script>` 函数体当正文印进故事（实测 5794 字泄漏）。
 */
test("围栏界面根标签是 <head>（无 doctype/html 外壳）：整份认领，不得撕碎", () => {
	const ui =
		"```\n<head>\n<style>\n  :root { --bg: #f4e4bc; }\n  .mvu-container { border: 3px solid #8b5a2b; padding: 15px; }\n</style>\n</head>\n<body>\n" +
		'<div class="mvu-container">' +
		"状态".repeat(60) +
		"</div>\n" +
		"<script>\n  const t = 1;\n  document.title = `x${t}`;\n</script>\n</body>\n```";
	const text = `她把账本合上。\n\n${ui}`;

	const found = findFencedHtmlDocument(text);
	assert.ok(found, "根标签 <head> 的围栏界面必须被认领");
	assert.ok(found!.html.startsWith("<head>"), "认领的是整份界面，从 <head> 起");
	assert.ok(found!.html.includes("mvu-container"), "body 里的面板在同一帧");
	assert.ok(found!.html.includes("const t = 1"), "脚本也在同一帧，不得泄成正文");

	const parts = splitHtmlParts(text);
	assert.equal(parts.filter((p) => p.kind === "html").length, 1, "整份界面只成一帧");
	const leaked = parts
		.filter((p) => p.kind === "text")
		.map((p) => (p.kind === "text" ? p.text : ""))
		.join("");
	assert.ok(!leaked.includes(":root"), "CSS 不得泄进正文");
	assert.ok(!leaked.includes("const t"), "JS 不得泄进正文");
	assert.ok(!leaked.includes("```"), "围栏标记不得留在正文里");
	assert.ok(leaked.includes("她把账本合上"), "界面之前的叙事照旧是正文");
});

test("认领判据是语法不是标签名：非标记语言的裸围栏仍当代码块", () => {
	// 首字符不是 `<` + 标签名 → 不认领（放宽后仍不能把普通围栏吞成界面）
	assert.equal(claimFencedHtmlDocument("```\n选择1: 留下\n选择2: 走\n```"), null);
	assert.equal(claimFencedHtmlDocument(`\`\`\`\n${"纯文本很长".repeat(60)}\n\`\`\``), null);
	// `<3` 这类不是标签
	assert.equal(claimFencedHtmlDocument(`\`\`\`\n<3 ${"心".repeat(200)}\n\`\`\``), null);
});
