import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { modelVisibleSkillFiles, scanSkillFiles } from "../src/stage/materials.ts";
import { deleteStageSkill, sanitizeSkillDir, saveStageSkill } from "../src/stage/skill-store.ts";

const mkcwd = () => mkdtempSync(join(tmpdir(), "liyuan-skillstore-"));

test("saveStageSkill：新建撞已有同名 skill 报错（不静默吞占）", () => {
	const cwd = mkcwd();
	try {
		saveStageSkill(cwd, { name: "静场", description: "x", resident: false, body: "y" });
		assert.throws(() => saveStageSkill(cwd, { name: "静场", description: "z", resident: false, body: "w" }), /已有同名/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("saveStageSkill：空名/空说明/空正文各自报错（说明为空点名理由）", () => {
	const cwd = mkcwd();
	try {
		assert.throws(() => saveStageSkill(cwd, { name: "  ", description: "d", resident: false, body: "b" }), /名称为空/);
		assert.throws(() => saveStageSkill(cwd, { name: "n", description: " ", resident: false, body: "b" }), /简要说明为空/);
		assert.throws(() => saveStageSkill(cwd, { name: "n", description: "d", resident: false, body: " " }), /正文为空/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("sanitizeSkillDir：拒绝路径穿越/隐藏/非法字符，放行中文", () => {
	assert.equal(sanitizeSkillDir("打斗"), "打斗");
	assert.equal(sanitizeSkillDir("a/b"), null);
	assert.equal(sanitizeSkillDir("..\\x"), null);
	assert.equal(sanitizeSkillDir(".hidden"), null);
	assert.equal(sanitizeSkillDir("na<me>"), null);
});

test("saveStageSkill：description 里的换行被压平（frontmatter 按行解析，换行会截断）", () => {
	const cwd = mkcwd();
	try {
		saveStageSkill(cwd, { name: "多行", description: "第一行\n第二行", resident: false, body: "正文" });
		const raw = readFileSync(join(cwd, "skills", "多行", "SKILL.md"), "utf8");
		const fm = raw.split("---")[1];
		assert.ok(!fm.includes("第二行\n") || fm.includes("第一行 第二行"), "description 单行化");
		assert.equal(scanSkillFiles(cwd)[0].description, "第一行 第二行");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("deleteStageSkill：删整目录；不存在报错；非 skill 目录不误删", () => {
	const cwd = mkcwd();
	try {
		saveStageSkill(cwd, { name: "删我", description: "d", resident: false, body: "b" });
		deleteStageSkill(cwd, "删我");
		assert.equal(scanSkillFiles(cwd).length, 0);
		assert.throws(() => deleteStageSkill(cwd, "删我"), /不存在/);
		mkdirSync(join(cwd, "skills", "非skill"), { recursive: true });
		writeFileSync(join(cwd, "skills", "非skill", "README.md"), "x");
		assert.throws(() => deleteStageSkill(cwd, "非skill"), /不存在/, "无 SKILL.md 的目录不认");
		assert.ok(existsSync(join(cwd, "skills", "非skill")), "非 skill 目录未被删");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("关掉的 skill：编辑器仍列出，送模那一侧整条消失", () => {
	const cwd = mkcwd();
	try {
		saveStageSkill(cwd, { name: "开着", description: "d", body: "b" });
		saveStageSkill(cwd, { name: "关掉", description: "d", body: "b", disabled: true });
		assert.deepEqual(
			scanSkillFiles(cwd)
				.map((s) => s.name)
				.sort(),
			["关掉", "开着"],
			"编辑器看得见全部（看不见就改不动）",
		);
		assert.deepEqual(modelVisibleSkillFiles(cwd).map((s) => s.name), ["开着"]);
		assert.equal(scanSkillFiles(cwd).find((s) => s.name === "关掉")?.disableModelInvocation, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("saveStageSkill：不点名 disabled 时沿用文件现值（改正文不会把用户关掉的开关打开）", () => {
	const cwd = mkcwd();
	try {
		saveStageSkill(cwd, { name: "静场", description: "d", body: "旧正文", disabled: true });
		// agent 的 stage_skill_write 只给 dir/name/description/body，压根不知道有这个键
		saveStageSkill(cwd, { dir: "静场", name: "静场", description: "d", body: "新正文" });
		const after = scanSkillFiles(cwd)[0];
		assert.equal(after.body, "新正文");
		assert.equal(after.disableModelInvocation, true, "开关没被顺手打开");
		// 点名 false 才开回来
		saveStageSkill(cwd, { dir: "静场", name: "静场", description: "d", body: "新正文", disabled: false });
		assert.equal(scanSkillFiles(cwd)[0].disableModelInvocation, undefined);
		assert.equal(modelVisibleSkillFiles(cwd).length, 1);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
