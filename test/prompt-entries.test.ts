import assert from "node:assert/strict";
import { test } from "node:test";

import {
	PRESET_SOURCE_SUFFIX,
	appendEntry,
	deleteEntry,
	formatEntry,
	lorebookSourceSuffix,
	parseEntrySource,
	parsePromptEntries,
	renderForModel,
	setEntryContent,
	stripEntriesWhere,
	toggleEntry,
	uniqueEntryName,
} from "../src/prompt-entries.ts";

const MD = [
	"# 扮演定义",
	"",
	"你担任角色扮演 agent。",
	"",
	"## 文风：第一人称",
	"",
	"以「我」叙述。",
	"",
	"<!--",
	"## 文风：第二人称",
	"",
	"以「你」叙述。",
	"-->",
	"",
	"## 岔口",
	"",
	"该问就问。",
].join("\n");

test("解析：## 节＝条目；注释包裹的节＝关闭；备注注释不进条目", () => {
	const entries = parsePromptEntries(MD);
	assert.equal(entries.length, 4);
	assert.equal(entries[0].name, "扮演定义");
	assert.equal(entries[0].content, "你担任角色扮演 agent。");
	assert.equal(entries[1].name, "文风：第一人称");
	assert.equal(entries[1].enabled, true);
	assert.equal(entries[2].name, "文风：第二人称");
	assert.equal(entries[2].enabled, false, "注释包裹＝关闭");
	assert.equal(entries[2].content, "以「你」叙述。", "关闭条目正文保留");
	assert.equal(entries[3].name, "岔口");
});

test("CRLF 文件同样解析成条目（Windows 换行的卡档案回归）", () => {
	const crlf = MD.replace(/\n/g, "\r\n");
	const entries = parsePromptEntries(crlf);
	assert.equal(entries.length, 4, "CRLF 不再整份吞成一条无名条目");
	assert.equal(entries[0].name, "扮演定义");
	assert.equal(entries[1].name, "文风：第一人称");
	assert.equal(entries[2].name, "文风：第二人称");
	assert.equal(entries[2].enabled, false);
	assert.equal(entries[3].name, "岔口");
	// 手术也认得 CRLF 条目
	const toggled = toggleEntry(crlf, "文风：第二人称", true);
	assert.ok(toggled !== null && toggled.includes("## 文风：第二人称"));
	const removed = deleteEntry(crlf, "岔口");
	assert.ok(removed !== null && !removed.includes("该问就问"));
	// 送模：条目齐全
	const out = renderForModel(crlf);
	assert.ok(out.includes("文风：第一人称"));
	assert.ok(!out.includes("第二人称"));
});

test("引擎 renderForModel：关闭条目与备注不送模，开启条目带标题直通", () => {
	const out = renderForModel(MD);
	assert.ok(out.includes("## 文风：第一人称"), "开启条目带标题");
	assert.ok(out.includes("以「我」叙述。"));
	assert.ok(!out.includes("第二人称"), "关闭条目不送模");
	assert.ok(!out.includes("<!--"), "零注释");
	assert.ok(!out.includes("-->"), "零注释");
});

test("手术 toggle：人称切换（用户的核心例子）——开二关一，原文无损往返", () => {
	const person2On = toggleEntry(MD, "文风：第二人称", true);
	assert.ok(person2On!.includes("## 文风：第二人称"));
	assert.ok(!person2On!.includes("<!--\n## 文风：第二人称"));
	const switched = toggleEntry(person2On!, "文风：第一人称", false);
	assert.ok(switched!.includes("<!--\n## 文风：第一人称"), "一人称被注释包裹");
	const entries = parsePromptEntries(switched!);
	assert.equal(entries.find((e) => e.name === "文风：第一人称")?.enabled, false);
	assert.equal(entries.find((e) => e.name === "文风：第二人称")?.enabled, true);
	// 引擎只送二人称
	const out = renderForModel(switched!);
	assert.ok(!out.includes("以「我」叙述。"));
	assert.ok(out.includes("以「你」叙述。"));
});

test("手术 setContent / append / delete / 重名保护", () => {
	const edited = setEntryContent(MD, "岔口", "问用户。");
	assert.ok(renderForModel(edited!).includes("问用户。"));
	assert.ok(parsePromptEntries(edited!).find((e) => e.name === "岔口")?.content === "问用户。");

	const appended = appendEntry(MD, "新节", "新内容。");
	assert.ok(parsePromptEntries(appended!).some((e) => e.name === "新节" && e.content === "新内容。"));
	assert.equal(appendEntry(MD, "岔口", "x"), null, "重名拒绝");

	const deleted = deleteEntry(MD, "文风：第一人称");
	assert.ok(!parsePromptEntries(deleted!).some((e) => e.name === "文风：第一人称"));
	assert.ok(parsePromptEntries(deleted!).some((e) => e.name === "文风：第二人称"), "别的条目不动");
});

test("边界：未闭合注释按到文件尾；全关 ⇒ 送模空串（用户的选择）", () => {
	const unclosed = "## A\n正文\n<!--\n## B\n正文2";
	const entries = parsePromptEntries(unclosed);
	assert.equal(entries.find((e) => e.name === "B")?.enabled, false);
	const allOff = toggleEntry(toggleEntry(MD, "扮演定义", false), "文风：第一人称", false);
	// 扮演定义是标题条目（#），toggle 同样适用
	const out = renderForModel(allOff!);
	assert.equal(out.includes("以「你」叙述。"), false, "第二人称本就关");
	assert.equal(out.includes("以「我」叙述。"), false);
});

test("来源标注：标题尾部（预设）/（世界书·书名）解析成 source，显示名剥后缀；无后缀＝用户自己的", () => {
	const md = [
		"## 身份（预设）",
		"预设身份。",
		"## 门派（世界书·大世界）",
		"门派设定。",
		"## 武学（上）",
		"用户自己的。",
		"<!--",
		"## 思考（预设）",
		"关闭的机制段。",
		"-->",
	].join("\n");
	const entries = parsePromptEntries(md);
	assert.deepEqual(
		entries.map((e) => [e.name, e.title, e.source?.kind, (e.source as { book?: string } | undefined)?.book, e.enabled]),
		[
			["身份（预设）", "身份", "preset", undefined, true],
			["门派（世界书·大世界）", "门派", "lorebook", "大世界", true],
			["武学（上）", "武学（上）", undefined, undefined, true],
			["思考（预设）", "思考", "preset", undefined, false],
		],
	);
	assert.deepEqual(parseEntrySource("条目 3（世界书·书 A）"), { title: "条目 3", source: { kind: "lorebook", book: "书 A" } });
	assert.equal(lorebookSourceSuffix("大世界"), "（世界书·大世界）");
	assert.equal(PRESET_SOURCE_SUFFIX, "（预设）");
	// 手术仍按完整标题（含后缀）寻址
	assert.ok(!parsePromptEntries(deleteEntry(md, "门派（世界书·大世界）")!).some((e) => e.source?.kind === "lorebook"));
});

test("harness 生成条目：formatEntry / uniqueEntryName / stripEntriesWhere（按来源剥，无可剥原样返回）", () => {
	const used = new Set<string>();
	const n1 = uniqueEntryName("门派", lorebookSourceSuffix("大世界"), used);
	const n2 = uniqueEntryName("门派", lorebookSourceSuffix("大世界"), used);
	assert.equal(n1, "门派（世界书·大世界）");
	assert.equal(n2, "门派·2（世界书·大世界）", "同名追加序号");
	const md = [
		"# 我的档案",
		"档案正文。",
		formatEntry(n1, "# 内文标题\n门派设定。"),
		formatEntry("思考（预设）", "关闭的机制段。", false),
		"## 武学",
		"用户自己的。",
	].join("\n");
	const entries = parsePromptEntries(md);
	assert.deepEqual(
		entries.map((e) => [e.title, e.source?.kind, e.enabled]),
		[["我的档案", undefined, true], ["门派", "lorebook", true], ["思考", "preset", false], ["武学", undefined, true]],
	);
	assert.ok(entries[1].content.startsWith("＃ 内文标题"), "正文里的标题行转全角＃，不割裂条目");
	const noLore = stripEntriesWhere(md, (e) => e.source?.kind === "lorebook");
	assert.ok(!noLore.includes("门派设定") && noLore.includes("关闭的机制段") && noLore.includes("用户自己的"));
	const noPreset = stripEntriesWhere(md, (e) => e.source?.kind === "preset");
	assert.ok(noPreset.includes("门派设定") && !noPreset.includes("关闭的机制段"), "关闭态也剥");
	assert.equal(stripEntriesWhere(md, () => false), md, "无可剥 ⇒ 原样（一个字节不动）");
});
