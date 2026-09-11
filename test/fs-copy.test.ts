import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { copyPathSafe } from "../src/fs-copy.ts";

const ROOT = join(".liyuan-artifacts", "fs-copy-test");

test("copyPathSafe：中文目录名/文件名/嵌套树原样复制（node cpSync 的崩溃回归）", () => {
	rmSync(ROOT, { recursive: true, force: true });
	const src = join(ROOT, "源 目录 1.0", "子目录乙");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "文件甲.txt"), "内容甲", "utf8");
	writeFileSync(join(ROOT, "源 目录 1.0", "文件乙.txt"), "内容乙", "utf8");

	copyPathSafe(join(ROOT, "源 目录 1.0"), join(ROOT, "目标 目录 2.0"));
	assert.equal(readFileSync(join(ROOT, "目标 目录 2.0", "子目录乙", "文件甲.txt"), "utf8"), "内容甲");
	assert.equal(readFileSync(join(ROOT, "目标 目录 2.0", "文件乙.txt"), "utf8"), "内容乙");

	// 单文件（跨盘迁移 move 的 EXDEV 回退走这条）
	copyPathSafe(join(ROOT, "源 目录 1.0", "文件乙.txt"), join(ROOT, "新名.txt"));
	assert.equal(readFileSync(join(ROOT, "新名.txt"), "utf8"), "内容乙");
	assert.ok(statSync(join(ROOT, "新名.txt")).isFile());

	rmSync(ROOT, { recursive: true, force: true });
});
