import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { cardProjectOperation, cardResources, outlineCardProject, prepareCardProject } from "../src/card-authoring.ts";
import { buildCardOutline } from "../src/card-outline.ts";
import type { CardOutline, CardSectionId } from "../src/card-authoring-types.ts";

/** 覆盖每条结构判据一项；标题故意不带任何可猜的词，证明分组不看措辞。 */
function fixture() {
	return {
		spec: "chara_card_v3", spec_version: "3.0",
		data: {
			name: "投影测试", description: "描述", creator: "作者", character_version: "1.0", tags: ["a", "b"],
			system_prompt: "", post_history_instructions: "末端",
			first_mes: "开场 <StatusPlaceHolderImpl/>", alternate_greetings: ["<div>备选</div>", ""], group_only_greetings: ["群"],
			character_book: { entries: [
				{ id: 1, comment: "甲", content: "有关键词的知识", keys: ["剑"], constant: false, enabled: true, extensions: { position: 0 } },
				{ id: 2, comment: "乙", content: "常驻块", keys: [], constant: true, enabled: true, extensions: { position: 4, depth: 3, role: 0 } },
				{ id: 3, comment: "丙", content: "输出时写 <UpdateVariable> 块", keys: [], constant: true, extensions: { position: 4, depth: 0 } },
				{ id: 4, comment: "丁", content: "check:\n- 好感度", keys: [], constant: true },
				{ id: 5, comment: "戊", content: "<% if (x) { %>阶段<% } %>", keys: ["x"], constant: true },
				{ id: 6, comment: "===分隔===", content: "", keys: [], constant: false, enabled: false },
				{ id: 7, comment: "己", content: "既无关键词也不常驻", keys: [], constant: false },
				{ id: 8, comment: "[initvar]", content: "好感度: 0", keys: [], constant: true, enabled: false },
			] },
			extensions: {
				depth_prompt: { prompt: "深度", depth: 4, role: "system" },
				regex_scripts: [
					{ id: "ui", scriptName: "壹", findRegex: "<Panel/>", replaceString: "<div>面板 https://cdn.example.test/a.js</div>", placement: [2], markdownOnly: true },
					{ id: "strip", scriptName: "贰", findRegex: "/<think>[\\s\\S]*?<\\/think>/g", replaceString: "", placement: [2], markdownOnly: true, promptOnly: true },
					{ id: "prompt", scriptName: "叁", findRegex: "X", replaceString: "Y", placement: [2], promptOnly: true },
					{ id: "off", scriptName: "肆", findRegex: "<Old/>", replaceString: "<div>旧</div>", placement: [2], markdownOnly: true, disabled: true },
					{ id: "lore", scriptName: "伍", findRegex: "Z", replaceString: "W", placement: [5], promptOnly: true },
				],
				tavern_helper: {
					scripts: [
						{ id: "s1", name: "库", content: "import 'https://cdn.example.test/lib.js';\n", enabled: true, button: { enabled: true, buttons: [{ name: "b" }] } },
						{ id: "s2", name: "码", content: "const a = 1; fetch('https://api.example.test/x');", enabled: false },
					],
					variables: { phone: { name: "x" } },
				},
			},
		},
	};
}

function section(outline: CardOutline, id: CardSectionId) {
	return outline.sections.find(s => s.id === id)!;
}
function labels(outline: CardOutline, id: CardSectionId) {
	return section(outline, id).items.map(i => i.label);
}

test("板块投影只看 spec 结构，不看标题", () => {
	const raw = fixture();
	const outline = buildCardOutline(raw, cardResources(raw));
	assert.deepEqual(labels(outline, "settings"), ["卡名", "描述", "性格", "场景", "对话示例", "作者注", "作者 / 版本 / 标签", "深度提示", "世界书设置"]);
	assert.deepEqual(section(outline, "settings").items.find(i => i.key === "settings-meta")?.facts, { creator: "作者", version: "1.0", tags: 2, spec: "chara_card_v3 3.0" });
	assert.deepEqual(labels(outline, "rules"), ["卡内系统提示", "卡内末端提示"]);
	assert.deepEqual(labels(outline, "greetings"), ["默认开场", "备选开场 1", "备选开场 2", "群聊开场 1"]);
	assert.equal(section(outline, "greetings").items[0].facts.placeholder, true);
	assert.equal(section(outline, "greetings").items[1].facts.html, true);
	assert.deepEqual(labels(outline, "lore-knowledge"), ["甲"]);
	assert.deepEqual(labels(outline, "lore-constant"), ["乙"]);
	assert.deepEqual(section(outline, "lore-constant").items[0].facts, { position: "at_depth", constant: true, keys: 0, depth: 3, role: 0, id: 2 });
	assert.deepEqual(labels(outline, "mvu"), ["丙", "丁", "[initvar]", "卡级变量初值"]);
	assert.equal(section(outline, "mvu").items[2].enabled, false);
	assert.deepEqual(labels(outline, "ejs"), ["戊"]);
	assert.deepEqual(labels(outline, "other"), ["===分隔===", "己", "伍"], "空条目、既无关键词也不常驻、梨园不消费的 placement 各自进其他");
	assert.deepEqual(labels(outline, "ui"), ["壹", "肆"]);
	const ui = section(outline, "ui").items;
	assert.equal(ui[0].resources.length, 2, "界面项挂匹配与模板两个资源");
	assert.equal(ui[0].facts.literalTag, true);
	assert.equal(ui[1].enabled, false, "停用正则按启用时的角色归类");
	assert.deepEqual(labels(outline, "prompt-regex"), ["贰", "叁"]);
	assert.equal(section(outline, "prompt-regex").items[0].facts.literalTag, false);
	assert.deepEqual(labels(outline, "scripts"), ["库", "码"]);
	assert.deepEqual(section(outline, "scripts").items[0].facts, { type: "", buttons: 1, importOnly: true, remote: 1, data: 0 });
	assert.deepEqual(labels(outline, "deps"), ["cdn.example.test", "api.example.test"]);
	assert.equal(section(outline, "deps").items[0].facts.references, 2, "同一主机跨正则与脚本合并计数");
	assert.equal(outline.declared, 0);
	const all = outline.sections.flatMap(s => s.items);
	assert.equal(new Set(all.map(i => i.key)).size, all.length, "目录键唯一");
	for (const item of all) for (const value of Object.values(item.facts)) assert.ok(["string", "number", "boolean"].includes(typeof value));
});

test("声明覆盖默认板块，且能撤销", () => {
	const raw = fixture();
	const resources = cardResources(raw);
	const base = buildCardOutline(raw, resources);
	const key = section(base, "lore-knowledge").items[0].key;
	const outline = buildCardOutline(raw, resources, { [key]: "lore-constant", "settings-meta": "settings", 未知键: "ui" });
	assert.deepEqual(labels(outline, "lore-knowledge"), []);
	const moved = section(outline, "lore-constant").items.find(i => i.key === key)!;
	assert.equal(moved.declared, true);
	assert.equal(moved.defaultSection, "lore-knowledge");
	assert.equal(outline.declared, 1, "与默认相同的声明不算覆盖，未知键忽略");
});

function project(t: TestContext) {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-outline-"));
	const folder = join(cwd, "cards", "card");
	mkdirSync(folder, { recursive: true });
	const card = join(folder, "card.json");
	writeFileSync(card, JSON.stringify(fixture()));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	return { cwd, card };
}

test("工程操作：outline 概览 / 单板块 / assign 落盘", t => {
	const { cwd, card } = project(t);
	const before = outlineCardProject(cwd, card);
	assert.equal(section(before, "ui").items.length, 2, "未展开也能投影原卡");
	assert.throws(() => cardProjectOperation(cwd, card, { action: "assign", key: "settings-meta", section: "ui" }), /先展开/);
	prepareCardProject(cwd, card);
	const overview = cardProjectOperation(cwd, card, { action: "outline" }) as { sections: Array<{ id: string; count: number; items?: unknown }> };
	assert.equal(overview.sections.find(s => s.id === "lore-knowledge")?.count, 1);
	assert.equal(overview.sections[0].items, undefined, "概览不带条目");
	const one = cardProjectOperation(cwd, card, { action: "outline", section: "scripts" }) as CardOutline;
	assert.deepEqual(one.sections.map(s => s.id), ["scripts"]);
	assert.throws(() => cardProjectOperation(cwd, card, { action: "outline", section: "nope" }), /未知板块/);
	const key = section(before, "lore-knowledge").items[0].key;
	assert.throws(() => cardProjectOperation(cwd, card, { action: "assign", key, section: "nope" }), /未知板块/);
	assert.throws(() => cardProjectOperation(cwd, card, { action: "assign", key: "missing", section: "ui" }), /找不到目录项/);
	const assigned = cardProjectOperation(cwd, card, { action: "assign", key, section: "rules" }) as CardOutline;
	assert.deepEqual(labels(assigned, "rules"), ["卡内系统提示", "卡内末端提示", "甲"]);
	const file = JSON.parse(readFileSync(join(cwd, "cards", "card", "创作", "sections.json"), "utf8"));
	assert.deepEqual(file, { version: 1, items: { [key]: "rules" } });
	const restored = cardProjectOperation(cwd, card, { action: "assign", key }) as CardOutline;
	assert.deepEqual(labels(restored, "lore-knowledge"), ["甲"]);
	assert.deepEqual(JSON.parse(readFileSync(join(cwd, "cards", "card", "创作", "sections.json"), "utf8")), { version: 1, items: {} });
	assert.equal((cardProjectOperation(cwd, card, { action: "outline", full: true }) as CardOutline).sections.flatMap(s => s.items).length > 10, true);
});
