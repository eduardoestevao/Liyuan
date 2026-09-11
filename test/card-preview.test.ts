import assert from "node:assert/strict";
import test from "node:test";
import { buildCardPreviewRequest, CardPreviewHub, summarizeCardPreview, type CardPreviewRequest } from "../server/card-preview.ts";
import type { CardProjectPreview } from "../src/card-authoring-types.ts";

const data = (): CardProjectPreview => ({
	build: { hash: "h", base: "b", changed: ["x"], errors: [], checkedScripts: [], checkedPatterns: [], added: [], removed: [], meta: [], cover: false, stale: [] },
	front: { charName: "角", userName: "你", rules: [], scripts: [] } as unknown as CardProjectPreview["front"],
	greetings: ["第一条", "第二条"], variables: { hp: 1 },
});

test("预览请求：默认第一条开场与卡内初值，greeting/message/variables/wait 可覆盖并夹在合理范围", () => {
	const r = buildCardPreviewRequest("p1", data(), {});
	assert.equal(r.message, "第一条");
	assert.deepEqual(r.variables, { hp: 1 });
	assert.equal(r.wait, 3000);
	const custom = buildCardPreviewRequest("p2", data(), { greeting: 1, variables: { hp: 9 }, wait: 99999 });
	assert.equal(custom.message, "第二条");
	assert.deepEqual(custom.variables, { hp: 9 });
	assert.equal(custom.wait, 15000);
	assert.equal(buildCardPreviewRequest("p3", data(), { message: "自定义", wait: 1 }).message, "自定义");
	assert.equal(buildCardPreviewRequest("p3", data(), { wait: 1 }).wait, 500);
});

test("回执归并：错误/警告/交互分列，DOM 摘要按帧来源；ok 只在就绪且零错误时", () => {
	const request = buildCardPreviewRequest("p", data(), {});
	const good = summarizeCardPreview(request, { id: "p", ready: true, events: [
		{ level: "ready", source: "预览", message: "已加载" },
		{ level: "dom", source: "消息 1", message: JSON.stringify({ text: "状态栏 HP 1", elements: 12, tags: { div: 5 }, images: 1, brokenImages: 0, height: 240 }) },
		{ level: "dom", source: "消息 1", message: JSON.stringify({ text: "状态栏 HP 1（更新）", elements: 13, tags: { div: 6 }, images: 1, brokenImages: 0, height: 250 }) },
		{ level: "warning", source: "消息 1", message: "预览限制：connect-src https://x" },
		{ level: "action", source: "交互", message: "/run" },
	] });
	assert.equal(good.ok, true);
	assert.equal(good.frames.length, 1, "同一帧只留最后一次摘要");
	assert.equal(good.frames[0].elements, 13);
	assert.deepEqual(good.warnings, ["消息 1：预览限制：connect-src https://x"]);
	assert.deepEqual(good.actions, ["交互：/run"]);
	const bad = summarizeCardPreview(request, { id: "p", ready: true, events: [{ level: "error", source: "页面脚本", message: "x is not defined" }] });
	assert.equal(bad.ok, false);
	assert.deepEqual(bad.errors, ["页面脚本：x is not defined"]);
	const none = summarizeCardPreview(request, null);
	assert.equal(none.ready, false);
	assert.ok(none.note);
});

test("挂起表：没有页面立刻返回说明；有页面等第一份回报；超时收敛；重复回报被拒", async () => {
	let listeners = 0;
	let sent: CardPreviewRequest | null = null;
	const hub = new CardPreviewHub((r) => { sent = r; return listeners; });
	const request = buildCardPreviewRequest(hub.nextId(), data(), { wait: 500 });
	const offline = await hub.run(request);
	assert.match(offline.note ?? "", /没有连接的页面/);
	listeners = 1;
	const pending = hub.run(request, 5000);
	assert.equal(hub.pending().length, 1);
	assert.equal(sent!.id, request.id);
	assert.equal(hub.settle({ id: request.id, ready: true, events: [] }), true);
	assert.equal(hub.settle({ id: request.id, ready: true, events: [] }), false, "重复回报");
	assert.equal((await pending).ready, true);
	const late = await hub.run(buildCardPreviewRequest(hub.nextId(), data(), { wait: 500 }), 20);
	assert.equal(late.ready, false);
	assert.equal(hub.pending().length, 0);
});
