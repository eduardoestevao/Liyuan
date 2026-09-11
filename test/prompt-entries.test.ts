import assert from "node:assert/strict";
import { test } from "node:test";

import {
	appendEntry,
	deleteEntry,
	parsePromptEntries,
	renderForModel,
	setEntryContent,
	toggleEntry,
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
