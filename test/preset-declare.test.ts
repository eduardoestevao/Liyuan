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
		card: "角色",
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

test("translatePresetWithDeclaration：逐块条目＋关闭选项，不合并", () => {
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
		card: "角色",
		createdAt: "2026-09-12T00:00:00.000Z",
		entries: parsed.entries,
	};
	const r = translatePresetWithDeclaration(doc, declaration, { charName: "角色", userName: "用户" });

	// APPEND：# 预设提示词 ＋ 身份活条目
	assert.match(r.appendMarkdown, /^# 预设提示词/);
	assert.match(r.appendMarkdown, /## 身份（预设）/);
	assert.match(r.appendMarkdown, /资深写手/);
	assert.ok(!r.appendMarkdown.includes("白描"));

	// AGENTS：文风活条目；机制块关闭条目；预设里关掉的块＝选项目录（关闭条目）
	assert.match(r.agentsSection, /## 文风（预设）/);
	assert.match(r.agentsSection, /白描/);
	assert.match(r.agentsSection, /<!--\n## 思考（预设）/);
	assert.match(r.agentsSection, /<!--\n## 格式（预设）/);
	assert.match(r.agentsSection, /<!--\n## 关闭的（预设）/);
	assert.match(r.agentsSection, /不该出现/);
	assert.ok(!r.agentsSection.includes("资深写手"));
	assert.ok(!r.agentsSection.includes("<Lore>")); // wrapper 不落任何形态

	// 去向账
	const byAction = (a: string) => r.lines.filter((l) => l.action === a).map((l) => l.identifier);
	assert.deepEqual(byAction("append"), ["main"]);
	assert.deepEqual(byAction("agents"), ["style"]);
	assert.deepEqual(byAction("wrapper"), ["w1", "w2"]);
	assert.deepEqual(byAction("disabled"), ["cot", "fmt"]);
	assert.deepEqual(byAction("off-option"), ["off"]);
	assert.deepEqual(byAction("dropped-prefill"), ["pf"]);
	assert.deepEqual(byAction("skipped-marker"), ["worldInfoBefore"]);
});

test("stripPresetEntries：剥掉（预设）条目（含注释态）与旧式「转译自」，保留用户自己的", () => {
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
		"## 预设写作规则（转译自「旧版」）",
		"",
		"旧伞形板块。",
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
		["我的档案", "用户自己的条目"],
	);
	assert.ok(stripped.includes("用户内容"));
	assert.ok(!stripped.includes("预设内容"));
	assert.ok(!stripped.includes("轻小说文风"));
	assert.ok(!stripped.includes("旧伞形板块"));
});
