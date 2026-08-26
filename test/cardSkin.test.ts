import assert from "node:assert/strict";
import test from "node:test";
import { applyCardSkin, requiredLiteral } from "../web/src/cardSkin.ts";

const M = { charName: "青梧", userName: "旅人" };
const wrapOpen = { name: "状态栏", source: "<StatusBlock>", flags: "gs", replace: '<div style="x"><status>' };
const wrapClose = { name: "状态栏2", source: "</StatusBlock>", flags: "gs", replace: "</status></div>" };

test("皮肤包装:开闭标签替换为卡作者 HTML(开闭标签换皮模式)", () => {
	const out = applyCardSkin("正文\n<StatusBlock>\nHP: 80\n</StatusBlock>\n尾", [wrapOpen, wrapClose], M);
	assert.ok(out.includes('<div style="x"><status>'));
	assert.ok(out.includes("</status></div>"));
	assert.ok(!out.includes("<StatusBlock>"));
});

test("捕获组 $1 重排进模板", () => {
	const rule = { name: "血条", source: "HP[:：]\\s*(\\d+)", flags: "g", replace: '<b class="hp">$1</b>' };
	assert.equal(applyCardSkin("HP: 80", [rule], M), '<b class="hp">80</b>');
});

test("宏:find 与 replace 里的 {{user}}/{{char}} 生效;find 侧转义安全", () => {
	const rule = { name: "呼名", source: "{{char}}(说)", flags: "g", replace: "「{{char}}」$1" };
	assert.equal(applyCardSkin("青梧说", [rule], M), "「青梧」说");
});

test("{{match}} 映射整段命中", () => {
	const rule = { name: "高亮", source: "\\*\\*.+?\\*\\*", flags: "g", replace: "<mark>{{match}}</mark>" };
	assert.equal(applyCardSkin("**重要**", [rule], M), "<mark>**重要**</mark>");
});

test("单条规则运行期出错不影响其余规则", () => {
	// flags 合法但 source 在应用期构造失败的场景难造,退一步:构造期抛错由 try/catch 吞掉
	const bad = { name: "坏", source: "(?<", flags: "g", replace: "x" };
	assert.equal(applyCardSkin("<StatusBlock>a</StatusBlock>", [bad, wrapOpen, wrapClose], M).includes("<status>"), true);
});

test("空规则原文返回", () => {
	assert.equal(applyCardSkin("原文", [], M), "原文");
});

test("字面量 $' 不得被 String.replace 特殊序列吃掉（程序卡 '$' 字符）", () => {
	// 模拟地图 TILE 字符表：'|','$','T'
	const rule = {
		name: "dollar-char",
		source: "TOKEN",
		flags: "g",
		replace: "['|','$','T']",
	};
	assert.equal(applyCardSkin("TOKEN", [rule], M), "['|','$','T']");
});

test("字面 $$ 与捕获组并存", () => {
	const rule = {
		name: "price",
		source: "price:(\\d+)",
		flags: "g",
		replace: "$$ $1",
	};
	assert.equal(applyCardSkin("price:42", [rule], M), "$ 42");
});

test("长替换串（程序卡）不展开 $&；无捕获时 $1 保持字面", () => {
	const payload = `${"x".repeat(9000)} placement.replace(/\\$&/g, args[0]); $1 end`;
	const rule = { name: "prog", source: "TOKEN", flags: "g", replace: payload };
	const out = applyCardSkin("TOKEN", [rule], M);
	assert.ok(out.includes("/\\$&/g"), "卡内 /\\$&/g 必须原样");
	// TOKEN 无捕获组 → $1 保持字面
	assert.ok(out.includes(" $1 end"), "无对应捕获时 $1 保持字面");
	assert.ok(!out.includes("/\\TOKEN/g"), "不得把 $& 展开成命中文本");
});

test("长替换串仍展开有效 $2（实卡状态栏 rawData=`$2`）", () => {
	const body = "『姓名』: 明月\n『内心想法』: 想逃";
	const payload =
		"```html\n<!DOCTYPE html><html><body><script>const rawData = `$2`;</script><div id=x></div></body></html>\n```".replace(
			"```html\n",
			"```html\n" + "y".repeat(9000) + "\n",
		);
	// 保证超阈值
	assert.ok(payload.length > 8000);
	const rule = {
		name: "state-bar",
		source: "<(state\\d+)>([\\s\\S]+?)<\\/\\1>",
		flags: "g",
		replace: payload,
	};
	const out = applyCardSkin(`<state1>\n${body}\n</state1>`, [rule], M);
	assert.ok(!out.includes("`$2`") && !out.includes("rawData = `$2`"), "不得残留字面 $2");
	assert.ok(out.includes("明月") && out.includes("想逃"), "捕获正文须注入模板");
});

// ——— 字面量预筛（8/19 性能修复）：不改语义，只跳过不可能匹配的规则 ———
test("预筛：从作者正则提取必须出现的字面串", () => {
	// CoT 隐藏成语：闭合标签就是必要条件
	assert.equal(requiredLiteral(String.raw`([\s\S]*?)<\/think_fox~>\s*?`), "</think_fox~>");
	assert.equal(requiredLiteral(String.raw`<state2>([\s\S]*?)<\/state2>`), "</state2>");
	// 拿不准一律 null（照旧全跑）：分支 / 否定断言 / 可选组
	assert.equal(requiredLiteral(String.raw`(<a>|<b>)x`), null);
	assert.equal(requiredLiteral(String.raw`(?!<keep>)<drop_this>`), null);
	assert.equal(requiredLiteral(String.raw`abc(?=xyz)def`), null); // 断言内外不连续，不筛
	// 标签名在分组里：字面串必须跨组拼接成 `</think`——只提 `think` 太弱（卡的 HTML/JS 满是 think
	// 字样），预筛会放行这条贪婪正则继续 O(n²) 空扫（8/19 CPU profile：单条 11 秒）
	assert.equal(requiredLiteral(String.raw`([\s\S]*)<\/(think_?fox~?)>`), "</think");
	assert.equal(requiredLiteral(String.raw`([\s\S]*?)<\/(think_?fox~?)>\s*?`), "</think");
	assert.equal(requiredLiteral(String.raw`(<opt_group>)?<x>`), null);
	// 纯字符类/量词构成的正则没有必要字面量
	assert.equal(requiredLiteral(String.raw`[0-9]+`), null);
	// 可选的字面量不算必要
	assert.equal(requiredLiteral(String.raw`<abc>?<defgh>`), "<defgh>"); // ? 只作用于前一个 >
});

test("预筛：不改变匹配结果——命中的照样命中，且大小写规则各自成立", () => {
	const hide = { name: "h", source: String.raw`([\s\S]*?)<\/think_fox~>\s*?`, flags: "g", replace: "" };
	const M = { charName: "", userName: "" };
	// 含闭合标签 → 照旧删掉思维链
	assert.equal(applyCardSkin("<think_fox~>思考</think_fox~>正文", [hide] as never, M), "正文");
	// 不含闭合标签 → 规则被跳过，文本原样（与老实现同结果，只是不再 O(n²) 空扫）
	const noTag = "只有正文没有思维链标签。".repeat(20);
	assert.equal(applyCardSkin(noTag, [hide] as never, M), noTag);
	// i 标记：大写标签也要命中（预筛比对必须同样忽略大小写）
	const hideI = { ...hide, flags: "gi" };
	assert.equal(applyCardSkin("<THINK_FOX~>思考</THINK_FOX~>正文", [hideI] as never, M), "正文");
});

test("预筛：前一条规则造出的标记，后一条规则仍能命中（缓存不得失效误跳）", () => {
	const M = { charName: "", userName: "" };
	const make = { name: "make", source: String.raw`占位`, flags: "g", replace: "<mark_x>值</mark_x>" };
	const eat = { name: "eat", source: String.raw`<mark_x>([\s\S]*?)<\/mark_x>`, flags: "gi", replace: "[$1]" };
	assert.equal(applyCardSkin("前占位后", [make, eat] as never, M), "前[值]后");
});
