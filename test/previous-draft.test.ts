import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PreviousDraftEditor, previousReply } from "../src/stage/previous-draft.ts";
import { applyDraftRevisions, DRAFT_REVISION_TYPE, type DraftBranchEntry } from "../src/stage/draft-projection.ts";
import { DraftStore } from "../src/stage/draft-store.ts";
import { createWorkspace, runWriteTool, type WorkspaceDeps } from "../src/stage/workspace.ts";
import { rebuildHistory } from "../src/stage/assemble.ts";
import { planCompaction } from "../src/stage/compact.ts";
import { toWireHistory } from "../server/wire.ts";

const deps: WorkspaceDeps = { rules: {}, userName: "甲", charName: "乙" };
function fixture(t: { after(fn: () => void): void }, text = "她说：‘请坐。’\r\n\t灯亮着。\n\n后半段完整保留，含 $& 和 🙂。") {
	const directory = mkdtempSync(join(tmpdir(), "liyuan-previous-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const original = createWorkspace({ sessionId: "session", parentId: null, userId: "u1" });
	runWriteTool(original, deps, "draft_write", { version: 0, content: text });
	runWriteTool(original, deps, "draft_seal", { version: 1 });
	original.entryId = "a1";
	const sourceStore = new DraftStore(directory, original.id);
	sourceStore.write(original);
	const branch: DraftBranchEntry[] = [
		{ id: "u1", type: "message", message: { role: "user", content: "进屋。" } },
		{ id: "a1", type: "message", message: { role: "assistant", content: text, details: { rpTimeline: original.timeline, rpDraft: { id: original.id, version: 1, phase: "sealed" } } } },
		{ id: "state", type: "custom", customType: "rp-state", data: { time: "夜晚" } },
		{ id: "request", type: "message", message: { role: "user", content: "只改上一拍的台词。" } },
	];
	const ws = createWorkspace({ sessionId: "session", parentId: "state", userId: "request" });
	const store = new DraftStore(directory, ws.id); store.write(ws);
	const editor = new PreviousDraftEditor(() => branch, directory);
	const currentDeps = { ...deps, persist: (next) => store.write(next) } satisfies WorkspaceDeps;
	return { directory, original, sourceStore, branch, ws, store, editor, currentDeps };
}

test("上一拍：唯一引用整批修订，未引用的后半段与格式逐字保留，共享源稿不被覆盖", (t) => {
	const f = fixture(t);
	const source = readFileSync(f.sourceStore.file, "utf8");
	const read = f.editor.run(f.ws, f.currentDeps, "previous_draft_read", {});
	assert.equal(JSON.parse(read.text).content, f.original.draft);
	const result = f.editor.run(f.ws, f.currentDeps, "previous_draft_edit", { version: 1, edits: [{ old: "请坐。", new: "来，坐这儿吧。" }] });
	assert.equal(result.ok, true);
	assert.equal(f.ws.draft, f.original.draft.replace("请坐。", "来，坐这儿吧。"));
	assert.equal(f.ws.entryId, "a1");
	assert.equal(f.ws.revision?.requestId, "request");
	assert.equal(f.ws.version, 2);
	assert.equal(f.ws.phase, "sealed");
	assert.equal(f.ws.restorePending, true);
	assert.equal(f.ws.revisions[0].text, f.original.draft);
	assert.equal(f.ws.timeline.filter((s) => s.kind === "text").map((s) => s.text).join(""), f.ws.draft);
	assert.equal(f.store.read()?.draft, f.ws.draft);
	assert.equal(readFileSync(f.sourceStore.file, "utf8"), source);
});

test("上一拍：未读、过期版本、重复/重叠/缺失引用和清空正文均不写入", (t) => {
	const f = fixture(t, "雨雨雨，窗外有风，桌上有灯。");
	const before = readFileSync(f.store.file, "utf8");
	assert.equal(f.editor.run(f.ws, f.currentDeps, "previous_draft_edit", { version: 1, edits: [{ old: "有风", new: "无风" }] }).isError, true);
	f.editor.run(f.ws, f.currentDeps, "previous_draft_read", {});
	for (const args of [
		{ version: 0, edits: [{ old: "有风", new: "无风" }] },
		{ version: 1, edits: [{ old: "有风", new: "无风" }, { old: "不存在", new: "" }] },
		{ version: 1, edits: [{ old: "雨雨", new: "雪" }] },
		{ version: 1, edits: [{ old: "窗外有风", new: "静" }, { old: "有风", new: "无风" }] },
		{ version: 1, edits: [{ old: f.original.draft, new: "" }] },
	]) {
		assert.equal(f.editor.run(f.ws, f.currentDeps, "previous_draft_edit", args).isError, true);
		assert.equal(readFileSync(f.store.file, "utf8"), before);
	}
});

test("上一拍：读取后源稿变化、出现下一拍或离开请求所在分支时拒绝落笔", (t) => {
	for (const change of ["source", "next", "branch"]) {
		const f = fixture(t);
		f.editor.run(f.ws, f.currentDeps, "previous_draft_read", {});
		const before = readFileSync(f.store.file, "utf8");
		if (change === "source") f.sourceStore.write({ ...f.original, version: 2, draft: "外部修订。" });
		if (change === "next") f.branch.push({ id: "a2", type: "message", message: { role: "assistant", content: "另一拍。" } });
		if (change === "branch") f.branch.pop();
		assert.equal(f.editor.run(f.ws, f.currentDeps, "previous_draft_edit", { version: 1, edits: [{ old: "请坐。", new: "坐吧。" }] }).isError, true);
		assert.equal(readFileSync(f.store.file, "utf8"), before);
	}
});

test("上一拍：旧回复没有稿件文件仍可回改；停止稿、开场白及更早拍不能冒充上一拍", (t) => {
	const f = fixture(t);
	f.branch[1].message = { role: "assistant", content: "旧回复的前半。\n\n完整后半。" };
	assert.equal(f.editor.run(f.ws, f.currentDeps, "previous_draft_read", {}).ok, true);
	assert.equal(f.editor.run(f.ws, f.currentDeps, "previous_draft_edit", { version: 1, edits: [{ old: "前半", new: "上半" }] }).ok, true);
	assert.equal(f.ws.draft, "旧回复的上半。\n\n完整后半。");
	assert.equal(f.ws.revisions[0].text, "旧回复的前半。\n\n完整后半。");
	const stopped = fixture(t);
	(stopped.branch[1].message as any).details.rpDraft.phase = "stopped";
	assert.equal(stopped.editor.run(stopped.ws, stopped.currentDeps, "previous_draft_read", {}).isError, true);
	assert.equal(previousReply([{ id: "g", type: "custom_message", customType: "rp-greeting", content: "开场。" }]), undefined);
	const later = fixture(t);
	later.branch.unshift({ id: "old", type: "message", message: { role: "assistant", content: "仅在更早拍出现。" } });
	later.editor.run(later.ws, later.currentDeps, "previous_draft_read", {});
	assert.equal(later.editor.run(later.ws, later.currentDeps, "previous_draft_edit", { version: 1, edits: [{ old: "仅在更早拍出现。", new: "不许修改" }] }).isError, true);
});

test("修订投影：旧追加补丁只应用一次，改稿请求留在显示历史并退出剧情上下文", () => {
	const base = [
		{ id: "u", type: "message", message: { role: "user", content: "原始输入。" } },
		{ id: "a", type: "message", message: { role: "assistant", content: "前半。" } },
		{ id: "patch", type: "custom_message", customType: "rp-draft-op", content: JSON.stringify({ append: "后半。" }) },
		{ id: "edit", type: "message", message: { role: "user", content: "请求改稿。" } },
	];
	assert.equal(previousReply(base)?.text, "前半。\n\n后半。");
	const revised = [...base, { id: "r", type: "custom", customType: DRAFT_REVISION_TYPE, data: { targetId: "a", requestId: "edit", text: "修改的前半。\n\n后半。", version: 2 } }];
	const projected = applyDraftRevisions(revised);
	const wire = toWireHistory(projected.filter((e) => e.type === "message").map((e) => e.message), { charName: "乙", userName: "甲" });
	assert.equal(wire.find((m) => m.channel === "narrative")?.text, "修改的前半。\n\n后半。");
	assert.equal(wire.at(-1)?.text, "请求改稿。");
	assert.deepEqual(rebuildHistory(revised).history.map((m) => m.text), ["原始输入。", "修改的前半。\n\n后半。"]);
	assert.equal(rebuildHistory(base).history.at(-2)?.text, "前半。\n\n后半。");
	assert.equal(rebuildHistory(projected).history.at(-1)?.text, "修改的前半。\n\n后半。");
});

test("修订投影：压缩按剧情拍计数，较晚的修订回执也覆盖待摘要原文", () => {
	const branch: DraftBranchEntry[] = [];
	for (let i = 1; i <= 3; i++) {
		branch.push({ id: `u${i}`, type: "message", message: { role: "user", content: `输入${i}` } });
		branch.push({ id: `a${i}`, type: "message", message: { role: "assistant", content: `正文${i}` } });
	}
	for (let i = 0; i < 4; i++) {
		branch.push({ id: `e${i}`, type: "message", message: { role: "user", content: "不要计入剧情拍。" } });
		branch.push({ id: `r${i}`, type: "custom", customType: DRAFT_REVISION_TYPE, data: { targetId: "a3", requestId: `e${i}`, text: `修后正文${i}` } });
	}
	assert.equal(planCompaction(branch as any, { everyNTurns: 2, keepRecentBeats: 2, minChars: 0, userName: "甲", charName: "乙" }), null);
	branch.push({ id: "u4", type: "message", message: { role: "user", content: "输入4" } });
	branch.push({ id: "a4", type: "message", message: { role: "assistant", content: "正文4" } });
	const plan = planCompaction(branch as any, { everyNTurns: 1, keepRecentBeats: 1, minChars: 0, userName: "甲", charName: "乙" })!;
	assert.equal(plan.turns, 3);
	assert.ok(plan.conversationText.includes("修后正文3"));
	assert.ok(!plan.conversationText.includes("不要计入剧情拍"));
});

test("历史：保留 ask 的真实用户回答，兼容旧拍的自有回执，不把回答误当工具噪音", () => {
	const answer = "我改主意，先回档案室；引号「也原样保留」。";
	const branch: DraftBranchEntry[] = [
		{ id: "u", type: "message", message: { role: "user", content: "先听两个走法，再由我决定。" } },
		{ id: "a", type: "message", message: { role: "assistant", content: "她说完两条路，等你改了主意，便陪你回档案室。" } },
		{ id: "debug", parentId: "a", type: "custom", customType: "rp-text-debug", data: { beatLog: [
			{ ev: "tool_call", data: 'ask: {"question":"走哪条路？","options":["渡船","石桥"]}' },
			{ ev: "tool_result", data: `ask: 用户已作答：「${answer}」。当前稿件版本 v1。` },
		] } },
		{ id: "now", type: "message", message: { role: "user", content: "只改第一句。" } },
	];
	const raw = JSON.stringify(branch);
	const history = rebuildHistory(branch as any).history;
	assert.equal(history[0].text, `先听两个走法，再由我决定。\n\n${answer}`);
	assert.equal(history.at(-1)?.text, "只改第一句。");
	assert.deepEqual(previousReply(branch)?.choices, [{ question: "走哪条路？", answer }]);
	assert.equal(JSON.stringify(branch), raw, "原始用户消息与历史文件不改写");
	const unrelated = structuredClone(branch); unrelated[2].parentId = "another-branch";
	assert.equal(rebuildHistory(unrelated as any).history[0].text, "先听两个走法，再由我决定。");
	const withModernReceipt = structuredClone(branch);
	(withModernReceipt[1].message as any).details = { rpChoices: [{ question: "下一步？", answer: "留在原地。" }] };
	assert.equal(rebuildHistory(withModernReceipt as any).history[0].text, "先听两个走法，再由我决定。\n\n留在原地。");
});
