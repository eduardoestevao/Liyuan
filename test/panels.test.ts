import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	activePanels,
	closePanel,
	fillPanelTemplate,
	formatPanelIndex,
	formatPanelSnapshot,
	loadPanels,
	PANEL_MAX_CHARS,
	PANEL_SOFT_LIMIT,
	savePanels,
	writePanel,
	type PanelMap,
} from "../src/panels.ts";

test("writePanel：新建/更新/同名重开归档面板", () => {
	let r = writePanel({}, { name: "地图", kind: "svg", content: "<svg viewBox='0 0 10 10'/>" });
	assert.ok(r.ok && r.created && !r.reopened && r.activeCount === 1);
	let panels = r.ok ? r.panels : {};

	r = writePanel(panels, { name: "地图", kind: "svg", content: "<svg viewBox='0 0 20 20'/>" });
	assert.ok(r.ok && !r.created && !r.reopened, "同名写入是更新不是新建");
	panels = r.ok ? r.panels : {};
	assert.ok(panels["地图"].content.includes("20 20"), "内容整体替换");

	const closed = closePanel(panels, "地图");
	assert.ok(closed.ok);
	panels = closed.ok ? closed.panels : {};
	assert.equal(activePanels(panels).length, 0, "归档后不在活跃列表");

	r = writePanel(panels, { name: "地图", kind: "markdown", content: "# 新地图" });
	assert.ok(r.ok && r.reopened, "同名重写唤回归档面板");
	panels = r.ok ? r.panels : {};
	assert.equal(panels["地图"].archived, undefined, "重写后归档标记清除");
	assert.equal(panels["地图"].kind, "markdown", "kind 可随重写改变");
});

test("writePanel：校验（空名/非法 kind/空内容/超长）", () => {
	assert.ok(!writePanel({}, { name: "  ", kind: "markdown", content: "x" }).ok);
	assert.ok(!writePanel({}, { name: "a", kind: "iframe", content: "x" }).ok, "非法 kind 拒绝");
	assert.ok(!writePanel({}, { name: "a", kind: "markdown", content: "  " }).ok, "空内容拒绝（收起走 panel_close）");
	assert.ok(!writePanel({}, { name: "a", kind: "markdown", content: "x".repeat(PANEL_MAX_CHARS + 1) }).ok);
});

test("writePanel：软上限只提醒不硬拦", () => {
	let panels: PanelMap = {};
	for (let i = 1; i <= PANEL_SOFT_LIMIT; i++) {
		const r = writePanel(panels, { name: `面板${i}`, kind: "markdown", content: "x" });
		assert.ok(r.ok && !r.overLimit, `第 ${i} 个不超限`);
		panels = r.panels;
	}
	const over = writePanel(panels, { name: "再来一个", kind: "markdown", content: "x" });
	assert.ok(over.ok, "超限仍写入成功（软上限是纪律不是门禁）");
	assert.ok(over.ok && over.overLimit, "但带超限标记");
});

test("closePanel：不存在/重复归档报错并列出现有面板", () => {
	const r = writePanel({}, { name: "线索板", kind: "markdown", content: "- 线索" });
	const panels = r.ok ? r.panels : {};
	const miss = closePanel(panels, "不存在的");
	assert.ok(!miss.ok && miss.error.includes("线索板"), "报错附现有面板名");
	const closed = closePanel(panels, "线索板");
	assert.ok(closed.ok);
	const again = closePanel(closed.ok ? closed.panels : {}, "线索板");
	assert.ok(!again.ok, "重复归档报错");
});

test("savePanels/loadPanels 往返保序；损坏/缺失文件回落空表", () => {
	const dir = mkdtempSync(join(tmpdir(), "rp-panels-"));
	try {
		const file = join(dir, "s1.json");
		let panels: PanelMap = {};
		for (const name of ["地图", "装备库", "线索板"]) {
			const r = writePanel(panels, { name, kind: "markdown", content: name });
			panels = r.ok ? r.panels : panels;
		}
		savePanels(file, panels);
		const loaded = loadPanels(file);
		assert.deepEqual(
			activePanels(loaded).map((p) => p.name),
			["地图", "装备库", "线索板"],
			"插入序即页签序",
		);
		assert.deepEqual(loadPanels(join(dir, "no-such.json")), {}, "缺失文件回落空表");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("formatPanelIndex：速览行；无活跃面板为 null", () => {
	assert.equal(formatPanelIndex({}), null);
	let r = writePanel({}, { name: "地图", kind: "svg", content: "<svg/>" });
	let panels = r.ok ? r.panels : {};
	r = writePanel(panels, { name: "装备库", kind: "markdown", content: "-" });
	panels = r.ok ? r.panels : {};
	assert.equal(formatPanelIndex(panels), "地图(svg)、装备库(markdown)");
});

test("formatPanelSnapshot：含当前 content；手改后模型可见", () => {
	assert.equal(formatPanelSnapshot({}), null);
	let r = writePanel({}, { name: "角色仓库", kind: "markdown", content: "- 青梧：好感 3" });
	const panels = r.ok ? r.panels : {};
	const snap = formatPanelSnapshot(panels);
	assert.ok(snap && snap.includes("角色仓库"));
	assert.ok(snap.includes("好感 3"), "全文进快照");
	// 超长截断
	const long = "x".repeat(100);
	r = writePanel({}, { name: "巨", kind: "markdown", content: long });
	const clipped = formatPanelSnapshot(r.ok ? r.panels : {}, { maxPerPanel: 20, maxTotal: 500 });
	assert.ok(clipped && clipped.includes("截断"));
	assert.ok(clipped && !clipped.includes(long));
});

// ---------- 面板两层：外观在面板文件、数据在 WorldState（v1.5.3） ----------

test("formatPanelSnapshot：声明了数据的面板喂数据，不喂外观标签", () => {
	const r = writePanel({}, {
		name: "队伍",
		kind: "html",
		content: "<!DOCTYPE html><style>.x{color:red}</style><div id=hp></div>",
	});
	const panels = r.ok ? r.panels : {};
	const snap = formatPanelSnapshot(panels, { data: { 队伍: { 体力: 8, 位置: "北岭" } } })!;
	assert.ok(snap.includes("体力"), "数据进快照");
	assert.ok(snap.includes("北岭"));
	assert.ok(!snap.includes("DOCTYPE"), "外观标签一个字都不该进注入");
	assert.ok(!snap.includes("color:red"));
	assert.ok(snap.includes("当前数据"), "表头标明这是数据不是源码");
});

test("formatPanelSnapshot：没数据的面板逐字保持旧行为（守回归）", () => {
	const r = writePanel({}, { name: "线索板", kind: "markdown", content: "- 一封没有落款的信" });
	const panels = r.ok ? r.panels : {};
	const before = formatPanelSnapshot(panels);
	// 传了 data 但不含这个面板 → 与不传 data 完全一致
	assert.equal(formatPanelSnapshot(panels, { data: { 别的面板: { a: 1 } } }), before);
	assert.equal(formatPanelSnapshot(panels, { data: {} }), before);
	// 空树不算「有数据」（否则面板会显示成一份空数据、外观反而看不见）
	assert.equal(formatPanelSnapshot(panels, { data: { 线索板: {} } }), before);
	assert.ok(before!.includes("没有落款"));
});

test("fillPanelTemplate：{{路径}} 换成当前值；取不到的原样留着", () => {
	const tree = { 队伍: { 体力: 8, 位置: "北岭", 成员: ["旅人", "船夫"] }, 已出发: true, 空: null };
	const f = (s: string, o?: { escapeMarkup?: boolean }) => fillPanelTemplate(s, tree, o);

	assert.equal(f("体力 {{队伍.体力}} / 位置 {{队伍.位置}}"), "体力 8 / 位置 北岭");
	assert.equal(f("{{ 队伍.位置 }}"), "北岭", "允许占位符内留空格");
	assert.equal(f("{{已出发}}"), "true", "布尔转字符串");
	assert.equal(f("{{队伍.成员}}"), "旅人、船夫", "数组按顿号连接");

	// 取不到 / 拿到对象或 null：原样留着，让写错的路径露出来
	assert.equal(f("{{队伍.士气}}"), "{{队伍.士气}}");
	assert.equal(f("{{不存在.深.路径}}"), "{{不存在.深.路径}}");
	assert.equal(f("{{队伍}}"), "{{队伍}}", "对象不塞进模板");
	assert.equal(f("{{空}}"), "{{空}}");

	// 无树时原样返回
	assert.equal(fillPanelTemplate("{{队伍.体力}}", undefined), "{{队伍.体力}}");
});

test("fillPanelTemplate：拼进 srcDoc 的要转义，markdown 不要", () => {
	const tree = { 名: "<b>甲</b> & 乙" };
	assert.equal(fillPanelTemplate("{{名}}", tree, { escapeMarkup: true }), "&lt;b&gt;甲&lt;/b&gt; &amp; 乙");
	assert.equal(fillPanelTemplate("{{名}}", tree), "<b>甲</b> & 乙");
});
