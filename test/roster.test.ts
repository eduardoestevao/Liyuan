import assert from "node:assert/strict";
import { test } from "node:test";

import { applyPatch, defaultState } from "../src/state.ts";

test("名录不删：活跃状态里移除后名录仍在案", () => {
	const r1 = applyPatch(defaultState(), {
		characters: { 苏茜: { status: "在场" } },
		inventory: ["铁剑"],
		plot_threads: ["旧约"],
	});
	const r2 = applyPatch(r1.state, { characters: { 苏茜: null }, inventory: [], plot_threads: [] });
	assert.equal(Object.keys(r2.state.characters).length, 0);
	assert.ok("苏茜" in (r2.state.roster?.characters ?? {}));
	assert.ok("铁剑" in (r2.state.roster?.items ?? {}));
	assert.ok("旧约" in (r2.state.roster?.events ?? {}));
});

test("名录容量：剧情线超上限丢最旧", () => {
	let s = defaultState();
	for (let i = 0; i < 70; i++) {
		s = applyPatch(s, { plot_threads: [`线索${i}`] }).state;
	}
	const events = Object.keys(s.roster?.events ?? {});
	assert.equal(events.length, 60);
	assert.ok(!events.includes("线索0"));
	assert.ok(events.includes("线索69"));
});

test("名录一句话超长截断", () => {
	const r = applyPatch(defaultState(), { characters: { 龙王: { status: "一".repeat(80) } } });
	assert.ok((r.state.roster?.characters["龙王"] ?? "").length <= 30);
});

test("名录编辑：离场条目可删；活跃条目删了被登记复活", () => {
	const r1 = applyPatch(defaultState(), { characters: { 苏茜: { status: "在场" }, 老周: { status: "在场" } } });
	const r2 = applyPatch(r1.state, { characters: { 苏茜: null } });
	// 离场的苏茜：删除生效
	const r3 = applyPatch(r2.state, { roster: { characters: { 苏茜: null } } });
	assert.ok(!("苏茜" in (r3.state.roster?.characters ?? {})));
	assert.ok(r3.applied.some((a) => a.includes("roster.characters.苏茜 已移除")));
	// 在场的老周：删除后被 registerRoster 立即重新登记
	const r4 = applyPatch(r3.state, { roster: { characters: { 老周: null } } });
	assert.ok("老周" in (r4.state.roster?.characters ?? {}));
});

test("名录编辑：改一句话（60 字截断）；非法值告警忽略", () => {
	const r1 = applyPatch(defaultState(), { characters: { 苏茜: { status: "初登场" } } });
	const r2 = applyPatch(r1.state, { roster: { characters: { 苏茜: "三年前的旧识" } } });
	assert.equal(r2.state.roster?.characters["苏茜"], "三年前的旧识");
	const r3 = applyPatch(r2.state, { roster: { characters: { 苏茜: "长".repeat(90) } } });
	assert.equal((r3.state.roster?.characters["苏茜"] ?? "").length, 60);
	const r4 = applyPatch(r3.state, { roster: { characters: { 苏茜: 42 } } });
	assert.ok(r4.warnings.some((w) => w.includes("需要字符串或 null")));
});

test("名录编辑：roster 非对象/子表非对象告警忽略", () => {
	const r1 = applyPatch(defaultState(), { roster: "bad" });
	assert.ok(r1.warnings.some((w) => w.includes("roster 需要对象")));
	const r2 = applyPatch(defaultState(), { roster: { items: ["x"] } });
	assert.ok(r2.warnings.some((w) => w.includes("roster.items 需要对象")));
});
