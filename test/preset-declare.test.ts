import assert from "node:assert/strict";
import { test } from "node:test";

import {
	assembleForDeclare,
	buildDeclarePrompt,
	declarePieces,
	parseDeclareResponse,
	stripPresetEntries,
	translatePresetWithDeclaration,
	type PresetDeclaration,
} from "../src/preset-declare.ts";
import { parsePromptEntries } from "../src/prompt-entries.ts";
import { loadPresetDoc } from "../src/preset-doc.ts";

/** 最小酒馆预设：身份/文风/包装/思考/格式/关闭块/末条预填，marker 全套 */
const rawPreset: Record<string, unknown> = {
	prompts: [
		{ identifier: "main", name: "身份", role: "system", content: "你是资深写手。" },
		{ identifier: "style", name: "文风", role: "system", content: "文风：白描为主。" },
		{ identifier: "w1", name: "包装开", role: "system", content: "<Lore>" },
		{ identifier: "worldInfoBefore", name: "World Info (before)", marker: true },
		{ identifier: "chatHistory", name: "Chat History", marker: true },
		{ identifier: "w2", name: "包装闭", role: "system", content: "</Lore>" },
		{ identifier: "cot", name: "思考", role: "system", content: "用 <thinking> 包裹逐项自检后输出。" },
		{ identifier: "fmt", name: "格式", role: "system", content: "正文用 <content> 包裹。" },
		{ identifier: "off", name: "关闭的", role: "system", content: "不该出现" },
		{ identifier: "pf", name: "预填", role: "assistant", content: "好，开始。" },
	],
	prompt_order: [
		{
			character_id: 100001,
			order: [
				{ identifier: "main", enabled: true },
				{ identifier: "style", enabled: true },
				{ identifier: "w1", enabled: true },
				{ identifier: "worldInfoBefore", enabled: true },
				{ identifier: "chatHistory", enabled: true },
				{ identifier: "w2", enabled: true },
				{ identifier: "cot", enabled: true },
				{ identifier: "fmt", enabled: true },
				{ identifier: "off", enabled: false },
				{ identifier: "pf", enabled: true },
			],
		},
	],
};

const doc = loadPresetDoc(rawPreset, "测试预设");
const assembled = assembleForDeclare(doc, { charName: "角色", userName: "用户" });

test("declarePieces：排除 marker 与末条 assistant 预填，保留文档序", () => {
	const pieces = declarePieces(assembled);
	assert.deepEqual(
		pieces.map((p) => p.id),
		["main", "style", "w1", "w2", "cot", "fmt"],
	);
	assert.equal(pieces[0].where, "before");
	assert.equal(pieces[4].where, "after"); // cot 在 chatHistory 之后
});

test("buildDeclarePrompt：带标识符、站别判据与输出格式", () => {
	const { systemPrompt, userText } = buildDeclarePrompt(declarePieces(assembled), {
		preset: "测试预设",
	});
	assert.match(systemPrompt, /identity/);
	assert.match(systemPrompt, /拿不准的分段一律 writing/);
	assert.match(systemPrompt, /\{"id"/);
	for (const id of ["main", "style", "w1", "w2", "cot", "fmt"]) assert.ok(userText.includes(id));
	assert.match(userText, /资深写手/);
});

test("parseDeclareResponse：合法站别收下；未知站别落 writing；漏声明的段落落 writing", () => {
	const pieces = declarePieces(assembled);
	const resp = [
		"```json",
		"[",
		'{"id":"main","station":"identity","note":"破限身份"},',
		'{"id":"style","station":"writing"},',
		'{"id":"w1","station":"wrapper"},',
		'{"id":"cot","station":"thinking"},',
		'{"id":"fmt","station":"bogus"}',
		"]",
		"```",
	].join("\n");
	const parsed = parseDeclareResponse(resp, pieces);
	// w2 漏声明、fmt 站别非法 → 都保守落 writing
	assert.equal(parsed.entries.find((e) => e.identifier === "w2")?.station, "writing");
	assert.equal(parsed.entries.find((e) => e.identifier === "fmt")?.station, "writing");
	assert.equal(parsed.entries.find((e) => e.identifier === "main")?.station, "identity");
	assert.equal(parsed.entries.find((e) => e.identifier === "cot")?.station, "thinking");
	assert.deepEqual(parsed.defaulted, ["w2"]);
	assert.equal(parsed.declared, 5);
});

test("translatePresetWithDeclaration：逐块（预设）条目，机制段关闭条目；未启用块只入账不取内容", () => {
	const pieces = declarePieces(assembled);
	const parsed = parseDeclareResponse(
		JSON.stringify([
			{ id: "main", station: "identity" },
			{ id: "style", station: "writing" },
			{ id: "w1", station: "wrapper" },
			{ id: "w2", station: "wrapper" },
			{ id: "cot", station: "thinking" },
			{ id: "fmt", station: "output" },
		]),
		pieces,
	);
	const declaration: PresetDeclaration = {
		version: 1,
		preset: "测试预设",
		createdAt: "2026-09-12T00:00:00.000Z",
		entries: parsed.entries,
	};
	const r = translatePresetWithDeclaration(doc, declaration, { charName: "角色", userName: "用户" });

	// APPEND：# 预设提示词（预设）标题条目 ＋ 身份活条目——全部带来源，重转译可整体剥掉
	assert.match(r.appendMarkdown, /^# 预设提示词（预设）/);
	assert.match(r.appendMarkdown, /## 身份（预设）/);
	assert.match(r.appendMarkdown, /资深写手/);
	assert.ok(!r.appendMarkdown.includes("白描"));
	assert.ok(parsePromptEntries(r.appendMarkdown).every((e) => e.source?.kind === "preset"));
	assert.equal(stripPresetEntries(r.appendMarkdown), "", "产物全是预设条目 ⇒ 剥净");

	// AGENTS：文风活条目；机制块关闭条目；预设里关着的块＝上游开关的结果，不落任何形态
	assert.match(r.agentsSection, /## 文风（预设）/);
	assert.match(r.agentsSection, /白描/);
	assert.match(r.agentsSection, /<!--\n## 思考（预设）/);
	assert.match(r.agentsSection, /<!--\n## 格式（预设）/);
	assert.ok(!r.agentsSection.includes("不该出现"));
	assert.ok(!r.agentsSection.includes("资深写手"));
	assert.ok(!r.agentsSection.includes("<Lore>")); // wrapper 不落任何形态

	// 条目引擎能解析产物：来源全是 preset，关闭的机制条目 enabled=false 且不进送模
	const entries = parsePromptEntries(r.agentsSection);
	assert.deepEqual(
		entries.map((e) => [e.title, e.source?.kind, e.enabled]),
		[
			["文风", "preset", true],
			["思考", "preset", false],
			["格式", "preset", false],
		],
	);

	// 去向账
	const byAction = (a: string) => r.lines.filter((l) => l.action === a).map((l) => l.identifier);
	assert.deepEqual(byAction("append"), ["main"]);
	assert.deepEqual(byAction("agents"), ["style"]);
	assert.deepEqual(byAction("wrapper"), ["w1", "w2"]);
	assert.deepEqual(byAction("disabled"), ["cot", "fmt"]);
	assert.deepEqual(byAction("skipped-disabled"), ["off"]);
	assert.deepEqual(byAction("dropped-prefill"), ["pf"]);
	assert.deepEqual(byAction("skipped-marker"), ["worldInfoBefore"]);
});

test("translatePresetWithDeclaration：预设开关拨动后重编译，产物跟着变（选项在上游）", () => {
	const flipped = JSON.parse(JSON.stringify(rawPreset)) as typeof rawPreset;
	const order = (flipped.prompt_order as Array<{ order: Array<{ identifier: string; enabled: boolean }> }>)[0].order;
	for (const o of order) {
		if (o.identifier === "off") o.enabled = true;
		if (o.identifier === "style") o.enabled = false;
	}
	const doc2 = loadPresetDoc(flipped, "测试预设");
	const pieces = declarePieces(assembleForDeclare(doc2, { charName: "角色", userName: "用户" }));
	assert.ok(pieces.some((p) => p.id === "off") && !pieces.some((p) => p.id === "style"));
	const parsed = parseDeclareResponse(JSON.stringify([{ id: "off", station: "writing" }]), pieces);
	const r = translatePresetWithDeclaration(
		doc2,
		{ version: 1, preset: "测试预设", createdAt: "2026-09-12T00:00:00.000Z", entries: parsed.entries },
		{ charName: "角色", userName: "用户" },
	);
	assert.match(r.agentsSection, /## 关闭的（预设）\n\n不该出现/);
	assert.ok(!r.agentsSection.includes("白描"));
});

test("stripPresetEntries：剥掉（预设）来源条目（含注释态），保留用户自己的与世界书来源的", () => {
	const mixed = [
		"# 我的档案",
		"",
		"## 世界观（预设）",
		"",
		"预设内容。",
		"",
		"<!--",
		"## 轻小说文风（预设）",
		"",
		"关闭的选项。",
		"-->",
		"",
		"## 门派（世界书·大世界）",
		"",
		"世界书内容。",
		"",
		"## 用户自己的条目",
		"",
		"用户内容。",
		"",
	].join("\n");
	const stripped = stripPresetEntries(mixed);
	const entries = parsePromptEntries(stripped);
	assert.deepEqual(
		entries.map((e) => e.name),
		["我的档案", "门派（世界书·大世界）", "用户自己的条目"],
	);
	assert.ok(stripped.includes("用户内容"));
	assert.ok(stripped.includes("世界书内容"));
	assert.ok(!stripped.includes("预设内容"));
	assert.ok(!stripped.includes("轻小说文风"));
});
