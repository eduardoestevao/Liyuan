import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cardAgentsPath, projectCardToAgents } from "../src/card-agents.ts";
import { buildStageInjection, buildStageSystemPrompt } from "../src/stage/assemble.ts";
import { defaultState } from "../src/state.ts";
import { loadStageMaterials } from "../src/stage/materials.ts";
import { DEFAULT_CONFIG, type RpConfig } from "../src/types.ts";
import type { CharacterCard } from "../src/types.ts";

const card: CharacterCard = {
	name: "冷鹰",
	description: "监察院使，{{user}} 的旧仇。",
	personality: "冷傲干练",
	scenario: "监察院公房",
	firstMes: "你来了。",
	mesExample: "",
	systemPrompt: "文风厚重。",
	postHistoryInstructions: "每拍末尾留钩子。",
	creatorNotes: "",
	alternateGreetings: [],
	tags: [],
	book: [],
};
const config: RpConfig = { ...DEFAULT_CONFIG, userName: "怀瑾" };
const lore = [
	{ uid: 1, keys: [], secondaryKeys: [], comment: "基础设定：世界观", content: "大乾乱世。", constant: true, enabled: true, selective: false, order: 0 },
] as never;

test("投影全文：字段+蓝灯+作者指令+末端指令，宏求值，AGENTS.md 形状", () => {
	const text = projectCardToAgents(card, lore, config);
	assert.ok(text.startsWith("# 你扮演的角色：冷鹰"), "角色标题");
	assert.ok(text.includes("监察院使，怀瑾 的旧仇。"), "{{user}} 求值");
	assert.ok(text.includes("## 性格\n冷傲干练"));
	assert.ok(text.includes("## 基础设定：世界观\n大乾乱世。"), "蓝灯逐条带标题");
	assert.ok(text.includes("# 卡作者附加指令\n文风厚重。"));
	assert.ok(text.includes("# 卡作者末端指令\n每拍末尾留钩子。"), "B8 末端指令进档案");
});

test("AGENTS.md 在场 ⇒ 文件为准：卡 sections 让位、零双份；不在场 ⇒ 投影照旧", () => {
	const withFile = buildStageSystemPrompt({
		card, config, constantLore: lore,
		cardAgents: "# 你扮演的角色：冷鹰\n（档案版内容）",
		tools: false,
	});
	assert.ok(withFile.includes("（档案版内容）"), "档案内容在场");
	assert.ok(!withFile.includes("# 世界设定（常驻事实）"), "蓝灯投影让位");
	assert.ok(!withFile.includes("卡作者附加指令"), "卡作者段让位");
	assert.ok(!withFile.includes("监察院使，怀瑾 的旧仇"), "卡字段投影让位（不双份）");
	assert.ok(withFile.includes("# 用户扮演：怀瑾"), "用户身份不受影响（harness 侧）");

	const noFile = buildStageSystemPrompt({ card, config, constantLore: lore, tools: false });
	assert.ok(noFile.includes("# 你扮演的角色：冷鹰") && noFile.includes("# 世界设定（常驻事实）"), "无档案时投影照旧");
});

test("AGENTS.md 在场 ⇒ 注入侧卡末端指令让位（B8）", () => {
	const withFile = buildStageInjection({
		state: defaultState(),
		activatedLore: [], card, config, cardAgentsActive: true,
	});
	assert.ok(!withFile.includes("【卡作者末端指令】"), "末端指令已在档案里，注入不双份");
	const noFile = buildStageInjection({
		state: defaultState(),
		activatedLore: [], card, config,
	});
	assert.ok(noFile.includes("【卡作者末端指令】"), "无档案时注入照旧");
});

test("端到端：AGENTS.md 文件存在 ⇒ materials 读到 + marker 材料让位；指纹变化即失效", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-agents-"));
	process.env.LIYUAN_CODING_AGENT_DIR = join(cwd, "agentDir");
	try {
		writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: { name: "冷鹰", description: "公房里的院使", first_mes: "你来了。" } }));
		writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", userName: "怀瑾" }));
		mkdirSync(join(cwd, "agentDir"), { recursive: true });

		// 无档案：投影路径
		const m1 = loadStageMaterials(cwd);
		assert.equal(m1.cardAgents, "");
		assert.equal(m1.markerMaterials.charDescription, "公房里的院使", "无档案时 marker 照常交货");

		// 建档案：文件为准
		writeFileSync(cardAgentsPath(cwd), "# 你扮演的角色：冷鹰\n档案版。", "utf8");
		const m2 = loadStageMaterials(cwd);
		assert.ok(m2.cardAgents.includes("档案版。"), "档案读到");
		assert.equal(m2.markerMaterials.charDescription, undefined, "档案在场时 marker 卡字段让位（不双份）");
	} finally {
		delete process.env.LIYUAN_CODING_AGENT_DIR;
		rmSync(cwd, { recursive: true, force: true });
	}
});
