import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	buildStageInjection,
	buildStageSystemPrompt,
	detectsLanguageMismatch,
	rebuildHistory,
	stateFromBranch,
	type BranchEntryLike,
} from "../src/stage/assemble.ts";
import type { DisplayRule } from "../src/cardfront.ts";
import { extractDraftRules } from "../src/draft.ts";
import { assemblePresetAfter, constantLoreOf, loadStageMaterials } from "../src/stage/materials.ts";
import { declarePieces, assembleForDeclare, parseDeclareResponse, translatePresetWithDeclaration } from "../src/preset-declare.ts";
import { renderForModel } from "../src/prompt-entries.ts";
import { defaultState } from "../src/state.ts";
import { DEFAULT_CONFIG, type RpConfig } from "../src/types.ts";

// ---------------- 分支 → 历史 ----------------

const userE = (text: string): BranchEntryLike => ({
	type: "message",
	message: { role: "user", content: [{ type: "text", text }] },
});
const asstE = (text: string): BranchEntryLike => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

test("rebuildHistory：开场白→assistant、补丁套用、过程条目蒸发、同角色合并", () => {
	const branch: BranchEntryLike[] = [
		{ type: "custom_message", customType: "rp-greeting", content: "【开场】她回头。" },
		{ type: "custom", customType: "rp-state", data: { scene: "山门" } },
		userE("我上前行礼。"),
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "内心盘算……" },
					{ type: "text", text: "云澜受了半礼，袖口沾着晨露。" },
				],
			},
		},
		// 同拍第二条 assistant（旧会话工具轮之间的散文本）→ 应与上条合并
		asstE("「起来吧。」"),
		// 补丁：定点替换
		{ type: "custom_message", customType: "rp-draft-op", content: JSON.stringify({ old: "晨露", new: "夜霜" }) },
		// 工具回执（旧会话残留）→ 不进历史
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
		userE("说明来意。"),
	];
	const { history, lastUserText, lastNarrativeText } = rebuildHistory(branch);

	assert.equal(history[0].role, "assistant");
	assert.ok(history[0].text.includes("【开场】"));
	assert.equal(history.length, 4); // 开场 / user / assistant(合并) / user
	assert.ok(history[2].text.includes("夜霜"), "补丁应套用");
	assert.ok(!history[2].text.includes("晨露"));
	assert.ok(history[2].text.includes("「起来吧。」"), "同角色相邻合并");
	assert.ok(!history[2].text.includes("内心盘算"), "thinking 不进历史");
	assert.equal(lastUserText, "说明来意。");
	assert.ok(lastNarrativeText.includes("夜霜"), "语言检测源=最后台上叙事（含补丁）");
});

test("rebuildHistory：送模侧作者正则（promptOnly/破坏性）剥「作者不想让模型看」的块", () => {
	const branch: BranchEntryLike[] = [
		userE("你先进去。"),
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "正文一句。\n\n<w2g>选项：1 走 2 停</w2g>\n\n<SexualScene>内容</SexualScene>" },
				],
			},
		},
	];
	const promptRulesFixture: DisplayRule[] = [
		// TG-ai看不见 同款：剥 VariableCheck/SexualScene/Disclaimer/w2g
		{
			name: "TG-ai看不见",
			source: "<(VariableCheck|SexualScene|Disclaimer|w2g)>([\\s\\S]*?)<\\/\\1>|<!--([\\s\\S]*?)-->",
			flags: "g",
			replace: "",
		},
	];
	const { history } = rebuildHistory(branch, promptRulesFixture);
	const sent = history[history.length - 1].text;
	assert.ok(sent.includes("正文一句"), "正文保留");
	assert.ok(!sent.includes("w2g"), "作者 promptOnly 规则剥掉不想让模型看的块");
	assert.ok(!sent.includes("SexualScene"), "同上");
	// 对照组：不传规则 → 块原样进历史（unwrapped 内容仍在）
	const { history: ctrl } = rebuildHistory(branch);
	assert.ok(ctrl[ctrl.length - 1].text.includes("SexualScene") || ctrl[ctrl.length - 1].text.includes("内容"), "无规则时不剥");
});

test("rebuildHistory：送模侧深度限定——旧状态栏剥掉，最新那条留着当模型的格式模仿源", () => {
	// 实卡形态：`隐藏历史多状态栏`（minDepth:3 起、replace 空）
	// 与 `折叠通用多状态栏`（maxDepth:2）是按深度互补的一对。忽略 depth 全深度跑，
	// 历史里一个范例都不剩，模型每拍得从散文重推格式。
	const hideOld: DisplayRule[] = [
		{ name: "隐藏历史多状态栏", source: "<state1>[\\s\\S]*?<\\/state1>", flags: "g", replace: "", minDepth: 3 },
	];
	const branch: BranchEntryLike[] = [
		asstE("老段。\n<state1>老栏</state1>"),
		userE("u1"),
		asstE("新段。\n<state1>新栏</state1>"),
		userE("u2"),
	];
	// 合并后 4 条：老段 depth3 / u1 depth2 / 新段 depth1 / u2 depth0
	const { history } = rebuildHistory(branch, hideOld);
	assert.ok(!history[0].text.includes("老栏"), "depth≥3 的旧状态栏剥掉（省上下文）");
	assert.ok(history[0].text.includes("老段"), "只剥状态栏，正文不动");
	assert.ok(history[2].text.includes("新栏"), "最新那条留着——模型的格式模仿源");

	// 对照：忽略 depth 全深度跑（改动前的行为）＝连最新的也删光
	const noDepth = hideOld.map(({ minDepth: _drop, ...r }) => r);
	const { history: flat } = rebuildHistory(branch, noDepth);
	assert.ok(!flat[2].text.includes("新栏"), "对照组确实会把最新的也删光");
});

test("rebuildHistory：深度按合并后的历史条目数，一拍多条 message 只算一条", () => {
	// 一拍在梨园是多条 assistant message（多轮工具＋多段正文），在酒馆眼里是一条消息。
	// 按原始条目数算，本拍第一段就落到 depth 3，作者的 minDepth:2 会把本拍状态栏删掉。
	const hide: DisplayRule[] = [
		{ name: "隐藏历史", source: "<state1>[\\s\\S]*?<\\/state1>", flags: "g", replace: "", minDepth: 2 },
	];
	const branch: BranchEntryLike[] = [
		userE("u1"),
		asstE("第一段。\n<state1>本拍栏</state1>"),
		asstE("第二段。"),
		asstE("第三段。"),
		asstE("第四段。"),
	];
	const { history } = rebuildHistory(branch, hide);
	assert.equal(history.length, 2, "四条 assistant 合成一条历史");
	assert.ok(history[1].text.includes("本拍栏"), "本拍整体 depth 0，状态栏必须留着");
});

test("rebuildHistory：幕后轮的回复不作语言检测源；rp-import 记为 user 侧", () => {
	const branch: BranchEntryLike[] = [
		{ type: "custom_message", customType: "rp-import", content: "【前情提要】旧事一段。" },
		userE("我环顾四周。"),
		asstE("殿内烛影摇动。"),
		userE("//帮我看下配置"),
		asstE("Config check done, everything looks fine and here is a long english reply for you."),
	];
	const { history, lastNarrativeText } = rebuildHistory(branch);
	assert.equal(history[0].role, "user");
	assert.ok(history[0].text.includes("前情提要"));
	assert.ok(lastNarrativeText.includes("烛影"), "幕后轮回复跳过，检测源回溯到台上叙事");
});

test("stateFromBranch：最近快照生效；无快照=初始", () => {
	const branch: BranchEntryLike[] = [
		{ type: "custom", customType: "rp-state", data: { scene: "旧场景" } },
		userE("走。"),
		{ type: "custom", customType: "rp-state", data: { scene: "新场景" } },
	];
	assert.equal((stateFromBranch(branch) as { scene?: string }).scene, "新场景");
	assert.deepEqual(stateFromBranch([userE("嗨")]), defaultState());
});

// ---------------- 提示词装配 ----------------

const card = {
	name: "云澜",
	description: "{{user}}的同门师姐。",
	personality: "冷静自持",
	scenario: "山门月下",
	mesExample: "",
	firstMes: "你来了。",
	alternateGreetings: [],
	systemPrompt: "",
	postHistoryInstructions: "",
	creatorNotes: "",
	tags: [],
	book: [],
};
const config: RpConfig = { ...DEFAULT_CONFIG, userName: "沈舟" };

test("system prompt：marker 归位——材料真进了预设槽位，梨园不再按自己版式重出一遍", () => {
	const rich = { ...card, description: "云澜是师姐。", personality: "冷。", scenario: "山门外。" };
	const filledCase = buildStageSystemPrompt({
		card: rich,
		config,
		constantLore: [],
		presetBefore: ["【预设槽位里的卡描述】云澜是师姐。"],
		filledMarkers: new Set(["charDescription", "charPersonality", "personaDescription"]),
	});
	assert.ok(filledCase.includes("# 用户扮演：沈舟"), "用户是谁无条件出——名字只有这一条通道（消息流是裸 role:user）");
	assert.ok(!filledCase.includes("（沈舟 的具体形象由用户在剧情中自行呈现）"), "人设正文已被槽位收走，此处不重复");
	assert.ok(!filledCase.includes("## 性格"), "charPersonality 已归位");
	assert.ok(filledCase.includes("## 当前场景"), "scenario 没归位 → 梨园兜底补上，卡内容不丢");

	const none = buildStageSystemPrompt({ card: rich, config, constantLore: [], presetBefore: ["旧格式预设无 marker。"] });
	assert.ok(none.includes("# 你扮演的角色：云澜") && none.includes("云澜是师姐。"), "一个槽位都没归位时全走兜底版式");
	assert.ok(none.includes("# 用户扮演："), "人设兜底在场");
});

/**
 * 「用户身份整段消失」的回归（2026-09-02）：预设**声明**了 personaDescription 槽位、
 * 但人设正文为空 ⇒ 槽位无料什么都没送。此时兜底必须照常补，否则模型永远不知道用户是谁。
 * 判据一旦退回「声明过就算数」，这条立刻红。
 */
test("system prompt：预设声明了人设槽位却没料时，用户身份仍无条件到位", () => {
	const emptyPersona: RpConfig = { ...DEFAULT_CONFIG, userName: "沈舟", userPersona: "" };
	// filledMarkers 只收真交了料的 ⇒ 空人设的 personaDescription 不在其中
	const sys = buildStageSystemPrompt({
		card,
		config: emptyPersona,
		constantLore: [],
		presetBefore: ["【预设正文】"],
		filledMarkers: new Set(["charDescription"]),
	});
	assert.ok(sys.includes("# 用户扮演：沈舟"), "名字到位");
	assert.ok(sys.includes("（沈舟 的具体形象由用户在剧情中自行呈现）"), "人设为空时占位到位");
});

test("末端注入：事实块——数据带标注送达，语义归 system；导演备注容器解散（D5/D6/D7）", () => {
	const inj = buildStageInjection({
		state: defaultState(),
		activatedLore: [],
		card: { ...card, postHistoryInstructions: "卡作者的末端叮嘱。" },
		config,
		languageMismatch: true,
	});
	assert.ok(inj.startsWith("【世界状态】\n"), "世界状态最前，纯数据无解说");
	assert.ok(!inj.includes("正文不得与之矛盾"), "语义解说不再逐拍复述（在 system 语义表）");
	// 预设 after 段改走消息数组（按作者 role 落成真实消息），不再进注入块、梨园也不再扣标签
	assert.ok(!inj.includes("【预设末端指令】"), "梨园的标签不再盖作者的话");
	assert.ok(!inj.includes("【文风与写法】") && !inj.includes("【行为边界】"), "零归拢");
	assert.ok(inj.includes("【卡作者末端指令】\n卡作者的末端叮嘱。"), "卡末端指令独立成块（D5）");
	assert.ok(!inj.includes("【导演备注】"), "D5：导演备注容器解散");
	assert.ok(!inj.includes("【状态栏】"), "D6：状态栏注入块已删（谢幕注入替代）");
	assert.ok(!inj.includes("【思考的用法】"), "D7：rehearsalGuard 注入整体删除");
	assert.ok(inj.includes("【语言】以中文写叙事与对白（专有名词可保留原文）。"), "语言一行（config 事实）");
	assert.ok(!inj.includes("演完本拍即停"), "「演完即停」句删——时序由判定/谢幕日程表达");
	assert.ok(inj.includes("【语言纠正】"), "语言自愈事实保留");
	assert.ok(!inj.includes("【登场名录】"), "无名录不出块");
});

test("末端注入：字数一行纯事实（§2.2）；无目标不出行", () => {
	const inj = buildStageInjection({
		state: defaultState(),
		activatedLore: [],
		card,
		config,
		wordRange: { min: 500, max: 800 },
	});
	assert.ok(inj.includes("本拍约 500–800 字"), "字数事实在场");
	assert.ok(!inj.includes("心里有数") && !inj.includes("朝这个量落笔") && !inj.includes("不必核算"), "纯事实，无落笔指令");
	const none = buildStageInjection({ state: defaultState(), activatedLore: [], card, config });
	assert.ok(!none.includes("本拍约"), "无目标不出行");
	assert.ok(!none.includes("800–1500"), "无预设兜底数字随 D1 迁出（默认预设数据承接）");
});

test("detectsLanguageMismatch：中文目标才判、样本要够长", () => {
	const en = "The moon hangs over the courtyard while she waits in silence for a long time tonight.";
	assert.equal(detectsLanguageMismatch(en, "中文"), true);
	assert.equal(detectsLanguageMismatch("殿内烛影摇动，她伏案未眠，窗外霜色渐重，更漏声一声一声敲在瓦上，夜风穿堂而过带起纸页。", "中文"), false);
	assert.equal(detectsLanguageMismatch("short", "中文"), false);
	assert.equal(detectsLanguageMismatch(en, "English"), false);
});

// ---------------- 素材装载 ----------------

/** 装载态的转译产物（与 server/rest.ts syncPresetTranslation 同一条纯函数链）：全部段落按「拿不准一律留」落写作条目 */
const translatedOf = (m: ReturnType<typeof loadStageMaterials>) => {
	const doc = m.presetDoc!;
	const macro = { charName: m.card.name, userName: m.config.userName };
	const pieces = declarePieces(assembleForDeclare(doc, macro));
	const parsed = parseDeclareResponse("[]", pieces);
	return translatePresetWithDeclaration(
		doc,
		{ version: 1, preset: doc.name, card: m.card.name, createdAt: "2026-09-12T00:00:00.000Z", entries: parsed.entries },
		macro,
	);
};

test("loadStageMaterials：装载的预设不直接进提示词——文档在（采样/名字），装配段空；宏链经转译进条目", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-mat-"));
	try {
		writeFileSync(
			join(cwd, "card.json"),
			JSON.stringify({ data: { name: "云澜", description: "{{user}}的师姐", first_mes: "你来了。" } }),
		);
		writeFileSync(
			join(cwd, "preset.json"),
			JSON.stringify({
				blocks: [
					{ id: "s1", channel: "system", enabled: true, content: "{{setvar::tone::清冷}}文风基调：{{getvar::tone}}。" },
					{ id: "s2", channel: "system", enabled: false, content: "不该出现" },
					{ id: "p1", channel: "postHistory", enabled: true, content: "回应用户，保持{{getvar::tone}}。" },
				],
				samplers: { temperature: 0.9 },
			}),
		);
		writeFileSync(
			join(cwd, "liyuan.config.json"),
			JSON.stringify({ card: "card.json", preset: "preset.json", userName: "沈舟" }),
		);
		mkdirSync(join(cwd, ".liyuan"), { recursive: true });

		const m = loadStageMaterials(cwd);
		assert.equal(m.card.name, "云澜");
		assert.equal(m.presetDoc?.kind, "rp", "旧梨园格式仍能读");
		assert.equal(m.presetDoc?.samplers.temperature, 0.9, "采样参数从装载的预设取");
		assert.equal(m.presetActive, false, "装载态不直接喂：模型看的是转译进卡文件的条目");
		assert.deepEqual(m.presetBefore, []);
		assert.equal(assemblePresetAfter(m, "我上前行礼。"), undefined, "历史后段随转译并入常驻，不再每拍重装");
		assert.equal(m.macroWarnings.length, 0);
		assert.equal(constantLoreOf(m).length, 0);

		// 转译产物：setvar/getvar 跨块生效、历史后段照样看得到前面块设的变量、关闭块不出现
		const t = translatedOf(m).agentsSection;
		assert.ok(t.includes("文风基调：清冷"), "setvar/getvar 链跨块生效");
		assert.ok(t.includes("保持清冷"), "历史后段照样看得到前面块设的变量");
		assert.ok(!t.includes("不该出现"), "预设里关着的块不落任何形态");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("loadStageMaterials：启用块全量成条目——没有块被偷偷扔掉；进提示词走 cardAgents 那一份", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-pol-"));
	try {
		writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: { name: "云澜", first_mes: "你来了。" } }));
		writeFileSync(
			join(cwd, "preset.json"),
			JSON.stringify({
				blocks: [
					{ id: "style", channel: "system", enabled: true, content: "文风：冷而克制，短句为主。" },
					{ id: "pol", channel: "system", enabled: true, content: '词汇黑名单 = { "闪过", "一丝" }' },
				],
				samplers: {},
			}),
		);
		writeFileSync(
			join(cwd, "liyuan.config.json"),
			JSON.stringify({ card: "card.json", preset: "preset.json", userName: "沈舟" }),
		);
		mkdirSync(join(cwd, ".liyuan"), { recursive: true });

		const m = loadStageMaterials(cwd);
		assert.deepEqual(m.presetBefore, [], "不直接喂");
		const t = translatedOf(m);
		assert.equal(t.lines.filter((l) => l.action === "agents").length, 2, "两块都在——用户开着的块一个不扔");

		const sp = buildStageSystemPrompt({
			card: m.card,
			config: m.config,
			constantLore: [],
			cardAgents: renderForModel(t.agentsSection),
		});
		assert.ok(sp.includes("文风：冷而克制"), "文风块在场");
		assert.ok(sp.includes("词汇黑名单"), "纪律块也在场——判死改判归用户，梨园不代劳");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("无预设＝真的无预设（刀1）：config.preset 空 → 零兜底、零主权句、零字数行", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-def-"));
	try {
		writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: { name: "云澜", first_mes: "你来了。" } }));
		writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", userName: "沈舟" }));

		const m = loadStageMaterials(cwd);
		assert.equal(m.presetDoc, null, "默认预设已删除，无预设时 presetDoc 为 null");
		assert.equal(m.presetActive, false, "presetActive 为假");
		assert.deepEqual(m.presetBefore, [], "零装配段");
		const resident = m.presetBefore.map((p) => p.text).join("\n");
		assert.ok(!resident.includes("绝不替"), "主权硬边界句不在场（吃掉 39~47% 思考的来源，PLAN-AGENT-SLOTS §三）");
		const rules = extractDraftRules(m.presetRuleTexts);
		assert.equal(rules.wordRange, undefined, "没有预设就没有字数来源，不补兜底");

		// 用户预设在场：文档照常装载（presets/ 删除不影响用户预设路径），正文经转译进条目
		writeFileSync(
			join(cwd, "preset.json"),
			JSON.stringify({ name: "用户预设", samplers: {}, blocks: [{ id: "u1", channel: "system", enabled: true, content: "用户自己的文风。" }] }),
		);
		writeFileSync(
			join(cwd, "liyuan.config.json"),
			JSON.stringify({ card: "card.json", preset: "preset.json", userName: "沈舟" }),
		);
		const m2 = loadStageMaterials(cwd);
		assert.equal(m2.presetDoc?.name, "preset", "预设名取文件名，不取文件里写的 name");
		assert.deepEqual(m2.presetBefore, [], "装载态不直接喂");
		assert.ok(translatedOf(m2).agentsSection.includes("用户自己的文风"), "用户预设正文经转译在场");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("预设原文直通：句级过滤退场，验算行也照进条目", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-audit-"));
	try {
		writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: { name: "云澜", description: "师姐" } }));
		writeFileSync(
			join(cwd, "preset.json"),
			JSON.stringify({
				name: "p",
				samplers: {},
				blocks: [
					{
						id: "style",
						name: "文风",
						channel: "system",
						role: "system",
						enabled: true,
						// 文风块夹带验算指令：块级判定会整块留下（不是纪律块），句级要摘掉那一行
						content: "<style>\n- 以直接对白为主。\n- 每段写完后自检是否出现禁用句式。\n</style>",
					},
					{
						id: "wc",
						name: "字数",
						channel: "system",
						role: "system",
						enabled: true,
						content: "正文字数 800-1200 字。",
					},
				],
			}),
		);
		writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", preset: "preset.json" }));

		const m = loadStageMaterials(cwd);
		const writing = translatedOf(m).agentsSection;
		assert.ok(writing.includes("以直接对白为主"), "文风指令原文直通");
		assert.ok(writing.includes("自检"), "句级过滤已退场——预设作者写的每一行都照进条目（铁律一）");
		assert.ok(writing.includes("800-1200"), "字数规则原文照进条目");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
