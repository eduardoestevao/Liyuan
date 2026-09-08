import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	applyDeclarations,
	declarationPathFor,
	readDeclaration,
	writeDeclarationFromDetection,
} from "../src/lorebook-declare.ts";
import { loadStageMaterials } from "../src/stage/materials.ts";

const BOOK = {
	name: "测试书",
	entries: [
		{ uid: 1, keys: ["怀瑾"], comment: "人物：怀瑾", content: "北境归来的副使。", enabled: true, constant: false },
		{ uid: 2, keys: [], comment: "变量输出格式", content: "每次回复末尾输出 <UpdateVariable> 与 JSON Patch。", enabled: true, constant: true },
		{ uid: 3, keys: [], comment: "正常蓝灯", content: "世界的基本事实。", enabled: true, constant: true },
	],
};

test("writeDeclarationFromDetection：协议条目落成数据文件，正常条目不进", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-declare-"));
	try {
		const book = join(cwd, "book.json");
		writeFileSync(book, JSON.stringify(BOOK), "utf8");
		const d = writeDeclarationFromDetection(book);
		assert.ok(d, "有协议条目 ⇒ 产出判定");
		assert.equal(d?.entries.length, 1, "只判协议条目");
		assert.equal(d?.entries[0]?.uid, 2);
		assert.equal(d?.entries[0]?.title, "变量输出格式");
		// 文件真实落盘且可读回
		const reread = readDeclaration(book);
		assert.equal(reread?.entries.length, 1, "判定文件读回");
		assert.ok(readFileSync(declarationPathFor(book), "utf8").includes("变量输出格式"), "文件人可读");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("applyDeclarations：命中 uid 停用；无判定文件 ⇒ 不过滤（没有数据就没有动作）", () => {
	const raw = [
		{ uid: 1, keys: ["怀瑾"], comment: "人物：怀瑾", content: "北境归来的副使。", enabled: true, constant: false, secondaryKeys: [], selective: false, order: 0 },
		{ uid: 2, keys: [], comment: "变量输出格式", content: "每次回复末尾输出 <UpdateVariable> 与 JSON Patch。", enabled: true, constant: true, secondaryKeys: [], selective: false, order: 0 },
	] as never;

	// 无判定：协议条目原样通过（刀4 的行为变更——判断归数据，数据缺位不隐形代劳）
	const unfiltered = applyDeclarations(raw, null);
	assert.equal(unfiltered.dropped.length, 0, "无判定文件零过滤");
	assert.equal(unfiltered.entries[1].enabled, true, "协议条目照常在场");

	// 有判定：命中 uid 置停用，其余原样
	const declared = applyDeclarations(raw, {
		version: 1,
		declaredAt: "2026-09-08T00:00:00Z",
		method: "test",
		entries: [{ uid: 2, title: "变量输出格式", chars: 30, family: "mvu", label: "MVU 变量插件", signals: ["tag:UpdateVariable"] }],
	});
	assert.equal(declared.dropped.length, 1, "命中留痕");
	assert.equal(declared.entries[1].enabled, false, "判定条目停用");
	assert.equal(declared.entries[0].enabled, true, "正常条目不动");
});

test("端到端：判定文件在书旁 ⇒ materials 停用该条目；删掉判定 ⇒ 恢复（改判归用户）", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-declare-e2e-"));
	process.env.LIYUAN_CODING_AGENT_DIR = join(cwd, "agentDir");
	try {
		writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: { name: "云澜", first_mes: "你来了。" } }));
		const book = join(cwd, "book.json");
		writeFileSync(book, JSON.stringify(BOOK), "utf8");
		writeFileSync(
			join(cwd, "liyuan.config.json"),
			JSON.stringify({ card: "card.json", lorebooks: ["book.json"], userName: "沈舟" }),
		);
		mkdirSync(join(cwd, "agentDir"), { recursive: true });

		// 判定前：协议条目在场
		const m1 = loadStageMaterials(cwd);
		assert.equal(m1.entries.length, 3, "无判定 ⇒ 3 条全在");

		// 判定：uid2 停用
		writeDeclarationFromDetection(book);
		const m2 = loadStageMaterials(cwd);
		assert.equal(m2.entries.length, 3, "条目数不变（enabled:false 不是删除）");
		assert.equal(m2.entries.find((e) => e.uid === 2)?.enabled, false, "判定条目停用");
		assert.equal(m2.protocolDrops.length, 1, "停用进装配报告");
		assert.equal(m2.protocolDrops[0]?.title, "变量输出格式");

		// 用户改判：删掉判定文件 ⇒ 全部恢复
		rmSync(declarationPathFor(book));
		const m3 = loadStageMaterials(cwd);
		assert.equal(m3.entries.find((e) => e.uid === 2)?.enabled, true, "删判定即恢复");
		assert.equal(m3.protocolDrops.length, 0);
	} finally {
		delete process.env.LIYUAN_CODING_AGENT_DIR;
		rmSync(cwd, { recursive: true, force: true });
	}
});
