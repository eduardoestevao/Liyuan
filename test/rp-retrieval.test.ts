import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lorebookRead, lorebookSearch } from "../src/tools/lore.ts";
import { loreFingerprint } from "../src/lorebook.ts";
import { memoryRead, memorySearch as searchTool } from "../src/tools/memory.ts";
import { memoryListChunks, memoryReadChunk, memorySearchReport, onNarrativeTurnEnd, updateMemoryConfig, updateStoreConfig } from "../src/memory/service.ts";
import { changeCardMemory, listCardMemory, readCardMemory, searchCardMemory } from "../src/card-memory-tools.ts";
import { HANDBOOK_MARK, RESIDENT_MARK, loadManifest, memoryPaths, saveManifest, syncCardMemory } from "../src/card-memory.ts";
import { modelVisibleSkillFiles, readStageSkill, scanSkillFiles } from "../src/stage/materials.ts";
import { saveStageSkill } from "../src/stage/skill-store.ts";
import { createChat } from "../src/cardspace.ts";

const ctx = { surface: "stage" as const, language: "中文" };
function sandbox(t: { after(fn: () => void): void }) {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-retrieval-v3-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("世界书：检索 ref 可精确读取原文/范围/来源，旧指纹不能指到新内容", async () => {
	let entries = [{ uid: 8, comment: "城门", content: " 北门\r\n\t日落关闭。 ", source: "书一.json", enabled: false }];
	const deps = { searchLore: () => entries.map((entry) => ({ entry })), listLore: () => entries, fingerprint: loreFingerprint };
	const result = await lorebookSearch.run({ query: "北门" }, deps, ctx);
	const ref = `lore:${loreFingerprint(entries[0].content)}`;
	assert.ok(result.text.includes(ref));
	const read = JSON.parse((await lorebookRead.run({ ref }, deps, ctx)).text);
	assert.equal(read.content, entries[0].content);
	assert.equal(read.sources[0].source, "书一.json");
	assert.equal(read.sources[0].enabled, false);
	assert.equal(JSON.parse((await lorebookRead.run({ ref, start: 1, end: 3 }, deps, ctx)).text).content, "北门");
	entries = [{ ...entries[0], content: "北门全天开放。" }];
	assert.equal((await lorebookRead.run({ ref }, deps, ctx)).isError, true);
});

test("会话记忆：检索和精确读取同守分支、会话隔离，停用单独报告", async (t) => {
	const cwd = sandbox(t), scope = { sessionId: "s", card: "card.json" };
	updateMemoryConfig(cwd, { enabled: true, embedMode: "local" });
	updateStoreConfig(cwd, "narrative", { enabled: true, everyNTurns: 1 });
	await onNarrativeTurnEnd(cwd, scope, "她在东门交出了玉佩，并与旧友约好秋天再见。", { nodeId: "old", branchIds: new Set(["u", "old"]) });
	const chunks = memoryListChunks(cwd, scope, "narrative");
	assert.equal(chunks.length, 1);
	const ref = `session:narrative:${chunks[0].id}`;
	assert.equal(memoryReadChunk(cwd, scope, ref, new Set(["u"])), undefined);
	assert.equal(memoryReadChunk(cwd, scope, ref, new Set()), undefined);
	assert.equal(memoryReadChunk(cwd, { ...scope, sessionId: "other" }, ref, new Set(["u", "old"])), undefined);
	assert.equal(memoryReadChunk(cwd, scope, ref, new Set(["u", "old"]))?.text, chunks[0].text);
	const found = await memorySearchReport(cwd, scope, "东门 玉佩", new Set(["u", "old"]));
	assert.ok(found.hits.some((h) => h.ref === ref));
	assert.equal((await memorySearchReport(cwd, scope, "东门 玉佩", new Set(["u"]))).hits.length, 0);
	updateMemoryConfig(cwd, { enabled: false });
	assert.ok((await memorySearchReport(cwd, scope, "玉佩", new Set(["old"]))).sources.every((s) => s.status === "disabled"));
	assert.throws(() => memoryReadChunk(cwd, scope, ref, new Set(["old"])), /停用/);
});

test("记忆工具：失败、停用、真正无命中有不同结果；引用读取不做模糊替代", async (t) => {
	const disabled = await searchTool.run({ query: "玉佩" }, { searchMemory: async () => ({ hits: [], sources: [{ scope: "session", status: "disabled" }] }) }, ctx);
	assert.equal(JSON.parse(disabled.text).sources[0].status, "disabled");
	const missing = await searchTool.run({ query: "玉佩" }, { searchMemory: async () => ({ hits: [], sources: [{ scope: "session", status: "ok" }] }) }, ctx);
	assert.equal(JSON.parse(missing.text).sources[0].status, "ok");
	const failed = await searchTool.run({ query: "玉佩" }, { searchMemory: async () => { throw new Error("索引不可读"); } }, ctx);
	assert.equal(failed.isError, true);
	const read = await memoryRead.run({ ref: "不存在" }, { searchMemory: async () => [], readMemory: () => undefined }, ctx);
	assert.equal(read.isError, true);
	const cardDir = sandbox(t);
	assert.equal(searchCardMemory(cardDir, "玉佩").length, 0);
	mkdirSync(memoryPaths(cardDir).handbook, { recursive: true });
	assert.throws(() => searchCardMemory(cardDir, "玉佩"), "不可读文件不能伪装成无命中");
});

test("卡级记忆：原文版本、纠正源头、失效汇总、遗忘不被下一次同步复活", async (t) => {
	const cardDir = sandbox(t), p = memoryPaths(cardDir);
	const chat = createChat(cardDir, { name: "旧局" });
	mkdirSync(p.recapsDir, { recursive: true });
	writeFileSync(p.recapOf(chat.id), "她在北门交出了玉佩。\n");
	writeFileSync(p.handbook, "旧汇总：北门。"); writeFileSync(p.resident, "北门。");
	const ref = `card:recap:${chat.id}`, read = readCardMemory(cardDir, ref)!;
	assert.equal(read.meta?.chatId, chat.id);
	assert.ok(searchCardMemory(cardDir, "玉佩").some((h) => h.ref === ref));
	const corrected = changeCardMemory(cardDir, ref, read.version, "她在东门交出了玉佩。\n")!;
	assert.equal(corrected.text, "她在东门交出了玉佩。\n");
	assert.ok(!existsSync(p.handbook) && !existsSync(p.resident));
	assert.throws(() => changeCardMemory(cardDir, ref, read.version, "旧版本写入"), /版本冲突/);
	changeCardMemory(cardDir, ref, corrected.version);
	assert.equal(readCardMemory(cardDir, ref), undefined);
	writeFileSync(join(chat.sessionsDir, "s.jsonl"), [
		{ type: "session", id: "s" }, { type: "message", id: "u", parentId: null, message: { role: "user", content: "记起旧事" } },
		{ type: "message", id: "a", parentId: "u", message: { role: "assistant", content: "北门交出玉佩" } },
	].map((e) => JSON.stringify(e)).join("\n"));
	let calls = 0;
	await syncCardMemory({ sideText: async () => { calls++; return "不应生成"; } }, { cardDir, language: "中文", userName: "B", charName: "A" });
	assert.equal(calls, 0);
	assert.ok(!existsSync(p.recapOf(chat.id)));
	assert.ok(loadManifest(cardDir).manual?.forgottenChats.includes(chat.id));
});

test("卡级手工汇总：不被旧复盘覆盖，也不把被取代的旧来源重新检索出来", async (t) => {
	const cardDir = sandbox(t), p = memoryPaths(cardDir);
	mkdirSync(p.recapsDir, { recursive: true });
	writeFileSync(p.recapOf("chat-a"), "旧记忆：北门");
	writeFileSync(p.handbook, "旧记忆：北门"); writeFileSync(p.resident, "北门");
	const before = readCardMemory(cardDir, "card:handbook")!;
	changeCardMemory(cardDir, before.ref, before.version, "用户更正：东门");
	assert.equal(searchCardMemory(cardDir, "北门").length, 0);
	assert.equal(listCardMemory(cardDir).length, 1);
	let calls = 0;
	await syncCardMemory({ sideText: async () => { calls++; return "北门"; } }, { cardDir, language: "中文", userName: "B", charName: "A" });
	assert.equal(calls, 0);
	assert.equal(readFileSync(p.handbook, "utf8"), "用户更正：东门");
});

test("后台合并：等待模型期间的更正使旧结果失效", async (t) => {
	const cardDir = sandbox(t), p = memoryPaths(cardDir);
	mkdirSync(p.recapsDir, { recursive: true });
	writeFileSync(p.recapOf("chat-a"), "原有资料");
	writeFileSync(p.handbook, "旧手册"); writeFileSync(p.resident, "旧摘要");
	const result = await syncCardMemory({ sideText: async () => {
		const doc = readCardMemory(cardDir, "card:handbook")!;
		changeCardMemory(cardDir, doc.ref, doc.version, "用户刚更正的手册");
		return `${HANDBOOK_MARK}\n过期手册\n${RESIDENT_MARK}\n过期摘要`;
	} }, { cardDir, language: "中文", userName: "B", charName: "A" });
	assert.equal(result.merged, "skipped");
	assert.equal(readFileSync(p.handbook, "utf8"), "用户刚更正的手册");
	assert.ok(!existsSync(p.resident));
});

test("后台复盘：等待模型期间删除源复盘，不会被在途结果覆盖", async (t) => {
	const cardDir = sandbox(t), p = memoryPaths(cardDir), chat = createChat(cardDir, { name: "局" });
	mkdirSync(p.recapsDir, { recursive: true });
	writeFileSync(p.recapOf(chat.id), "旧复盘");
	writeFileSync(join(chat.sessionsDir, "s.jsonl"), [
		{ type: "session", id: "s" }, { type: "message", id: "u", parentId: null, message: { role: "user", content: "继续" } },
		{ type: "message", id: "a", parentId: "u", message: { role: "assistant", content: "她推开了门。" } },
	].map((e) => JSON.stringify(e)).join("\n"));
	const result = await syncCardMemory({ sideText: async () => {
		const doc = readCardMemory(cardDir, `card:recap:${chat.id}`)!;
		changeCardMemory(cardDir, doc.ref, doc.version);
		return "过期复盘";
	} }, { cardDir, language: "中文", userName: "B", charName: "A" });
	assert.deepEqual(result.failed, [chat.id]);
	assert.ok(!existsSync(p.recapOf(chat.id)));
});

test("卡级技能：覆盖全局、停用可遮盖、引用按需读取，编辑与读取同目录", (t) => {
	const cwd = sandbox(t), cardDir = join(cwd, "cards", "测试卡");
	mkdirSync(cardDir, { recursive: true }); writeFileSync(join(cardDir, "角色.json"), JSON.stringify({ data: { name: "测试卡" } }));
	writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "cards/测试卡" }));
	const skill = (root: string, body: string, disabled = false) => {
		const dir = join(root, "method"); mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), `---\nname: method\ndescription: 写作参考\n${disabled ? "disable-model-invocation: true\n" : ""}---\n${body}`);
		return dir;
	};
	skill(join(cwd, "skills"), "全局正文");
	const dir = skill(join(cardDir, "技能"), "卡级正文", true);
	assert.equal(scanSkillFiles(cwd)[0].scope, "card");
	assert.equal(scanSkillFiles(cwd, true).length, 2, "管理面仍可看到被覆盖的全局来源");
	assert.equal(modelVisibleSkillFiles(cwd).length, 0);
	assert.equal(readStageSkill(cwd, "method"), undefined);
	skill(join(cardDir, "技能"), "卡级正文");
	mkdirSync(join(dir, "references")); writeFileSync(join(dir, "references", "scene.md"), "精确\n\t引用");
	assert.equal(JSON.parse(readStageSkill(cwd, "method", "references/scene.md")!).content, "精确\n\t引用");
	writeFileSync(join(cardDir, "outside.md"), "包外文本");
	assert.throws(() => readStageSkill(cwd, "method", "../../outside.md"));
	symlinkSync(cardDir, join(dir, "escape"), "junction");
	assert.throws(() => readStageSkill(cwd, "method", "escape/outside.md"), /超出/);
	saveStageSkill(cwd, { dir: "method", name: "method", description: "写作参考", body: "编辑后的卡级正文" });
	assert.equal(JSON.parse(readStageSkill(cwd, "method")!).content, "编辑后的卡级正文");
	assert.ok(readFileSync(join(cwd, "skills", "method", "SKILL.md"), "utf8").includes("全局正文"));
	saveStageSkill(cwd, { dir: "method", scope: "global", name: "method", description: "写作参考", body: "编辑后的全局正文" });
	assert.equal(JSON.parse(readStageSkill(cwd, "method")!).content, "编辑后的卡级正文");
	assert.ok(readFileSync(join(cwd, "skills", "method", "SKILL.md"), "utf8").includes("编辑后的全局正文"));
});
