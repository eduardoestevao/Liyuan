import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SessionManager } from "@liyuan/agent-runtime";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@liyuan/ai/providers/faux";
import { registerFauxProvider, streamSimple } from "@liyuan/ai/compat";

import { StageEngine, type StageStreamFn } from "../src/stage/engine.ts";

/** 临时舞台：配置+卡+独立会话目录 */
const makeStage = () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-eng-"));
	writeFileSync(
		join(cwd, "card.json"),
		JSON.stringify({ data: { name: "云澜", description: "{{user}}的师姐", first_mes: "你来了。" } }),
	);
	writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", userName: "沈舟" }));
	mkdirSync(join(cwd, ".liyuan"), { recursive: true });
	const sm = SessionManager.create(cwd, join(cwd, "sessions"));
	return { cwd, sm };
};

const makeEngine = (
	cwd: string,
	sm: InstanceType<typeof SessionManager>,
	model: unknown,
	events: ConstructorParameters<typeof StageEngine>[0]["events"] = {},
) =>
	new StageEngine({
		cwd,
		getSessionManager: () => sm as never,
		getModel: () => model as never,
		getAuth: async () => ({}),
		streamFn: streamSimple as unknown as StageStreamFn,
		events,
	});

/**
 * 场记那一发（M3 起「本拍零落账」的拍才会发起——M-R1 后记账注入把落账拉到台上，
 * 兜底触发率大降，但直出代收+模型不落账的测试路径仍会走到）。
 */
const fauxScribeEmpty = () => fauxAssistantMessage(JSON.stringify({ patch: {} }));

/**
 * 直出正文一拍的完整应答序列（M-R1 五注入日程）：
 * 正文 → 代收回执轮（空应答）→ 记账注入轮（空应答）→ 场记兜底。
 * 合约为空（卡无状态栏）时谢幕注入不发生，日程即收束。
 */
const directBeat = (text: string | ((ctx: unknown) => unknown)) => [
	typeof text === "string" ? fauxAssistantMessage(text) : text,
	fauxAssistantMessage(""),
	fauxAssistantMessage(""),
	fauxScribeEmpty(),
];

test("引擎：一拍全链路（user 落树 → 流式 → assistant 落树 → 谢幕）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses(directBeat("云澜垂眸受了半礼。「山门夜巡未归的人，是你？」") as never);
		let partials = 0;
		let end: { aborted: boolean; entryId?: string; error?: string } | null = null;
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onDelta: () => partials++,
			onTurnEnd: (info) => (end = info),
		});

		await engine.performTurn("我上前行礼。");

		const branch = sm.getBranch() as Array<{ type: string; message?: { role?: string; content?: unknown } }>;
		const roles = branch.filter((e) => e.type === "message").map((e) => e.message?.role);
		assert.deepEqual(roles, ["user", "assistant"]);
		assert.ok(partials > 0, "流式部分事件应外发");
		assert.ok(end && !end.aborted && !end.error && end.entryId, "谢幕信息应带落树条目 id");
		assert.ok(JSON.stringify(branch).includes("山门夜巡"), "正文在树上");
		assert.equal(engine.isStreaming, false);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});



test("引擎：abort 半拍——已流出的正文落树、标记 aborted", async () => {
	const { cwd, sm } = makeStage();
	// 放慢出字速度，保证 abort 打在流中
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }], tokensPerSecond: 30 });
	try {
		reg.setResponses([
			fauxAssistantMessage("很长的一拍正文，慢慢地流出来，一句接一句，足够被中途打断的长度，再加一句压秤。"),
		]);
		let end: { aborted: boolean; entryId?: string } | null = null;
		let streamed = "";
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onDelta: (kind, delta) => {
				if (kind !== "text") return;
				streamed += delta;
				if (streamed.length >= 8 && engine.isStreaming) engine.abort();
			},
			onTurnEnd: (info) => (end = info),
		});
		await engine.performTurn("开演。");

		assert.ok(end, "谢幕必须发生");
		assert.equal((end as { aborted: boolean }).aborted, true, "应标记为中断");
		const asst = (sm.getBranch() as Array<{ type: string; message?: { role?: string; stopReason?: string } }>).find(
			(e) => e.type === "message" && e.message?.role === "assistant",
		);
		assert.ok(asst, "半拍正文仍应落树（用户看过的戏不消失）");
		assert.equal(asst?.message?.stopReason, "aborted");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：无模型/无用户输入的失败路径走通知，不落错误正文", async () => {
	const { cwd, sm } = makeStage();
	const notices: string[] = [];
	const engine = new StageEngine({
		cwd,
		getSessionManager: () => sm as never,
		getModel: () => undefined,
		getAuth: async () => ({}),
		streamFn: streamSimple as unknown as StageStreamFn,
		events: { onNotify: (_l, t) => notices.push(t) },
	});
	await engine.performTurn("你好。");
	assert.ok(notices.some((t) => t.includes("剧情模型")), "无模型应有人话提示");
	const asst = (sm.getBranch() as Array<{ type: string; message?: { role?: string } }>).filter(
		(e) => e.type === "message" && e.message?.role === "assistant",
	);
	assert.equal(asst.length, 0, "不落任何 assistant 消息");
	rmSync(cwd, { recursive: true, force: true });
});

// ---------------- M-A：宽进严出 + 验收报告喂回（取代 M2 幕后精修） ----------------

import { writeFileSync as wf } from "node:fs";
import { rebuildHistory, type BranchEntryLike } from "../src/stage/assemble.ts";

/** 在临时舞台上加一个带纪律块（禁词表）的预设 */
const addBannedWordPreset = (cwd: string) => {
	wf(
		join(cwd, "preset.json"),
		JSON.stringify({
			blocks: [{ id: "pol", channel: "system", enabled: true, content: '词汇黑名单 = { "闪过" }' }],
			samplers: {},
		}),
	);
	wf(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", userName: "沈舟", preset: "preset.json" }));
};


test("引擎循环：代收回执后模型不改（只闲聊收笔）→ 保留现稿如实交付，闲聊不落树", async () => {
	const { cwd, sm } = makeStage();
	addBannedWordPreset(cwd);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			fauxAssistantMessage("她眼中闪过一丝冷意，收剑入鞘。"),
			fauxAssistantMessage("就这样吧。"), // 模型看过事实仍不改，闲聊收笔
			fauxAssistantMessage(""), // 记账注入轮：无变动直接停
			fauxScribeEmpty(),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("拔剑指向她。");

		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		const finalText = history[history.length - 1].text;
		assert.ok(finalText.includes("闪过"), "模型拒改 → 保留现稿（引擎不替模型做决定）");
		assert.ok(!finalText.includes("就这样吧"), "收笔闲聊不进正文");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});


// ---------------- M3：场记记账（R8 独占 + R4 账本=f(分支)） ----------------


const fauxScribe = (patch: Record<string, unknown>) => fauxAssistantMessage(JSON.stringify({ patch }));



test("引擎记账：中断的半拍不记账（半截正文不进账本）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }], tokensPerSecond: 30 });
	try {
		reg.setResponses([
			fauxAssistantMessage("很长的一拍正文，慢慢地流出来，一句接一句，足够被中途打断的长度，再加一句压秤。"),
			fauxScribe({ time: "不该被记下的时间" }),
		]);
		let streamed = "";
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onDelta: (kind, delta) => {
				if (kind !== "text") return;
				streamed += delta;
				if (streamed.length >= 8 && engine.isStreaming) engine.abort();
			},
		});
		await engine.performTurn("开演。");

		const snaps = (sm.getBranch() as Array<{ type?: string; customType?: string }>).filter(
			(e) => e.type === "custom" && e.customType === "rp-state",
		);
		assert.equal(snaps.length, 0, "中断拍不落账本快照");
		assert.equal(reg.getPendingResponseCount(), 1, "场记那一发根本没发出");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------- M3：台上检索工具循环（R2 查资料 + R6 动笔即收敛） ----------------








test("引擎循环：格式尾巴（状态栏占位+catsay）走 text 通道 → 并入定稿正文与持久化时间线", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			// 8/05 实锤形态：draft_write 只交正文，思考里宣告还要写状态栏与点评
			fauxAssistantMessage(
				[
					fauxThinking("The user decides. Now the status bar and cat commentary."),
					fauxToolCall("draft_write", { content: "暮色四合，两人到了溪桥。" }),
				],
				{ stopReason: "toolUse" },
			),
			// 尾巴轮：状态栏占位 + 咪咪点评（预设格式栈，不走 draft_write）
			fauxAssistantMessage(
				"<StatusPlaceHolderImpl/>\n\n<catsay>\n<details><summary>😼咪咪点评</summary>\n选天赋磨叽半天喵呜。\n</details>\n</catsay>",
			),
			fauxScribeEmpty(),
		]);
		const activities: string[] = [];
		let streamed = "";
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onActivity: (d) => activities.push(d),
			onDelta: (kind, d) => {
				if (kind === "text") streamed += d;
			},
		});
		await engine.performTurn("往溪桥去。");

		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		// 树上正文 = 用户面定稿：正文 + 状态栏占位 + 咪咪点评都在
		const branch = sm.getBranch() as Array<{
			type: string;
			message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
		}>;
		const lastMsg = [...branch].reverse().find((e) => e.type === "message" && e.message?.role === "assistant");
		const treeText = (lastMsg?.message?.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
		assert.ok(treeText.includes("暮色四合"), "正文在树上");
		assert.ok(treeText.includes("StatusPlaceHolderImpl"), "状态栏占位并入定稿——不再被过滤");
		assert.ok(treeText.includes("咪咪点评"), "咪咪点评并入定稿——不再被过滤");
		assert.ok(streamed.includes("咪咪点评"), "尾巴也流式上屏过");
		// 模型面历史仍整块剥 catsay（防往拍模仿）——「历史剥、树留」双语义各就位
		assert.ok(history[history.length - 1].text.includes("暮色四合"), "历史含正文");
		assert.ok(!history[history.length - 1].text.includes("咪咪点评"), "历史剥掉格式栈（往拍模仿源）");

		// 时间线随 details 持久化：resync/刷新后尾巴仍在
		const entry = branch.filter((e) => e.type === "message" && e.message?.content).pop();
		const timeline = entry?.message?.details?.rpTimeline as
			| Array<{ kind: string; text?: string; draft?: boolean }>
			| undefined;
		assert.ok(Array.isArray(timeline), "rpTimeline 落树持久化");
		const textSegs = (timeline ?? []).filter((s) => s.kind === "text");
		const tlText = textSegs.map((s) => s.text ?? "").join("\n\n");
		assert.ok(tlText.includes("咪咪点评"), "持久化时间线含尾巴");
		// 分段同构（8/09 输出形式）：稿段与尾巴段各自独立——稿段带 draft，尾巴段不带
		assert.equal(textSegs.length, 2, "稿段 + 尾巴段，互不吸收");
		assert.ok(textSegs[0].draft === true && (textSegs[0].text ?? "").includes("暮色四合"), "稿段在前且带 draft 标记");
		assert.ok(textSegs[1].draft !== true && (textSegs[1].text ?? "").includes("咪咪点评"), "尾巴独立末段（非稿段）");
		assert.ok(activities.some((a) => a.includes("交稿")), "过程条照常");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});



test("引擎循环：催稿后仍空手 → 认栽收拍并通知（不再静默丢拍）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([fauxAssistantMessage(""), fauxAssistantMessage("")]);
		const notices: string[] = [];
		let end: { error?: string } | null = null;
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onNotify: (_l, t) => notices.push(t),
			onTurnEnd: (info) => (end = info),
		});
		await engine.performTurn("开演。");

		assert.ok(notices.some((t) => t.includes("未交出任何正文")), "空拍必须有人话通知");
		assert.equal((end as { error?: string } | null)?.error, "no-draft");
		const asst = (sm.getBranch() as Array<{ type: string; message?: { role?: string } }>).filter(
			(e) => e.type === "message" && e.message?.role === "assistant",
		);
		assert.equal(asst.length, 0, "空拍不落树");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});


// ---------------- M4 长局压缩（引擎自管） ----------------

/** 写配置：压缩周期可调 */
const setCompactEvery = (cwd: string, everyNTurns: number) =>
	writeFileSync(
		join(cwd, "liyuan.config.json"),
		JSON.stringify({ card: "card.json", userName: "沈舟", compactEveryNTurns: everyNTurns }),
	);




test("引擎压缩：compactNow() 手动压缩不等周期；流式中拒绝", async () => {
	const { cwd, sm } = makeStage();
	setCompactEvery(cwd, 0); // 自动压缩关闭
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const responses: unknown[] = [];
		for (let i = 1; i <= 8; i++) {
			responses.push(fauxAssistantMessage(`第 ${i} 拍的正文。${"云".repeat(1200)}`));
			responses.push(fauxAssistantMessage(""));
			responses.push(fauxAssistantMessage(""));
			responses.push(fauxScribeEmpty());
		}
		reg.setResponses(responses as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		for (let i = 1; i <= 8; i++) await engine.performTurn(`第 ${i} 拍我说的话。`);

		assert.equal(
			(sm.getBranch() as Array<{ customType?: string }>).filter((e) => e.customType === "rp-summary").length,
			0,
			"everyNTurns=0 时不自动压缩",
		);

		reg.setResponses([fauxAssistantMessage("## 前情提要\n手动压缩产出的摘要。")]);
		const r = await engine.compactNow();
		assert.equal(r.kind, "compacted");
		assert.equal(
			(sm.getBranch() as Array<{ customType?: string }>).filter((e) => e.customType === "rp-summary").length,
			1,
			"手动压缩落一条摘要",
		);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});



















// ---------------- P7：ask 工具（剧情共创决策） ----------------

test("ask：注入 askUser 才上清单；未注入则剔除（依赖缺失不上清单）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ tools?: Array<{ name: string }> }> = [];
		reg.setResponses([
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage("你好。");
			},
			fauxScribeEmpty(),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("开演。");
		const names = (ctxs[0].tools ?? []).map((t) => t.name);
		assert.ok(!names.includes("ask"), "未注入 askUser 时 ask 不上清单");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("ask：注入 askUser 时 ask 上清单", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ tools?: Array<{ name: string }> }> = [];
		reg.setResponses([
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage("你好。");
			},
			fauxScribeEmpty(),
		]);
		const engine = new StageEngine({
			cwd,
			getSessionManager: () => sm as never,
			getModel: () => reg.getModel("faux-rp"),
			getAuth: async () => ({}),
			streamFn: streamSimple as unknown as StageStreamFn,
			askUser: async () => "好",
		});
		await engine.performTurn("开演。");
		const names = (ctxs[0].tools ?? []).map((t) => t.name);
		assert.ok(names.includes("ask"), "注入 askUser 后 ask 在清单");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});








/**
 * 旁路条目（RpConfig.sideModel → StageEngineDeps.getSideEntry）：
 * 场记/压缩不再跟随剧情模型，模型和思考档都取自连接配置里那一条条目。
 */
test("引擎：旁路调用走 sideEntry 的模型与它自己的档，并按它重取鉴权", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }, { id: "faux-side" }] });
	try {
		reg.setResponses(directBeat("云澜垂眸受了半礼。") as never);
		const calls: Array<{ id: string; reasoning: unknown }> = [];
		const authFor: string[] = [];
		const recording = ((model: { id: string }, ctx: unknown, options: { reasoning?: unknown }) => {
			calls.push({ id: model.id, reasoning: options?.reasoning });
			return (streamSimple as unknown as StageStreamFn)(model as never, ctx as never, options as never);
		}) as unknown as StageStreamFn;

		const engine = new StageEngine({
			cwd,
			getSessionManager: () => sm as never,
			getModel: () => reg.getModel("faux-rp") as never,
			getSideEntry: () => ({ model: reg.getModel("faux-side") as never, thinking: "off", label: "flash off" }),
			getAuth: async (m) => {
				authFor.push(String((m as { id: string }).id));
				return {};
			},
			streamFn: recording,
			events: {},
		});
		await engine.performTurn("我上前行礼。");

		assert.ok(calls.some((c) => c.id === "faux-rp"), "台上仍走剧情模型");
		const side = calls.filter((c) => c.id === "faux-side");
		assert.ok(side.length > 0, "场记那一发走旁路条目的模型");
		assert.equal(side[0]!.reasoning, "off", "档取自那条条目，不是引擎自己定的");
		assert.ok(authFor.includes("faux-side"), "鉴权按旁路模型重取，不能沿用剧情模型的 key");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

/** 回归：没配旁路条目时逐字旧行为——旁路仍跟随剧情模型，且不多取一次鉴权 */
test("引擎：未配旁路条目时旁路跟随剧情模型（旧行为不变）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses(directBeat("云澜垂眸受了半礼。") as never);
		const ids: string[] = [];
		let authCalls = 0;
		const recording = ((model: { id: string }, ctx: unknown, options: unknown) => {
			ids.push(model.id);
			return (streamSimple as unknown as StageStreamFn)(model as never, ctx as never, options as never);
		}) as unknown as StageStreamFn;

		const engine = new StageEngine({
			cwd,
			getSessionManager: () => sm as never,
			getModel: () => reg.getModel("faux-rp") as never,
			getAuth: async () => {
				authCalls++;
				return {};
			},
			streamFn: recording,
			events: {},
		});
		await engine.performTurn("我上前行礼。");

		assert.ok(ids.length > 0 && ids.every((i) => i === "faux-rp"), "全部调用都走剧情模型");
		assert.equal(authCalls, 1, "只按剧情模型取一次鉴权（旁路没换模型就不该重取）");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

/** 第四步：旁路要留下「思考了没有、思考了多久」的痕迹，否则用户无从判断 */
test("引擎：旁路每一发都出回执——思考字数与耗时", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }, { id: "faux-side" }] });
	try {
		reg.setResponses(directBeat("云澜垂眸受了半礼。") as never);
		const activity: string[] = [];
		const engine = new StageEngine({
			cwd,
			getSessionManager: () => sm as never,
			getModel: () => reg.getModel("faux-rp") as never,
			getSideEntry: () => ({ model: reg.getModel("faux-side") as never, thinking: "off", label: "flash off" }),
			getAuth: async () => ({}),
			streamFn: streamSimple as unknown as StageStreamFn,
			events: { onActivity: (d) => activity.push(d) },
		});
		await engine.performTurn("我上前行礼。");

		const receipts = activity.filter((a) => a.includes("旁路"));
		assert.ok(receipts.length > 0, "旁路跑过就得留下回执");
		const r = receipts[0]!;
		assert.ok(r.includes("flash off"), "回执要指名是哪条条目");
		assert.match(r, /思考 \d+ 字/, "思考字数是这行存在的理由");
		assert.match(r, /\d+\.\ds/, "耗时也要有");
		assert.ok(r.includes("档 off"), "请求的档要写出来——它和实际思考字数对不上时才看得见问题");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});
