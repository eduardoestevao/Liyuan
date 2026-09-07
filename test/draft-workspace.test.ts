import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspace, finalTimeline, recordSegment, restoreDraftVersion, runWriteTool, workspaceToolBlock, type WorkspaceDeps } from "../src/stage/workspace.ts";
import { DraftStore, draftDirectory, listDrafts } from "../src/stage/draft-store.ts";
import { projectToolContext } from "../src/stage/context.ts";
import { applyDraftRevisions, DRAFT_REVISION_TYPE } from "../src/stage/draft-projection.ts";
import { rebuildHistory } from "../src/stage/assemble.ts";
import { workspaceSegments } from "../web/src/draft-view.ts";
import { toWireHistory } from "../server/wire.ts";

const deps: WorkspaceDeps = { rules: {}, charName: "A", userName: "B" };
function sandbox(t: { after(fn: () => void): void }) {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-draft-v3-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const ws = createWorkspace({ sessionId: "session-a", parentId: "user-a" });
	const store = new DraftStore(dir, ws.id);
	store.write(ws);
	return { dir, ws, store, deps: { ...deps, persist: (next) => store.write(next), reload: () => store.read() } satisfies WorkspaceDeps };
}

test("稿件：读写、追加、搜索的版本与原文一致，写入不收笔", (t) => {
	const { ws, store, deps } = sandbox(t);
	assert.equal(runWriteTool(ws, deps, "draft_write", { version: 0, content: "  雨落。\r\n\t她推门。\n" }).ok, true);
	assert.equal(ws.sealed, false);
	assert.equal(runWriteTool(ws, deps, "draft_append", { version: 1, content: "门后无人。", separator: "\n\t" }).ok, true);
	const read = JSON.parse(runWriteTool(ws, deps, "draft_read", {}).text);
	assert.equal(read.content, "  雨落。\r\n\t她推门。\n\n\t门后无人。");
	const found = JSON.parse(runWriteTool(ws, deps, "draft_search", { query: "推门" }).text);
	assert.equal(found.version, 2);
	assert.ok(ws.draft.includes(found.hits[0]));
	assert.ok(found.hits[0].includes("\r\n\t"), "精确引用不压平空白");
	assert.equal(store.read()?.draft, read.content);
	assert.equal(ws.explicitWrites, 2);
	assert.equal(ws.directWrites, 0);
});

test("稿件：缺失/重复/重叠引用和过期版本整批不修改磁盘", (t) => {
	const { ws, store, deps } = sandbox(t);
	runWriteTool(ws, deps, "draft_write", { version: 0, content: "门门门，风起，雨落。" });
	const before = readFileSync(store.file, "utf8");
	for (const edits of [
		[{ old: "风起", new: "风停" }, { old: "雪", new: "霜" }],
		[{ old: "门门", new: "窗" }],
		[{ old: "风起，雨", new: "雪" }, { old: "雨落", new: "霜降" }],
	]) {
		assert.equal(runWriteTool(ws, deps, "draft_edit", { version: 1, edits }).isError, true);
		assert.equal(readFileSync(store.file, "utf8"), before);
		assert.equal(ws.version, 1);
	}
	assert.equal(runWriteTool(ws, deps, "draft_append", { version: 0, content: "旧版本续写" }).isError, true);
	assert.equal(readFileSync(store.file, "utf8"), before);
});

test("稿件：放宽标点匹配有回执，修改后时间线仍按事件顺序且逐字相同", (t) => {
	const { ws, deps } = sandbox(t);
	runWriteTool(ws, deps, "draft_write", { version: 0, content: "她说：“留下。”" });
	recordSegment(ws, { kind: "tool", activity: { kind: "tool_start", name: "ask" } });
	runWriteTool(ws, deps, "draft_append", { version: 1, content: "他停住。" });
	const result = runWriteTool(ws, deps, "draft_edit", { version: 2, edits: [{ old: '她说："留下。"', new: "她说：“请进。”" }] });
	assert.equal(result.ok, true);
	assert.match(result.text, /标点归一/);
	assert.deepEqual(ws.timeline.map((s) => s.kind), ["text", "tool", "text"]);
	assert.equal(finalTimeline(ws, ws.draft).filter((s) => s.kind === "text").map((s) => s.text).join(""), ws.draft);
});

test("稿件：外部变更被拒绝，重新读取后可继续；用户恢复增加版本", (t) => {
	const { ws, store, deps, dir } = sandbox(t);
	runWriteTool(ws, deps, "draft_write", { version: 0, content: "一稿" });
	const original = readFileSync(store.file, "utf8");
	writeFileSync(store.file, original + "\n");
	assert.equal(runWriteTool(ws, deps, "draft_edit", { version: 1, edits: [{ old: "一稿", new: "二稿" }] }).isError, true);
	assert.equal(ws.draft, "一稿");
	runWriteTool(ws, deps, "draft_read", {});
	assert.equal(runWriteTool(ws, deps, "draft_write", { version: 1, content: "二稿" }).ok, true);
	restoreDraftVersion(ws, deps, 1, 2);
	assert.equal(ws.version, 3);
	assert.equal(ws.draft, "一稿");
	assert.equal(new DraftStore(dir, ws.id).read()?.revisions.length, 3);
	assert.throws(() => restoreDraftVersion(ws, deps, 2, 2), /版本已变/);
});

test("计划与探索：明确切换、读侧可用、取消步骤不阻止收笔", () => {
	const ws = createWorkspace();
	runWriteTool(ws, deps, "beat_plan", { mode: "explore", steps: [{ id: "a", text: "查旧事" }, { id: "b", text: "到城门" }] });
	assert.ok(workspaceToolBlock(ws, "panel_write", "write"));
	assert.ok(workspaceToolBlock(ws, "mcp_unknown", undefined));
	assert.equal(workspaceToolBlock(ws, "lorebook_read", "read"), undefined);
	assert.equal(runWriteTool(ws, deps, "draft_write", { version: 0, content: "不该写" }).ok, false);
	runWriteTool(ws, deps, "beat_plan", { mode: "write", steps: [{ id: "a", text: "查旧事", status: "done" }, { id: "b", text: "到城门", status: "cancelled" }] });
	runWriteTool(ws, deps, "draft_write", { version: 0, content: "他改变了主意。" });
	assert.equal(runWriteTool(ws, deps, "draft_seal", { version: 1 }).ok, true);
	assert.equal(ws.phase, "sealed");
	assert.equal(runWriteTool(ws, deps, "draft_append", { version: 1, content: "多写" }).ok, false);
});

test("稿件存储：会话与拍隔离，重启可读历史；非法标识不能越界", (t) => {
	const { dir, ws } = sandbox(t);
	const one = draftDirectory(dir, join(dir, "对话", "局", "会话"), "session-a");
	const two = draftDirectory(dir, join(dir, "对话", "局", "会话"), "session-b");
	assert.notEqual(one, two);
	const second = createWorkspace({ sessionId: "session-a", parentId: ws.parentId });
	new DraftStore(dir, second.id).write(second);
	assert.equal(listDrafts(dir).length, 2);
	assert.throws(() => new DraftStore(dir, "../escape"));
});

test("上下文剪枝：保留调用配对与用户选择，不修改原历史", () => {
	const messages = [
		{ role: "user", content: "留下" },
		{ role: "toolResult", toolName: "world_state_get", toolCallId: "1", content: [{ type: "text", text: "账本".repeat(60) }] },
		{ role: "toolResult", toolName: "ask", toolCallId: "2", content: [{ type: "text", text: "用户选择留下" }] },
		{ role: "toolResult", toolName: "world_state_get", toolCallId: "3", content: [{ type: "text", text: "账本".repeat(60) }] },
	];
	const original = structuredClone(messages), result = projectToolContext(messages);
	assert.deepEqual(messages, original);
	assert.equal(result.stats.prunedResults, 1);
	assert.ok(result.stats.prunedChars > 0);
	assert.deepEqual(result.messages[2], messages[2]);
	assert.equal((result.messages[1] as any).toolCallId, "1");
});

test("用户恢复：显示与送模使用同一追加式修订，其他分支不受影响", () => {
	const base = [{ id: "u", type: "message", message: { role: "user", content: "继续" } }, { id: "a", type: "message", message: { role: "assistant", content: [{ type: "text", text: "第二稿" }] } }];
	const revised = [...base, { id: "r", type: "custom", customType: DRAFT_REVISION_TYPE, data: { targetId: "a", text: "第一稿", draftId: "d", version: 3 } }];
	assert.equal(rebuildHistory(revised).history.at(-1)?.text, "第一稿");
	assert.equal(toWireHistory(applyDraftRevisions(revised).filter((e) => e.type === "message").map((e) => e.message), { charName: "A", userName: "B" }).at(-1)?.text, "第一稿");
	assert.equal(rebuildHistory(base).history.at(-1)?.text, "第二稿");
});

test("流式稿件：刷新恢复预览，失效的参数预览不会覆盖新版本", () => {
	const ws = createWorkspace();
	runWriteTool(ws, deps, "draft_write", { version: 0, content: "上文" });
	ws.preview = { name: "draft_append", content: "半段", separator: "\n\t", version: 1 };
	assert.equal(workspaceSegments(ws).filter((s) => s.kind === "text").map((s) => s.text).join(""), "上文\n\t半段");
	ws.preview.version = 0;
	assert.equal(workspaceSegments(ws).filter((s) => s.kind === "text").map((s) => s.text).join(""), "上文");
});
