import assert from "node:assert/strict";
import { test } from "node:test";
import { authoringHistory, conversationMode, displayConversationBranch, storyBranch, CONVERSATION_MODE_TYPE, CONVERSATION_PROCESS_TYPE } from "../src/conversation-mode.ts";
import { rebuildHistory, stateFromBranch, type BranchEntryLike } from "../src/stage/assemble.ts";
import { planCompaction, serializeForSummary } from "../src/stage/compact.ts";
import { previousReply } from "../src/stage/previous-draft.ts";
import { toWireHistory } from "../server/wire.ts";
import { listReplyVariants } from "../src/swipe.ts";

const msg = (id: string, role: string, text: string, mode?: string): BranchEntryLike => ({ id, type: "message", message: { role, content: text, ...(mode ? { details: { liyuanMode: mode } } : {}) } });
const mode = (id: string, value: string, requestId?: string): BranchEntryLike => ({ id, type: "custom", customType: CONVERSATION_MODE_TYPE, data: { mode: value, requestId } });
const raw = (id: string, requestId: string, message: unknown): BranchEntryLike => ({ id, type: "custom", customType: CONVERSATION_PROCESS_TYPE, data: { requestId, mode: "authoring", message } });

test("两种可见视图：自动切入追溯标记触发请求，回到扮演不会重新开放它", () => {
	const branch = [msg("u1", "user", "去山门。"), msg("a1", "assistant", "她点头。"),
		{ id: "s1", type: "custom", customType: "rp-state", data: { location: "山门" } },
		msg("u2", "user", "AUTHOR_REQUEST：修复前端"), raw("r1", "u2", { role: "assistant", content: "<code>完整代码</code>" }),
		mode("m1", "authoring", "u2"), msg("a2", "assistant", "AUTHOR_REPLY", "authoring"),
		{ id: "s2", type: "custom", customType: "rp-state", data: { location: "调试场景" } },
		mode("m2", "roleplay", "u2")];
	const before = JSON.stringify(branch);
	assert.equal(conversationMode(branch), "roleplay");
	assert.deepEqual(rebuildHistory(branch).history.map(m => m.text), ["去山门。", "她点头。"]);
	assert.equal(stateFromBranch(branch).location, "山门");
	assert.equal(previousReply(branch)?.entryId, "a1");
	assert.doesNotMatch(serializeForSummary(branch, "我", "她"), /AUTHOR_|调试|code/);
	assert.match(JSON.stringify(authoringHistory(branch)), /AUTHOR_REQUEST/);
	assert.match(JSON.stringify(authoringHistory(branch)), /<code>完整代码<\/code>/);
	assert.equal(JSON.stringify(branch), before, "可见性投影不修改原始记录");
	const continued = [...branch, msg("u3", "user", "推门进去。"), msg("a3", "assistant", "门缓缓打开。")];
	assert.deepEqual(rebuildHistory(continued).history.map(m => m.text), ["去山门。", "她点头。", "推门进去。", "门缓缓打开。"]);
	assert.deepEqual(storyBranch(storyBranch(continued)), storyBranch(continued));
});

test("压缩按剧情拍数切割；很多维护讨论不会触发剧情摘要或挤走最近剧情", () => {
	const branch = [msg("u0", "user", "剧情开始"), msg("a0", "assistant", "山门旁的故事。".repeat(100))];
	for (let i = 0; i < 20; i++) branch.push(msg(`w${i}`, "user", "WORK_QUERY".repeat(100), "authoring"), msg(`x${i}`, "assistant", "WORK_REPORT".repeat(100), "authoring"));
	assert.equal(planCompaction(branch, { userName: "我", charName: "她", everyNTurns: 2, keepRecentBeats: 1, minChars: 1 }), null);
	branch.push(msg("u1", "user", "再走一步"), msg("a1", "assistant", "她跟上。"), msg("u2", "user", "再走一步"), msg("a2", "assistant", "她望向门内。"));
	const plan = planCompaction(branch, { userName: "我", charName: "她", everyNTurns: 2, keepRecentBeats: 1, minChars: 1 })!;
	assert.equal(plan.turns, 2);
	assert.equal(plan.coversThroughId, "a1");
	assert.doesNotMatch(plan.conversationText, /WORK_/);
	assert.ok(!plan.covered.some(e => e.id?.startsWith("w") || e.id?.startsWith("x")));
});

test("原始上下文保留调用参数、失败回执和原始标记；媒体展示副本不重复回放", () => {
	const call = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { content: "<thinking>CODE</thinking>" } }] };
	const result = { role: "toolResult", toolCallId: "c1", toolName: "write", content: [{ type: "text", text: "syntax error" }], isError: true };
	const branch = [msg("u", "user", "修复代码", "authoring"), raw("r1", "u", call), raw("r2", "u", result),
		{ id: "media", type: "message", message: result }, mode("m", "roleplay", "u")];
	const history = authoringHistory(branch);
	assert.equal(history.filter(m => m.role === "toolResult").length, 1);
	assert.deepEqual(history[1], call);
	assert.deepEqual(history[2], result);
	assert.equal(rebuildHistory(branch).history.length, 0);
});

test("显示保持维护请求和代码原文，不应用卡皮肤，也不计入剧情深度", () => {
	const branch = [msg("u", "user", "剧情输入"), msg("a", "assistant", "BODY"), msg("w", "user", "编辑界面"), mode("m", "authoring", "w"), msg("x", "assistant", "<div>BODY</div>", "authoring")];
	const view = displayConversationBranch(branch).filter(e => e.type === "message").map(e => e.message);
	const wire = toWireHistory(view, { userName: "我", charName: "她" }, { skin: { charName: "她", userName: "我", rules: [{ name: "只改最新剧情", source: "BODY", flags: "g", replace: "SKIN", minDepth: 0, maxDepth: 0 }] } });
	assert.equal(wire[1].text, "SKIN", "维护消息不增加作者正则的剧情深度");
	assert.equal(wire[2].mode, "authoring");
	assert.equal(wire[3].channel, "authoring");
	assert.equal(wire[3].text, "<div>BODY</div>");
});

test("回复变体跨过持久化过程节点；分支里没有最终回复时不制造假变体", () => {
	const entries = [
		{ id: "u", parentId: null, type: "message", role: "user" },
		{ id: "p1", parentId: "u", type: "custom", customType: CONVERSATION_PROCESS_TYPE },
		{ id: "panels", parentId: "p1", type: "custom", customType: "rp-panels" },
		{ id: "p2", parentId: "panels", type: "custom", customType: CONVERSATION_PROCESS_TYPE },
		{ id: "a", parentId: "p2", type: "message", role: "assistant" },
		{ id: "empty", parentId: "u", type: "custom", customType: CONVERSATION_PROCESS_TYPE },
		{ id: "later-user", parentId: "empty", type: "message", role: "user" },
		{ id: "later-reply", parentId: "later-user", type: "message", role: "assistant" },
		{ id: "legacy", parentId: "u", type: "message", role: "assistant" },
	];
	const variants = listReplyVariants(entries, "u", "a");
	assert.equal(variants.length, 2);
	assert.ok(variants.some(v => v.rootId === "p1" && v.leafId === "a"));
});
