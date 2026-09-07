import assert from "node:assert/strict";
import { test } from "node:test";

import { emptyDraftRules } from "../src/draft.ts";
import { defaultState } from "../src/state.ts";
import {
	createWorkspace,
	finalTimeline,
	recordSegment,
	runWriteTool,
	type WorkspaceDeps,
} from "../src/stage/workspace.ts";

const deps = (): WorkspaceDeps => ({
	rules: emptyDraftRules(),
	userName: "凌云",
	charName: "林霜",
});

test("draft_write：收稿落工作区（验收已退役，回执只认收）；空 content 拒收", () => {
	const ws = createWorkspace();
	const d = deps();
	const bad = runWriteTool(ws, d, "draft_write", { version: ws.version, content: "  " });
	assert.equal(bad.ok, false);
	assert.equal(ws.writes, 0);

	const r = runWriteTool(ws, d, "draft_write", { version: ws.version, content: "山门外的雪落了一夜。" });
	assert.equal(r.ok, true);
	assert.equal(ws.draft, "山门外的雪落了一夜。");
	assert.equal(ws.writes, 1);
	assert.equal(ws.version, 1);
	assert.equal(ws.sealed, false, "写入与收笔分离");
});

test("draft_write 门禁：没查过世界（寒暄拍）照常收稿", () => {
	const ws = createWorkspace();
	const r = runWriteTool(ws, deps(), "draft_write", { version: ws.version, content: "山门外的雪落了一夜。" });
	assert.equal(r.ok, true);
	assert.equal(ws.writes, 1);
});

test("draft_write 门禁：writing_guide 不计入 lookups，故读过方法论仍可一次交完", () => {
	// lookups 只认「查世界」；读写作方法论不是遇到了要处理的事
	const ws = createWorkspace();
	assert.equal(ws.lookups, 0, "新工作区从 0 起");
	const r = runWriteTool(ws, deps(), "draft_write", { version: ws.version, content: "山门外的雪落了一夜。" });
	assert.equal(r.ok, true);
});

test("draft_write 门禁：续写到一半改用全量重交不拦（另有 draft_edit 的劝导）", () => {
	const ws = createWorkspace();
	const d = deps();
	ws.lookups = 1;
	runWriteTool(ws, d, "draft_append", { version: 0, content: "第一段。" });
	const r = runWriteTool(ws, d, "draft_write", { version: ws.version, content: "整篇重写过的正文。" });
	assert.equal(r.ok, true, "appends>0 时门禁让路");
	assert.equal(ws.draft, "整篇重写过的正文。");
});

test("draft_write 门禁：internal 代收绕过门禁——兜底路径不能把正文丢掉", () => {
	// 宽进严出：模型直出正文由引擎代收为 draft_write。被门禁拦下就等于这拍白演。
	const ws = createWorkspace();
	ws.lookups = 3;
	const r = runWriteTool(ws, deps(), "draft_write", { version: ws.version, content: "直出的正文。" }, true);
	assert.equal(r.ok, true);
	assert.equal(ws.draft, "直出的正文。");
});

test("finalTimeline：无稿（直出路径）回退单段全文", () => {
	const ws = createWorkspace();
	recordSegment(ws, { kind: "thinking", text: "直接说。" });
	recordSegment(ws, { kind: "text", text: "你好。" });
	const tl = finalTimeline(ws, "你好。");
	const textSegs = tl.filter((s) => s.kind === "text");
	assert.equal(textSegs.length, 1, "直出路径仍是单段");
	assert.equal((textSegs[0] as { text: string }).text, "你好。");
});

test("draft_write：全量替换语义——第二稿覆盖第一稿", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { version: ws.version, content: "第一稿。" });
	runWriteTool(ws, d, "draft_write", { version: ws.version, content: "第二稿。" });
	assert.equal(ws.draft, "第二稿。");
	assert.equal(ws.writes, 2);
});

test("未知写侧工具名：可读文本，不抛", () => {
	const ws = createWorkspace();
	const r = runWriteTool(ws, deps(), "draft_fly", {});
	assert.equal(r.ok, false);
	assert.match(r.text, /未知稿件工具/);
});
