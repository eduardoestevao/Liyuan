import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildStagehandInjection,
	buildStagehandPrompt,
	buildStoryFloors,
	formatStoryRead,
	formatStorySearch,
	STORY_COMMANDS,
} from "../src/stagehand.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

test("助手 system prompt：backendControl=false 时不给本机工具段", () => {
	const on = buildStagehandPrompt({ config: { ...DEFAULT_CONFIG, backendControl: true } });
	const off = buildStagehandPrompt({ config: { ...DEFAULT_CONFIG, backendControl: false } });
	assert.ok(on.includes("本机通用工具"));
	assert.ok(!off.includes("本机通用工具"));
});

test("剧情快照注入：模型/占用/独立模型标注", () => {
	const base = {
		sessionId: "abcdef1234567890",
		cardName: "青梧",
		userName: "旅人",
		model: { provider: "deepseek", id: "deepseek-chat" },
		contextPercent: 42.6,
		messageCount: 12,
		streaming: false,
	};
	const s = buildStagehandInjection(base);
	assert.ok(s.includes("【剧情快照】"));
	assert.ok(s.includes("abcdef12"));
	assert.ok(s.includes("deepseek/deepseek-chat"));
	assert.ok(s.includes("43%"));
	assert.ok(!s.includes("你自己运行在"), "跟随模式不标注独立模型");

	const solo = buildStagehandInjection({
		...base,
		streaming: true,
		assistantModel: { provider: "xai", id: "grok-4" },
		assistantFollows: false,
	});
	assert.ok(solo.includes("排队到本轮结束"), "生成中要提示排队语义");
	assert.ok(solo.includes("xai/grok-4"));
});

const msgs = [
	{ role: "custom", customType: "rp-greeting", display: true, content: "【开场 · 青梧】她立在檐下。" },
	{ role: "user", content: "我走近she。" },
	{ role: "assistant", content: [{ type: "text", text: "先查设定" }, { type: "toolCall", id: "t1" }] },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "推演一下走位" },
			{ type: "text", text: "<draft_notes>草稿</draft_notes>\n她抬头，檐水正落。" },
		],
	},
	{ role: "user", content: "//帮我看看配置" },
	{ role: "assistant", content: "已看完配置。" },
	{ role: "user", content: "第二天呢？" },
	{ role: "assistant", content: "翌日晴。" },
];

test("楼层视图：编号与前端一致，场外轮与工具中间轮不占层", () => {
	const floors = buildStoryFloors(msgs);
	assert.deepEqual(
		floors.map((f) => [f.floor, f.kind]),
		[
			[1, "开场白"],
			[2, "用户"],
			[3, "回复"],
			[4, "用户"],
			[5, "回复"],
		],
	);
	// display 视图剥脚手架
	assert.ok(!floors[2].text.includes("draft_notes"));
	assert.ok(floors[2].text.includes("檐水"));
	// raw 视图保留原文与思维链
	const raw = buildStoryFloors(msgs, "raw");
	assert.ok(raw[2].text.includes("<draft_notes>"));
	assert.equal(raw[2].thinking, "推演一下走位");
});

test("story_read：默认取尾部、from/to 区间、超长截断", () => {
	const tail = formatStoryRead(msgs, { last: 2 });
	assert.ok(tail.includes("#4"));
	assert.ok(tail.includes("#5"));
	assert.ok(!tail.includes("#1【"));

	const range = formatStoryRead(msgs, { from: 1, to: 2 });
	assert.ok(range.includes("#1"));
	assert.ok(range.includes("#2"));
	assert.ok(!range.includes("#3【"));

	const clipped = formatStoryRead(
		[{ role: "user", content: `开头${"很长".repeat(400)}结尾` }],
		{ maxChars: 200 },
	);
	assert.ok(clipped.includes("截断"));

	assert.ok(formatStoryRead([]).includes("为空"));
});

test("story_search：命中给楼层与摘录，未命中如实说", () => {
	const hit = formatStorySearch(msgs, "檐水");
	assert.ok(hit.includes("#3"));
	assert.ok(hit.includes("檐水"));
	const miss = formatStorySearch(msgs, "不存在的词");
	assert.ok(miss.includes("未命中"));
});

test("story_command 白名单包含核心剧情命令", () => {
	for (const c of ["reroll", "rewind", "compact"]) {
		assert.ok((STORY_COMMANDS as readonly string[]).includes(c));
	}
});
