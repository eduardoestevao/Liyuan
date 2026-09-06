import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	HANDBOOK_MARK,
	RESIDENT_ENVELOPE_CHARS,
	RESIDENT_MARK,
	RESIDENT_MAX_CHARS,
	branchOfSessionFile,
	buildConsolidatePrompt,
	buildRecapPrompt,
	collectChatEvidence,
	diffRecaps,
	fitResidentSummary,
	loadManifest,
	loadResidentSummary,
	memoryPaths,
	parseConsolidateResult,
	sourceMarkOf,
	syncCardMemory,
	type CardMemoryDeps,
} from "../src/card-memory.ts";
import { cardDirOf } from "../src/paths.ts";
import { createCardSpace, createChat } from "../src/cardspace.ts";

// ---------- 沙箱与素材 ----------

function mkProject() {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-card-memory-"));
	mkdirSync(join(cwd, "assets", "cards"), { recursive: true });
	return cwd;
}

function mkCardSpace(cwd: string, folder = "某卡") {
	const src = join(cwd, "assets", "cards", `${folder}.png`);
	writeFileSync(src, "PNGDATA");
	return createCardSpace(cwd, src, folder, { copy: (from, to) => copyFileSync(from, to) });
}

/** 手写一份 pi 会话文件：header + 链式条目（message / rp-state / rp-summary） */
function writeSession(
	file: string,
	msgs: Array<{ role: "user" | "assistant"; text: string }>,
	extras: Array<{ customType: string; data: unknown }> = [],
) {
	const lines: string[] = [
		JSON.stringify({ type: "session", id: "s", cwd: "E:/x", timestamp: new Date().toISOString() }),
	];
	let prev: string | null = null;
	let n = 0;
	const pushEntry = (e: Record<string, unknown>) => {
		const id = `e${++n}`;
		lines.push(JSON.stringify({ id, parentId: prev, timestamp: new Date().toISOString(), ...e }));
		prev = id;
	};
	// 要给 rp-summary 覆盖的早期正文先落
	for (const x of extras) {
		if (x.customType !== "rp-summary") continue;
		for (let i = 0; i < 2 && i < msgs.length; i++) pushEntry({ type: "message", message: { role: msgs[i].role, content: [{ type: "text", text: msgs[i].text }] } });
		const coveredId = prev;
		pushEntry({ type: "custom", customType: "rp-summary", data: { ...(x.data as object), coversThroughId: coveredId } });
		const rest = msgs.slice(2);
		for (const m of rest) pushEntry({ type: "message", message: { role: m.role, content: [{ type: "text", text: m.text }] } });
		for (const y of extras) if (y.customType === "rp-state") pushEntry({ type: "custom", customType: "rp-state", data: y.data });
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, lines.join("\n") + "\n", "utf8");
		return;
	}
	for (const m of msgs) pushEntry({ type: "message", message: { role: m.role, content: [{ type: "text", text: m.text }] } });
	for (const x of extras) pushEntry({ type: "custom", customType: x.customType, data: x.data });
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

function writeSessionRaw(file: string, lines: string[]) {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

const RECAP_A = `# 小满入城

## 剧情脉络
用户与小满进了城。

## 人物与关系
- 小满：警惕心强。

## 既定事实
- 城门在东。

## 未了之事
- 没见到城主。

## 用户的玩法偏好
- 无`;

const RECAP_B = `# 雪夜

## 剧情脉络
下雪了。

## 未了之事
- 柴火不够。`;

function mergeOutput(handbookBody: string, residentBody: string): string {
	return `${HANDBOOK_MARK}\n${handbookBody}\n\n${RESIDENT_MARK}\n${residentBody}`;
}

/** 桩：Phase1 输出复盘、Phase2 输出两段；每次调用都记录 */
function stubSide(calls: string[], recap = RECAP_A, merged = mergeOutput("# 记忆\n\n（手册）", "# 往局记忆（同一世界更早的几局）\n\n- 小满入城：进了城。")): CardMemoryDeps["sideText"] {
	return async (sp, ut, _max) => {
		calls.push(sp.includes("档案员") ? "recap" : sp.includes("记忆管理员") ? "merge" : "?");
		return sp.includes("档案员") ? recap : merged;
	};
}

// ---------- branchOfSessionFile ----------

test("branchOfSessionFile：header 跳过、半行跳过、按叶回溯成根→叶序", () => {
	const file = join(tmpdir(), `b-${Date.now()}.jsonl`);
	writeSessionRaw(file, [
		JSON.stringify({ type: "session", cwd: "E:/x" }),
		JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: [{ type: "text", text: "你好" }] } }),
		"{broken json",
		JSON.stringify({ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "回你" }] } }),
	]);
	const branch = branchOfSessionFile(file);
	assert.equal(branch.length, 2);
	assert.deepEqual(
		branch.map((e) => (e.message as { role: string }).role),
		["user", "assistant"],
	);
	rmSync(file, { force: true });
});

test("branchOfSessionFile：分叉时只走当前叶那一条（swipe 过的变体不进来）", () => {
	const file = join(tmpdir(), `b-${Date.now()}.jsonl`);
	writeSessionRaw(file, [
		JSON.stringify({ type: "session", cwd: "E:/x" }),
		JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: [{ type: "text", text: "你好" }] } }),
		JSON.stringify({ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "第一版" }] } }),
		JSON.stringify({ type: "message", id: "e3", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "重roll版" }] } }),
	]);
	const branch = branchOfSessionFile(file);
	assert.equal(branch.length, 2);
	const last = branch[1].message as { content: Array<{ text: string }> };
	assert.equal(last.content[0].text, "重roll版");
	rmSync(file, { force: true });
});

// ---------- collectChatEvidence ----------

test("collectChatEvidence：带 rp-summary 的会话＝前情提要＋后续正文；rp-state 出账本快照", () => {
	const cwd = mkProject();
	try {
		const space = mkCardSpace(cwd);
		const chat = createChat(space.dir);
		writeSession(
			join(chat.sessionsDir, "s1.jsonl"),
			[
				{ role: "user", text: "第一章的旧事" },
				{ role: "assistant", text: "旧事的回复" },
				{ role: "user", text: "后来的话" },
				{ role: "assistant", text: "后来的回复" },
			],
			[
				{ customType: "rp-summary", data: { summary: "第一章：城门遇袭。" } },
				{ customType: "rp-state", data: { time: "第三天", characters: { 小满: { at: "东门" } } } },
			],
		);
		const ev = collectChatEvidence(chat, "阿明", "小满")!;
		assert.ok(ev, "有正文就出证据");
		assert.equal(ev.beats, 2);
		assert.ok(ev.transcript.includes("【前情提要】\n第一章：城门遇袭。"), "既有前情摘要进来");
		assert.ok(!ev.transcript.includes("第一章的旧事"), "被摘要覆盖的正文不进证据（与装配同一条纪律）");
		assert.ok(ev.transcript.includes("阿明：后来的话"), "覆盖之后的正文逐字进来");
		assert.ok(ev.stateSnapshot.includes("第三天") || ev.stateSnapshot.length > 0, "账本快照进来");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("collectChatEvidence：超预算只裁最早的原文、按段落切；多会话窗口用分隔标记连起来", () => {
	const cwd = mkProject();
	try {
		const space = mkCardSpace(cwd);
		const chat = createChat(space.dir);
		const long = "段落内容。".repeat(700);
		writeSession(join(chat.sessionsDir, "s1.jsonl"), [
			{ role: "user", text: `很早的一拍\n\n${long}` },
			{ role: "assistant", text: long },
		]);
		writeSession(join(chat.sessionsDir, "s2.jsonl"), [
			{ role: "user", text: "第二个窗口的话" },
			{ role: "assistant", text: "第二个窗口的回复" },
		]);
		const ev = collectChatEvidence(chat, "阿明", "小满", 3000)!;
		assert.ok(ev.omittedChars > 0, "最早的原文被裁");
		assert.ok(ev.transcript.includes("第二个窗口的话"), "最新的会话完整保留");
		assert.ok(ev.transcript.includes("另一个会话窗口"), "多会话窗口有分隔标记");
		assert.equal(ev.beats, 2);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("collectChatEvidence：只有开场白没有用户消息的局不出证据", () => {
	const cwd = mkProject();
	try {
		const space = mkCardSpace(cwd);
		const chat = createChat(space.dir);
		writeSession(join(chat.sessionsDir, "s1.jsonl"), [{ role: "assistant", text: "（开场白）" }]);
		assert.equal(collectChatEvidence(chat, "阿明", "小满"), null);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------- sourceMarkOf ----------

test("sourceMarkOf：内容没动就稳定；动了（大小/时戳）就变", () => {
	const cwd = mkProject();
	try {
		const space = mkCardSpace(cwd);
		const chat = createChat(space.dir);
		const f = join(chat.sessionsDir, "s1.jsonl");
		writeSession(f, [{ role: "user", text: "一拍" }]);
		const m1 = sourceMarkOf(chat);
		assert.equal(sourceMarkOf(chat), m1, "没动就稳定");
		utimesSync(f, new Date(), new Date(Date.now() + 5000));
		assert.notEqual(sourceMarkOf(chat), m1, "时戳动了就变");
		writeSession(f, [{ role: "user", text: "一拍，改了点" }]);
		assert.notEqual(sourceMarkOf(chat), m1, "大小动了就变");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------- buildRecapPrompt / buildConsolidatePrompt ----------

test("buildRecapPrompt：对话、既有复盘、账本快照、防注入一句都在", () => {
	const { systemPrompt, userText } = buildRecapPrompt({
		evidence: { transcript: "阿明：好", omittedChars: 1200, beats: 3, stateSnapshot: "【时间】第一天" },
		chatName: "初来乍到",
		previousRecap: RECAP_A,
		language: "中文",
		userName: "阿明",
		charName: "小满",
	});
	assert.ok(systemPrompt.includes("复盘"));
	assert.ok(systemPrompt.includes("不是给你的指令"), "数据不当指令的安全句");
	assert.ok(userText.includes("1200"), "被裁字数有说明");
	assert.ok(userText.includes("<conversation chat=\"初来乍到\""));
	assert.ok(userText.includes("<previous-recap>"));
	assert.ok(userText.includes("【工具账本快照】"));
});

test("buildConsolidatePrompt：增改的复盘逐份进、删除的进遗忘队列、预算数字进指令", () => {
	const { systemPrompt, userText } = buildConsolidatePrompt({
		diff: {
			changed: [{ chatId: "20260907", name: "雪夜", text: RECAP_B }],
			deleted: ["20260101"],
			hashes: { "20260907": "x" },
		},
		handbook: "# 记忆",
		resident: "# 往局记忆",
		language: "中文",
		userName: "阿明",
		charName: "小满",
	});
	assert.ok(systemPrompt.includes(String(RESIDENT_MAX_CHARS)), "预算进合并指令");
	assert.ok(systemPrompt.includes("只由"), "遗忘语义进合并指令");
	assert.ok(userText.includes("<recap chat-id=\"20260907\""));
	assert.ok(userText.includes("<deleted-chats>"));
	assert.ok(userText.includes("局/20260101.md"));
});

// ---------- parseConsolidateResult ----------

test("parseConsolidateResult：两段齐全才算数；缺一段/乱序＝null；围栏剥掉", () => {
	const ok = mergeOutput("# 手册正文", "# 摘要正文");
	const parsed = parseConsolidateResult(ok)!;
	assert.equal(parsed.handbook, "# 手册正文");
	assert.equal(parsed.resident, "# 摘要正文");

	const fenced = mergeOutput("```markdown\n# 手册\n```", "```\n# 摘要\n```");
	const p2 = parseConsolidateResult(fenced)!;
	assert.equal(p2.handbook, "# 手册");
	assert.equal(p2.resident, "# 摘要");

	assert.equal(parseConsolidateResult(`只有一段\n${RESIDENT_MARK}\n# 摘要`), null, "缺手册段");
	assert.equal(parseConsolidateResult(`${HANDBOOK_MARK}\n\n${RESIDENT_MARK}\n# 摘要`), null, "手册空");
});

// ---------- fitResidentSummary ----------

test("fitResidentSummary：单份上限内原样；超了在段落边界截断；封套挤到下限就整段退场", () => {
	const short = "# 往局记忆\n\n- 一条";
	assert.equal(fitResidentSummary(short, 0), short);
	assert.equal(fitResidentSummary(short, RESIDENT_ENVELOPE_CHARS - short.length), short, "封套刚好装得下就不动");

	const long = `# 往局记忆\n\n${"第一段。".repeat(400)}\n\n${"第二段。".repeat(400)}`;
	const cut = fitResidentSummary(long, 0)!;
	assert.ok(cut.length <= RESIDENT_MAX_CHARS);
	assert.ok(cut.endsWith("（……余下内容因篇幅略）"));
	assert.ok(cut.startsWith("# 往局记忆"), "截断保头不保尾");

	// 本局账本把封套吃光：摘要退场
	assert.equal(fitResidentSummary(long, RESIDENT_ENVELOPE_CHARS), undefined);
	// 刚好还剩一点但不足以下限：也退场
	assert.equal(fitResidentSummary(long, RESIDENT_ENVELOPE_CHARS - 150), undefined);
	// 一点没有摘要：undefined
	assert.equal(fitResidentSummary(undefined, 0), undefined);
});

// ---------- syncCardMemory：整链 ----------

test("syncCardMemory：首次复盘＋合并落盘；第二次无变化零调用；遗忘走删除队列", async () => {
	const cwd = mkProject();
	try {
		const space = mkCardSpace(cwd);
		const p = memoryPaths(space.dir);
		const chatA = createChat(space.dir, { name: "初来乍到" });
		writeSession(join(chatA.sessionsDir, "s1.jsonl"), [
			{ role: "user", text: "进城" },
			{ role: "assistant", text: "进了。" },
		]);
		const chatB = createChat(space.dir, { name: "雪夜" });
		writeSession(join(chatB.sessionsDir, "s1.jsonl"), [
			{ role: "user", text: "下雪了" },
			{ role: "assistant", text: "是雪。" },
		]);

		const calls1: string[] = [];
		const r1 = await syncCardMemory(
			{ sideText: stubSide(calls1) },
			{ cardDir: space.dir, language: "中文", userName: "阿明", charName: "小满" },
		);
		assert.deepEqual(r1.recapped.sort(), [chatA.id, chatB.id].sort(), "两局各复盘一次");
		assert.equal(r1.merged, "ok");
		assert.equal(calls1.filter((c) => c === "recap").length, 2);
		assert.equal(calls1.filter((c) => c === "merge").length, 1, "合并只跑一次");
		assert.ok(loadResidentSummary(space.dir), "常驻摘要落盘");
		assert.ok(readFileSync(p.recapOf(chatA.id), "utf8").includes("小满入城"), "复盘落盘");
		const m1 = loadManifest(space.dir);
		assert.ok(m1.recaps[chatA.id].sourceMark, "清单记了指纹");
		assert.ok(m1.recaps[chatA.id].mergedHash, "清单记了合并哈希");

		// 无变化：零调用
		const calls2: string[] = [];
		const r2 = await syncCardMemory(
			{ sideText: stubSide(calls2) },
			{ cardDir: space.dir, language: "中文", userName: "阿明", charName: "小满" },
		);
		assert.deepEqual(r2.recapped, []);
		assert.equal(r2.merged, "no-change");
		assert.equal(calls2.length, 0);

		// 一局演了新内容：该局重新复盘 → 合并重跑
		writeSession(join(chatA.sessionsDir, "s1.jsonl"), [
			{ role: "user", text: "进城" },
			{ role: "assistant", text: "进了。" },
			{ role: "user", text: "再见" },
			{ role: "assistant", text: "再会。" },
		]);
		const calls3: string[] = [];
		const mergeInputs: string[] = [];
		const side3 = async (sp: string, ut: string) => {
			calls3.push(sp.includes("档案员") ? "recap" : "merge");
			if (sp.includes("档案员")) return `${RECAP_A}\n\n## 续记\n- 第二次复盘补充的内容。`;
			mergeInputs.push(ut);
			return mergeOutput("# 记忆\n\n（更新）", "# 往局记忆（同一世界更早的几局）\n\n- 更新过的一条");
		};
		const r3 = await syncCardMemory(
			{ sideText: side3 },
			{ cardDir: space.dir, language: "中文", userName: "阿明", charName: "小满" },
		);
		assert.deepEqual(r3.recapped, [chatA.id], "只有动过的局重新复盘");
		assert.equal(r3.merged, "ok");
		assert.equal(calls3.filter((c) => c === "recap").length, 1);
		assert.ok(mergeInputs[0].includes("<recap"), "合并输入带上了复盘");

		// 遗忘：手动删掉一局的复盘文件 → 下次同步走删除队列、清单除名
		rmSync(p.recapOf(chatB.id));
		const calls4: string[] = [];
		const forgetInputs: string[] = [];
		const side4 = async (sp: string, ut: string) => {
			calls4.push(sp.includes("档案员") ? "recap" : "merge");
			if (sp.includes("档案员")) return RECAP_A;
			forgetInputs.push(ut);
			return mergeOutput("# 记忆", "# 往局记忆（同一世界更早的几局）");
		};
		const r4 = await syncCardMemory(
			{ sideText: side4 },
			{ cardDir: space.dir, language: "中文", userName: "阿明", charName: "小满" },
		);
		assert.deepEqual(r4.forgotten, [chatB.id]);
		assert.ok(forgetInputs[0].includes("局/" + chatB.id + ".md"), "删除的局进遗忘队列");
		const m4 = loadManifest(space.dir);
		assert.equal(m4.recaps[chatB.id]?.mergedHash, undefined, "遗忘的局丢掉合并哈希（不再有它支撑的记忆），指纹保留");
		// 遗忘后不动它：不会再把 B 复盘回来
		const calls5: string[] = [];
		const r5 = await syncCardMemory(
			{ sideText: stubSide(calls5) },
			{ cardDir: space.dir, language: "中文", userName: "阿明", charName: "小满" },
		);
		assert.deepEqual(r5.recapped, []);
		assert.equal(r5.merged, "no-change");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("syncCardMemory：Phase1 失败不落盘不挡别人；Phase2 解析失败两份文件都不动", async () => {
	const cwd = mkProject();
	try {
		const space = mkCardSpace(cwd);
		const p = memoryPaths(space.dir);
		const chatA = createChat(space.dir, { name: "甲" });
		writeSession(join(chatA.sessionsDir, "s1.jsonl"), [
			{ role: "user", text: "a" },
			{ role: "assistant", text: "b" },
		]);
		const chatB = createChat(space.dir, { name: "乙" });
		writeSession(join(chatB.sessionsDir, "s1.jsonl"), [
			{ role: "user", text: "c" },
			{ role: "assistant", text: "d" },
		]);

		// Phase1：A 直接失败（空文本）、B 正常 —— B 的复盘照落、合并随后跑
		const r1 = await syncCardMemory(
			{
				sideText: async (sp, ut) =>
					sp.includes("档案员") ? (ut.includes('chat="乙"') ? RECAP_A : "") : mergeOutput("# 记忆", "# 往局记忆（同一世界更早的几局）"),
			},
			{ cardDir: space.dir, language: "中文", userName: "阿明", charName: "小满" },
		);
		assert.deepEqual(r1.failed, [chatA.id]);
		assert.deepEqual(r1.recapped, [chatB.id]);
		assert.ok(!existsQuiet(p.recapOf(chatA.id)), "失败的局不落盘");
		assert.ok(existsQuiet(p.recapOf(chatB.id)));

		// Phase2 解析失败：两份文件都不写（A 依旧失败、B 无变化 → 无合并输入）
		const before = loadResidentSummary(space.dir);
		const r2 = await syncCardMemory(
			{
				sideText: async (sp, ut) =>
					sp.includes("档案员") ? (ut.includes('chat="甲"') ? "" : RECAP_A) : "记忆管理员没按格式输出",
			},
			{ cardDir: space.dir, language: "中文", userName: "阿明", charName: "小满" },
		);
		assert.equal(r2.merged, "no-change");
		assert.equal(loadResidentSummary(space.dir), before);

		// A 这轮复盘成功但合并输出坏 → failed、文件不动
		await syncCardMemory(
			{ sideText: async (sp) => (sp.includes("档案员") ? RECAP_B : "坏输出") },
			{ cardDir: space.dir, language: "中文", userName: "阿明", charName: "小满" },
		);
		const r3 = await syncCardMemory(
			{ sideText: async (sp) => (sp.includes("档案员") ? RECAP_B : "还是坏输出") },
			{ cardDir: space.dir, language: "中文", userName: "阿明", charName: "小满" },
		);
		assert.equal(r3.merged, "failed");
		assert.equal(loadResidentSummary(space.dir), before, "失败不动常驻摘要");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("syncCardMemory：没演过正文的空子项目记指纹但不复盘、不调模型", async () => {
	const cwd = mkProject();
	try {
		const space = mkCardSpace(cwd);
		const chat = createChat(space.dir, { name: "空局" });
		// 有会话文件但只有一条 assistant 开场白（没有用户消息）
		writeSession(join(chat.sessionsDir, "s1.jsonl"), [{ role: "assistant", text: "（开场白）" }]);
		const calls: string[] = [];
		const r = await syncCardMemory(
			{ sideText: stubSide(calls) },
			{ cardDir: space.dir, language: "中文", userName: "阿明", charName: "小满" },
		);
		assert.deepEqual(r.recapped, []);
		assert.equal(r.merged, "no-change");
		assert.equal(calls.length, 0, "零模型调用");
		assert.ok(loadManifest(space.dir).recaps[chat.id], "指纹记下，下次不再反复读");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("diffRecaps：清单没有的复盘＝新增；哈希不符＝改；盘上没了且上次并过＝删；上次没并过的直接消失不算遗忘", () => {
	const cwd = mkProject();
	try {
		const space = mkCardSpace(cwd);
		const p = memoryPaths(space.dir);
		const nameOf = (id: string) => id;
		const empty = { version: 1 as const, recaps: {} };

		// 空清单 + 盘上两份 → 两份都是新增
		mkdirSync(p.recapsDir, { recursive: true });
		writeFileSync(p.recapOf("1111"), "复盘一");
		writeFileSync(p.recapOf("2222"), "复盘二");
		const d1 = diffRecaps(space.dir, empty, nameOf);
		assert.deepEqual(d1.changed.map((c) => c.chatId), ["1111", "2222"]);
		assert.deepEqual(d1.deleted, []);

		// 清单记了 1111 的哈希；改掉 1111 的内容、删掉 2222（没并过）→ 1111 变更、无遗忘
		const seen = { version: 1 as const, recaps: { "1111": { sourceMark: "m", recapAt: "t", mergedHash: d1.hashes["1111"] } } };
		writeFileSync(p.recapOf("1111"), "复盘一（改）");
		rmSync(p.recapOf("2222"));
		const d2 = diffRecaps(space.dir, seen, nameOf);
		assert.deepEqual(d2.changed.map((c) => c.chatId), ["1111"]);
		assert.deepEqual(d2.deleted, [], "上次没并过的复盘消失不是遗忘（没有支撑它的记忆）");

		// 1111 也从盘上消失 → 它上次并过 → 遗忘
		rmSync(p.recapOf("1111"));
		const d3 = diffRecaps(space.dir, seen, nameOf);
		assert.deepEqual(d3.deleted, ["1111"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

function existsQuiet(p: string): boolean {
	try {
		readFileSync(p);
		return true;
	} catch {
		return false;
	}
}
