import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	CARD_LEVEL_KEYS,
	cardFileIn,
	chatInfo,
	createCardSpace,
	createChat,
	freeCardFolder,
	latestChat,
	listCardSpaces,
	listChats,
	loadCardConfig,
	mergeCardConfig,
	newChatId,
	readChatMeta,
	resolveCardSpace,
	saveCardConfig,
	writeChatMeta,
} from "../src/cardspace.ts";
import { CARDS_ROOT, cardDirOf, chatSessionsDirOf } from "../src/paths.ts";
import { DEFAULT_CONFIG, type RpConfig } from "../src/types.ts";

function mkProject() {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-cardspace-"));
	mkdirSync(join(cwd, "assets", "cards"), { recursive: true });
	return cwd;
}

/** 建一张「已经在卡文件夹里」的卡 */
function mkCard(cwd: string, folder: string, file = "卡本体.png"): string {
	const dirAbs = cardDirOf(cwd, folder);
	mkdirSync(dirAbs, { recursive: true });
	writeFileSync(join(dirAbs, file), "PNGDATA");
	return dirAbs;
}

test("卡文件夹：认得出卡本体，认不出只有配置的空壳", () => {
	const cwd = mkProject();
	try {
		const dirAbs = mkCard(cwd, "某卡");
		assert.equal(cardFileIn(dirAbs), join(dirAbs, "卡本体.png"));

		// 卡.json 是固定成员，不能被当成卡本体
		const empty = cardDirOf(cwd, "空壳");
		mkdirSync(empty, { recursive: true });
		writeFileSync(join(empty, "卡.json"), "{}");
		assert.equal(cardFileIn(empty), null, "只有卡.json 的目录不是一张卡");
		assert.equal(resolveCardSpace(cwd, `${CARDS_ROOT}/空壳`), null);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("卡文件夹：resolveCardSpace 只认 cards/ 下的一级目录", () => {
	const cwd = mkProject();
	try {
		mkCard(cwd, "某卡");
		const space = resolveCardSpace(cwd, "cards/某卡");
		assert.ok(space, "cards/<folder> 应解析成功");
		assert.equal(space.folder, "某卡");
		assert.equal(space.dir, cardDirOf(cwd, "某卡"));

		// 反斜杠 / ./ 前缀 / 结尾斜杠都认
		assert.ok(resolveCardSpace(cwd, "cards\\某卡"));
		assert.ok(resolveCardSpace(cwd, "./cards/某卡/"));
		// 指到卡本体文件也认（config.card 的实际写法）：取第一个路径段当文件夹
		assert.ok(resolveCardSpace(cwd, "cards/某卡/卡本体.png"), "config.card 指着卡本体时也应解析");
		// 旧的「卡是文件」写法、目录不存在：一律不认（调用方按老路径处理）
		assert.equal(resolveCardSpace(cwd, "assets/cards/a.png"), null);
		assert.equal(resolveCardSpace(cwd, "cards/没有这张"), null);
		assert.equal(resolveCardSpace(cwd, "cards"), null);
		assert.equal(resolveCardSpace(cwd, ""), null);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("卡库：listCardSpaces 只列含卡本体的目录", () => {
	const cwd = mkProject();
	try {
		mkCard(cwd, "甲");
		mkCard(cwd, "乙", "b.json");
		mkdirSync(cardDirOf(cwd, "丙没有卡"), { recursive: true });
		const list = listCardSpaces(cwd);
		assert.deepEqual(
			list.map((s) => s.folder),
			["乙", "甲"].sort(),
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("建卡文件夹：同名不覆盖，非法字符换掉，卡本体搬进去", () => {
	const cwd = mkProject();
	try {
		const src = join(cwd, "assets", "cards", "原卡.png");
		writeFileSync(src, "PNGDATA");
		const a = createCardSpace(cwd, src, "《道渊》:v5.2", { move: true });
		assert.equal(a.folder, "《道渊》_v5.2", "非法字符换成 _");
		assert.ok(existsSync(a.cardFile), "卡本体应已搬进卡文件夹");
		assert.ok(!existsSync(src), "move=true 时源文件应已不在");

		const src2 = join(cwd, "assets", "cards", "原卡2.png");
		writeFileSync(src2, "PNGDATA2");
		const b = createCardSpace(cwd, src2, "《道渊》:v5.2", { copy: copyFileSync });
		assert.equal(b.folder, "《道渊》_v5.2-2", "同名让位，不覆盖已有卡");
		assert.ok(existsSync(src2), "copy 时源文件仍在（导入语义）");

		assert.equal(freeCardFolder(cwd, "《道渊》:v5.2"), "《道渊》_v5.2-3");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("子项目：新开对话建目录 + 会话目录 + 元数据", () => {
	const cwd = mkProject();
	try {
		const dirAbs = mkCard(cwd, "某卡");
		assert.deepEqual(listChats(dirAbs), [], "还没有对话时是空的");
		assert.equal(latestChat(dirAbs), null);

		const chat = createChat(dirAbs, { name: "第一局" });
		assert.ok(existsSync(chat.sessionsDir), "会话目录（＝sessionDir）应已建好");
		assert.equal(chat.sessionsDir, chatSessionsDirOf(dirAbs, chat.id));
		assert.equal(chat.sessionCount, 0);
		assert.equal(readChatMeta(dirAbs, chat.id)?.name, "第一局");
		assert.match(chat.id, /^\d{8}-\d{6}-[0-9a-f]{4}$/, "对话 id 可排序、无冒号（Windows 合法）");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("子项目：一个对话里可以有很多会话，列表按最近活动倒序", () => {
	const cwd = mkProject();
	try {
		const dirAbs = mkCard(cwd, "某卡");
		const older = createChat(dirAbs, { id: "20260101-000000-aaaa", name: "旧局" });
		const newer = createChat(dirAbs, { id: "20260102-000000-bbbb", name: "新局" });

		// 同一个子项目里的三个会话（「在第二个窗口继续聊」落在这里）
		writeFileSync(join(older.sessionsDir, "only.jsonl"), '{"type":"session"}\n');
		for (const f of ["a.jsonl", "b.jsonl", "c.jsonl"]) {
			writeFileSync(join(newer.sessionsDir, f), '{"type":"session"}\n');
		}
		// mtime 钉死，别让「同一毫秒写完」决定测试结果
		utimesSync(join(older.sessionsDir, "only.jsonl"), new Date(1_000_000), new Date(1_000_000));
		for (const f of ["a.jsonl", "b.jsonl", "c.jsonl"]) {
			utimesSync(join(newer.sessionsDir, f), new Date(2_000_000), new Date(2_000_000));
		}

		assert.equal(chatInfo(dirAbs, newer.id).sessionCount, 3);
		assert.equal(chatInfo(dirAbs, older.id).sessionCount, 1);

		const list = listChats(dirAbs);
		assert.equal(list.length, 2);
		assert.equal(list[0].id, newer.id, "最近有会话写入的排最前");
		assert.equal(latestChat(dirAbs)?.id, newer.id);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("子项目：元数据缺失也照样列得出（不因坏文件消失）", () => {
	const cwd = mkProject();
	try {
		const dirAbs = mkCard(cwd, "某卡");
		const chat = createChat(dirAbs, { id: "20260101-000000-cccc" });
		writeFileSync(join(chat.dir, "对话.json"), "{ 坏 json");
		assert.equal(readChatMeta(dirAbs, chat.id), null);
		assert.equal(listChats(dirAbs).length, 1, "元数据坏了，对话本身还在");

		writeChatMeta(dirAbs, chat.id, { createdAt: "2026-01-01T00:00:00.000Z", name: "改过名" });
		assert.equal(readChatMeta(dirAbs, chat.id)?.name, "改过名");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("卡级配置：只收跟卡走的字段，写 null 等于回到继承全局", () => {
	const cwd = mkProject();
	try {
		const dirAbs = mkCard(cwd, "某卡");
		assert.deepEqual(loadCardConfig(dirAbs), {}, "没有卡.json ＝ 这张卡没有自己的意见");

		saveCardConfig(dirAbs, { userName: "明月", language: "英文", scanDepth: 99 });
		const got = loadCardConfig(dirAbs);
		assert.deepEqual(got, { userName: "明月" }, "全局字段（language/scanDepth）不许落进卡级");

		saveCardConfig(dirAbs, { greetingIndex: 1, preset: "assets/presets/x.json" });
		assert.deepEqual(loadCardConfig(dirAbs), { userName: "明月", greetingIndex: 1, preset: "assets/presets/x.json" });

		saveCardConfig(dirAbs, { preset: null });
		assert.equal(loadCardConfig(dirAbs).preset, undefined, "null ＝ 删掉这条意见");

		// 坏文件：当成没有意见，不抛
		writeFileSync(join(dirAbs, "卡.json"), "{ 坏");
		assert.deepEqual(loadCardConfig(dirAbs), {});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("卡级配置：逐字段赢者独占，卡级盖全局；没写的继承", () => {
	const global: RpConfig = { ...DEFAULT_CONFIG, userName: "旅人", language: "中文", scanDepth: 4, greetingIndex: 0 };
	const merged = mergeCardConfig(global, { userName: "明月", greetingIndex: 1 });
	assert.equal(merged.userName, "明月", "卡级盖全局");
	assert.equal(merged.greetingIndex, 1);
	assert.equal(merged.language, "中文", "卡级没写 ⇒ 继承全局");
	assert.equal(merged.scanDepth, 4);
	assert.equal(global.userName, "旅人", "不得原地改全局配置对象");

	// 假值也要盖得住（false/0/空串/空数组不是「没写」）
	const m2 = mergeCardConfig({ ...global, greeting: true, lorebooks: ["g.json"] }, { greeting: false, lorebooks: [], greetingIndex: 0 });
	assert.equal(m2.greeting, false);
	assert.deepEqual(m2.lorebooks, []);
	assert.equal(m2.greetingIndex, 0);
});

test("卡级字段清单：card 留在全局（「当前打开哪张卡」不是某张卡的属性）", () => {
	assert.ok(!(CARD_LEVEL_KEYS as readonly string[]).includes("card"));
	for (const k of ["language", "scanDepth", "maxLoreInjections", "backendControl", "compactEveryNTurns", "sideModel", "creationMode", "importStripTags"]) {
		assert.ok(!(CARD_LEVEL_KEYS as readonly string[]).includes(k), `${k} 应留在全局`);
	}
	assert.equal(new Set(CARD_LEVEL_KEYS).size, CARD_LEVEL_KEYS.length, "清单不许有重复");
});

test("对话 id：同一秒内也不撞（时间戳 + 随机后缀）", () => {
	const now = new Date("2026-09-06T01:23:45");
	const ids = new Set(Array.from({ length: 200 }, () => newChatId(now)));
	assert.ok(ids.size > 190, `200 次生成应几乎不重复，实际 ${ids.size}`);
	for (const id of ids) assert.match(id, /^20260906-012345-[0-9a-f]{4}$/);
});


test("createCardFile：新卡直接落成卡空间，同名拒写", async () => {
	const { createCardFile } = await import("../server/rest.ts");
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-newcard-"));
	try {
		const made = createCardFile(cwd, { name: "新卡", firstMes: "开场" });
		assert.ok(made, "新卡应创建成功");
		assert.equal(made.path, "cards/新卡/新卡.json");
		assert.ok(existsSync(join(cwd, "cards", "新卡", "新卡.json")));
		assert.equal(createCardFile(cwd, { name: "新卡", firstMes: "开场" }), null, "同名拒写（已升格的空间里也算）");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
