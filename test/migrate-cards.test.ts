import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listCardSpaces, listChats, readChatMeta } from "../src/cardspace.ts";
import { parseCardFromSessionHead } from "../src/session-scan.ts";
import {
	alreadyMigrated,
	applyCardMigration,
	chatIdFromSessionFile,
	planCardMigration,
	sessionIdFromFile,
} from "../src/migrate-cards.ts";
import { cardDirOf, chatDirOf, chatSessionsDirOf } from "../src/paths.ts";

/** 一张最小可解析的卡（JSON 卡；loadCardFile 认 V2/V3 外壳） */
function writeCard(path: string, name: string): void {
	writeFileSync(
		path,
		JSON.stringify({ spec: "chara_card_v2", data: { name, description: "", first_mes: "开场" } }),
		"utf8",
	);
}

/** 一个最小会话文件：带 rp-card 自描述条目 */
function writeSession(dirAbs: string, fileName: string, cardRef: string, cardName: string): string {
	const p = join(dirAbs, fileName);
	writeFileSync(
		p,
		[
			JSON.stringify({ type: "session", version: 1, id: "x", cwd: "E:/proj" }),
			JSON.stringify({ type: "custom", customType: "rp-card", data: { card: cardRef, name: cardName } }),
			JSON.stringify({ type: "message", message: { role: "user", content: "喂" } }),
		].join("\n") + "\n",
		"utf8",
	);
	return p;
}

function mkProject() {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-migrate-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "liyuan-sessions-"));
	mkdirSync(join(cwd, "assets", "cards"), { recursive: true });
	return { cwd, sessionDir };
}

test("迁移：卡进文件夹、旧会话各成一个子项目、随身数据跟着走", () => {
	const { cwd, sessionDir } = mkProject();
	try {
		writeCard(join(cwd, "assets", "cards", "a.json"), "甲卡");
		writeCard(join(cwd, "assets", "cards", "b.json"), "乙卡");

		writeSession(sessionDir, "2026-09-05T16-41-36-682Z_01a07272-aaaa.jsonl", "assets/cards/a.json", "甲卡");
		writeSession(sessionDir, "2026-09-01T10-00-00-000Z_01a06023-bbbb.jsonl", "assets\\cards\\a.json", "甲卡");
		writeSession(sessionDir, "2026-08-30T13-03-51-697Z_01a052c4-cccc.jsonl", "assets/cards/b.json", "乙卡");

		// 甲卡第一个会话的随身数据
		mkdirSync(join(cwd, ".liyuan-state"), { recursive: true });
		writeFileSync(join(cwd, ".liyuan-state", "01a07272-aaaa.json"), '{"time":"正午"}');
		mkdirSync(join(cwd, ".liyuan-worldline"), { recursive: true });
		writeFileSync(join(cwd, ".liyuan-worldline", "01a07272-aaaa.json"), '{"deletedSaveIds":[]}');
		mkdirSync(join(cwd, ".liyuan-artifacts"), { recursive: true });
		writeFileSync(join(cwd, ".liyuan-artifacts", "01a07272-aaaa.json"), '{"panels":[]}');
		mkdirSync(join(cwd, ".liyuan-memory", "scopes", "abc1234567__01a07272-aaaa", "stores", "s1"), { recursive: true });
		writeFileSync(
			join(cwd, ".liyuan-memory", "scopes", "abc1234567__01a07272-aaaa", "stores", "s1", "chunks.jsonl"),
			"chunk\n",
		);
		// 补充设定集按卡名存
		mkdirSync(join(cwd, ".liyuan-lore"), { recursive: true });
		writeFileSync(join(cwd, ".liyuan-lore", "甲卡.json"), '{"entries":{}}');

		assert.equal(alreadyMigrated(cwd), false);
		const plan = planCardMigration(cwd, sessionDir);
		assert.deepEqual(
			plan.cards.map((c) => c.folder).sort(),
			["乙卡", "甲卡"],
			"文件夹名取卡显示名",
		);
		assert.equal(plan.sessions.length, 3);
		assert.equal(plan.skipped.length, 0);
		// 计划是只读的
		assert.ok(existsSync(join(cwd, "assets", "cards", "a.json")), "plan 阶段不许动盘");

		const log = applyCardMigration(cwd, plan);
		assert.ok(log.length > 0);
		assert.equal(alreadyMigrated(cwd), true);

		// 卡进了文件夹
		assert.deepEqual(listCardSpaces(cwd).map((s) => s.folder).sort(), ["乙卡", "甲卡"]);
		assert.ok(!existsSync(join(cwd, "assets", "cards", "a.json")), "卡本体已搬走");
		assert.ok(existsSync(join(cardDirOf(cwd, "甲卡"), "a.json")));

		// 甲卡两个子项目、乙卡一个
		const jia = listChats(cardDirOf(cwd, "甲卡"));
		assert.equal(jia.length, 2, "今天的一个会话＝一个子项目");
		assert.equal(listChats(cardDirOf(cwd, "乙卡")).length, 1);
		for (const c of jia) assert.equal(c.sessionCount, 1);

		// 随身数据落到对应子项目
		const chatId = "20260905-164136-01a0";
		const chatAbs = chatDirOf(cardDirOf(cwd, "甲卡"), chatId);
		assert.ok(existsSync(join(chatSessionsDirOf(cardDirOf(cwd, "甲卡"), chatId), "2026-09-05T16-41-36-682Z_01a07272-aaaa.jsonl")));
		assert.equal(readFileSync(join(chatAbs, "世界状态.json"), "utf8"), '{"time":"正午"}');
		assert.ok(existsSync(join(chatAbs, "世界线.json")));
		assert.ok(existsSync(join(chatAbs, "面板.json")));
		assert.ok(existsSync(join(chatAbs, "向量记忆", "stores", "s1", "chunks.jsonl")), "向量记忆整个 scope 目录跟着走");
		assert.ok(readChatMeta(cardDirOf(cwd, "甲卡"), chatId)?.createdAt, "子项目元数据要有建立时间");

		// 补充设定集进卡文件夹
		assert.ok(existsSync(join(cardDirOf(cwd, "甲卡"), "补充设定集.json")));

		// 搬完的会话追加 rp-card 重绑定行：认最后一条 ⇒ 新引用
		const moved2 = readFileSync(
			join(chatSessionsDirOf(cardDirOf(cwd, "甲卡"), chatId), "2026-09-05T16-41-36-682Z_01a07272-aaaa.jsonl"),
			"utf8",
		).split(/\r?\n/).filter(Boolean);
		assert.ok(moved2.length >= 4, "重绑定行已追加");
		const last = JSON.parse(moved2[moved2.length - 1]) as { type: string; customType: string; data: { card: string; name?: string } };
		assert.equal(last.customType, "rp-card");
		assert.equal(last.data.card, "cards/甲卡/a.json", "重绑定行指向新卡引用");
		assert.equal(last.data.name, "甲卡");
		const parsed = parseCardFromSessionHead(moved2.join("\n"));
		assert.equal(parsed?.card, "cards/甲卡/a.json", "浅扫描认最后一条 ⇒ 新引用");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("迁移：助手会话按 storyId 归入子项目，config.card 改指新引用", () => {
	const { cwd, sessionDir } = mkProject();
	try {
		writeCard(join(cwd, "assets", "cards", "a.json"), "甲卡");
		writeSession(sessionDir, "2026-09-05T16-41-36-682Z_01a07272-aaaa.jsonl", "assets/cards/a.json", "甲卡");

		// config 指着旧卡；personas 有按旧卡锁定；收藏里有旧卡
		writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "assets/cards/a.json", userName: "旅人" }), "utf8");
		writeFileSync(
			join(cwd, ".liyuan-personas.json"),
			JSON.stringify({ personas: [{ id: "p1", name: "明月", persona: "" }], current: "p1", byCard: { "assets/cards/a.json": "p1" } }),
			"utf8",
		);
		mkdirSync(join(cwd, ".liyuan-cache"), { recursive: true });
		writeFileSync(join(cwd, ".liyuan-cache", "card-favs.json"), JSON.stringify(["assets/cards/a.json", "assets/cards/别的.png"]));

		// 助手会话：rp-card 带 storyId=01a07272-aaaa（对应上面那个剧情会话）
		mkdirSync(join(cwd, ".liyuan-assistant"), { recursive: true });
		const asst = [
			'{"type":"session","version":3,"id":"x","cwd":"E:/proj"}',
			'{"type":"custom","customType":"rp-card","data":{"card":"assets/cards/a.json","name":"甲卡","storyId":"01a07272-aaaa"},"id":"e1","parentId":null,"timestamp":"2026-07-18T00:00:00.000Z"}',
		].join("\n") + "\n";
		writeFileSync(join(cwd, ".liyuan-assistant", "2026-07-18T15-10-12-939Z_019f75c7.jsonl"), asst);
		// storyId 对不上任何剧情会话的：原地不动
		const orphan = asst.replace("01a07272-aaaa", "01a99999-zzzz");
		writeFileSync(join(cwd, ".liyuan-assistant", "2026-08-31T02-14-20-905Z_01a05598.jsonl"), orphan);

		applyCardMigration(cwd, planCardMigration(cwd, sessionDir));

		// config.card 换新引用
		assert.equal((JSON.parse(readFileSync(join(cwd, "liyuan.config.json"), "utf8")) as { card: string }).card, "cards/甲卡/a.json");
		// personas byCard 换键
		const store = JSON.parse(readFileSync(join(cwd, ".liyuan-personas.json"), "utf8")) as { byCard: Record<string, string> };
		assert.ok(store.byCard["cards/甲卡/a.json"], "按卡锁定改指新引用");
		assert.ok(!store.byCard["assets/cards/a.json"], "旧键不在");
		// 收藏改指新引用，别的条目不动
		const favs = JSON.parse(readFileSync(join(cwd, ".liyuan-cache", "card-favs.json"), "utf8")) as string[];
		assert.deepEqual(favs, ["cards/甲卡/a.json", "assets/cards/别的.png"]);
		// 助手会话：对得上的进子项目，对不上的原地不动
		assert.ok(existsSync(join(chatDirOf(cardDirOf(cwd, "甲卡"), "20260905-164136-01a0"), "助手会话", "2026-07-18T15-10-12-939Z_019f75c7.jsonl")));
		assert.ok(existsSync(join(cwd, ".liyuan-assistant", "2026-08-31T02-14-20-905Z_01a05598.jsonl")), "认不出的助手会话原地不动");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("迁移：认不出卡的会话原地不动，绝不猜", () => {
	const { cwd, sessionDir } = mkProject();
	try {
		writeCard(join(cwd, "assets", "cards", "a.json"), "甲卡");
		// 没有 rp-card 标记
		writeFileSync(join(sessionDir, "2026-01-01T00-00-00-000Z_01a00000-dddd.jsonl"), '{"type":"session"}\n');
		// 标记指向卡库里没有的卡
		writeSession(sessionDir, "2026-01-02T00-00-00-000Z_01a00001-eeee.jsonl", "assets/cards/没这张.png", "幽灵");

		const plan = planCardMigration(cwd, sessionDir);
		assert.equal(plan.sessions.length, 0);
		assert.equal(plan.skipped.length, 2);
		applyCardMigration(cwd, plan);
		assert.equal(existsSync(join(sessionDir, "2026-01-01T00-00-00-000Z_01a00000-dddd.jsonl")), true);
		assert.equal(existsSync(join(sessionDir, "2026-01-02T00-00-00-000Z_01a00001-eeee.jsonl")), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("迁移：同名卡不互相覆盖", () => {
	const { cwd, sessionDir } = mkProject();
	try {
		writeCard(join(cwd, "assets", "cards", "x1.json"), "重名");
		writeCard(join(cwd, "assets", "cards", "x2.json"), "重名");
		const plan = planCardMigration(cwd, sessionDir);
		assert.deepEqual(plan.cards.map((c) => c.folder), ["重名", "重名-2"]);
		applyCardMigration(cwd, plan);
		assert.deepEqual(listCardSpaces(cwd).map((s) => s.folder).sort(), ["重名", "重名-2"]);
		assert.ok(existsSync(join(cardDirOf(cwd, "重名"), "x1.json")));
		assert.ok(existsSync(join(cardDirOf(cwd, "重名-2"), "x2.json")));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("迁移：再跑一次不重复搬、不覆盖（幂等）", () => {
	const { cwd, sessionDir } = mkProject();
	try {
		writeCard(join(cwd, "assets", "cards", "a.json"), "甲卡");
		writeSession(sessionDir, "2026-09-05T16-41-36-682Z_01a07272-aaaa.jsonl", "assets/cards/a.json", "甲卡");
		applyCardMigration(cwd, planCardMigration(cwd, sessionDir));

		const again = planCardMigration(cwd, sessionDir);
		assert.equal(again.cards.length, 0, "assets/cards 已空，没有可搬的卡");
		assert.equal(again.sessions.length, 0, "会话已搬走");
		const log = applyCardMigration(cwd, again);
		assert.deepEqual(log, []);
		assert.equal(listCardSpaces(cwd).length, 1);
		assert.equal(listChats(cardDirOf(cwd, "甲卡")).length, 1);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("会话文件名 → 子项目 id / 会话 id", () => {
	assert.equal(chatIdFromSessionFile("2026-09-05T16-41-36-682Z_01a07272-6caa-7267.jsonl"), "20260905-164136-01a0");
	assert.equal(chatIdFromSessionFile("2026-01-02T03-04-05-000Z_abcd1234.jsonl"), "20260102-030405-abcd");
	// 不合套路的文件名也要给出可排序、Windows 合法的 id
	const odd = chatIdFromSessionFile("怪名字.jsonl", 7);
	assert.match(odd, /^\d{8}-\d{6}-\d{4}$/);
	assert.ok(!odd.includes(":"));

	assert.equal(sessionIdFromFile("2026-09-05T16-41-36-682Z_01a07272-6caa-7267.jsonl"), "01a07272-6caa-7267");
	assert.equal(sessionIdFromFile("怪名字.jsonl"), "");
});
