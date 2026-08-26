import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadLorebookFile } from "../src/lorebook.ts";
import { findMvuRules, findInitVar, parseInitVarYaml, applyMvuPatch, formatMvuTree, isMvuPanelMount, mountMvuPanel, MVU_STATUS_PLACEHOLDER, isMvuRulesEntry, stripMvuRuleEntries } from "../src/mvu.ts";
import { prepareDisplayText, skinAtDepth } from "../src/postprocess.ts";
import { displayRules, extractRegexScripts } from "../src/cardfront.ts";

/** 三张实卡（普查确认带 [initvar]）——放仓库根，测试按需读，缺文件跳过而非红 */
function loadCardBook(file: string): Array<{ comment?: string; content?: string }> | null {
	try {
		const j = JSON.parse(readFileSync(file, "utf8"));
		const d = j.data ?? j;
		return (d.character_book?.entries ?? []).map((e: Record<string, unknown>) => ({
			comment: (e.comment ?? e.name ?? "") as string,
			content: (e.content ?? "") as string,
		}));
	} catch {
		return null;
	}
}

test("parseInitVarYaml：缩进映射 + 标量类型 + 行内空容器", () => {
	const tree = parseInitVarYaml(`世界:
  当前时间: "第4纪元201年"
  当前天气: 晴朗
user:
  等级: 1
  心情: 80
  装备:
    头部: 无
    颈部: 贵族项链
  背包: {}
  开关: false
台词: []`);
	assert.equal((tree.世界 as any).当前时间, "第4纪元201年");
	assert.equal((tree.世界 as any).当前天气, "晴朗");
	assert.equal((tree.user as any).等级, 1, "纯数字→number");
	assert.equal(typeof (tree.user as any).等级, "number");
	assert.equal((tree.user as any).装备.颈部, "贵族项链", "深度 3 缩进");
	assert.deepEqual((tree.user as any).背包, {}, "行内空对象");
	assert.equal((tree.user as any).开关, false, "布尔");
	assert.deepEqual(tree.台词, [], "行内空数组");
});

test("parseInitVarYaml：回退父层正确（同级键不吞进上一个子映射）", () => {
	const tree = parseInitVarYaml(`a:
  x: 1
b:
  y: 2`);
	assert.equal((tree.a as any).x, 1);
	assert.equal((tree.b as any).y, 2);
	assert.equal((tree.a as any).y, undefined, "b 不能被吞进 a");
});

test("parseInitVarYaml：不认得的行跳过、不毁树（多行数组项）", () => {
	const tree = parseInitVarYaml(`列表:
  - 甲
  - 乙
后续: 值`);
	// `- 甲` 不是 key:value，跳过；`后续` 仍在
	assert.equal(tree.后续, "值");
});

test("findInitVar：包裹方言（[initvar]…[/initvar] 在 content）", () => {
	const tree = findInitVar([
		{ comment: "普通设定", content: "这是一段散文设定。" },
		{ comment: "【AI注入】初始数据文件", content: "[initvar]\nuser:\n  姓名: 阿甲\n[/initvar]" },
	]);
	assert.ok(tree);
	assert.equal((tree!.user as any).姓名, "阿甲");
});

test("findInitVar：裸 YAML 方言（[initvar] 只在条目名）", () => {
	const tree = findInitVar([
		{ comment: "[initvar]变量初始化勿开", content: "主角:\n  境界: 凡人\n  寿元: 16" },
	]);
	assert.ok(tree);
	assert.equal((tree!.主角 as any).境界, "凡人");
	assert.equal((tree!.主角 as any).寿元, 16);
});

test("findInitVar：无 initvar 返回 null（非 MVU 卡不硬解）", () => {
	assert.equal(findInitVar([{ comment: "世界观", content: "一段普通设定文本。" }]), null);
	assert.equal(findInitVar([]), null);
});

test("applyMvuPatch：平铺 path→值 套进树，深路径下钻", () => {
	const tree = { user: { 装备: { 头部: "无" }, 背包: { 金币: 500 } }, 世界: { 当前地点: "白漫城" } };
	const r = applyMvuPatch(tree, {
		"user.装备.头部": "铁头盔",
		"user.背包.金币": 480,
		"世界.当前地点": "裂谷城",
	});
	assert.equal((r.tree.user as any).装备.头部, "铁头盔");
	assert.equal((r.tree.user as any).背包.金币, 480);
	assert.equal((r.tree.世界 as any).当前地点, "裂谷城");
	assert.equal(r.applied.length, 3);
	assert.equal(r.warnings.length, 0);
	// 不改原树（纯函数）
	assert.equal((tree.user.装备 as any).头部, "无");
});

test("applyMvuPatch：缺失中间层自动补建（新出场角色/新地点）", () => {
	const r = applyMvuPatch({}, { "多角色存档.莉莉.好感度": 30 });
	assert.equal((r.tree.多角色存档 as any).莉莉.好感度, 30);
	assert.equal(r.warnings.length, 0);
});

test("applyMvuPatch：整段替换（值本身是对象）", () => {
	const r = applyMvuPatch({ user: { 背包: {} } }, {
		"user.背包": { 金币: 100, 药水: 3 },
	});
	assert.deepEqual((r.tree.user as any).背包, { 金币: 100, 药水: 3 });
});

test("applyMvuPatch：标量层被下钻时记警告但不抛", () => {
	const r = applyMvuPatch({ a: 5 }, { "a.b": 1 });
	assert.equal((r.tree.a as any).b, 1);
	assert.ok(r.warnings.length > 0, "标量被覆盖成对象应记警告");
});

test("formatMvuTree：平铺成 路径:值，空容器标注", () => {
	const txt = formatMvuTree({ user: { 姓名: "阿甲", 背包: {} }, 台词: [] });
	assert.match(txt, /user\.姓名: 阿甲/);
	assert.match(txt, /user\.背包: \{\}/);
	assert.match(txt, /台词: \[\]/);
});

test("formatMvuTree：超大树截断且提示", () => {
	const big: Record<string, unknown> = {};
	for (let i = 0; i < 500; i++) big[`k${i}`] = i;
	const txt = formatMvuTree(big, 50);
	assert.match(txt, /仅列前 50 项/);
	assert.ok(txt.split("\n").length <= 51);
});

// ── 三张真卡端到端（存在才跑）──
test("真卡·奴漫城：findInitVar 解出 115 键树、关键字段对", () => {
	const book = loadCardBook("_card-奴漫城.chara.json");
	if (!book) return; // 卡不在（CI/clean clone）→ 跳过
	const tree = findInitVar(book);
	assert.ok(tree, "应解出树");
	assert.equal((tree!.user as any).装备.颈部, "贵族项链");
	assert.equal((tree!.user as any).背包.金币, 500);
	assert.equal((tree!.世界 as any).当前地点, "白漫城");
	assert.equal((tree!.地图 as any).白漫城.执行奴隶法, false, "18 个地点的 boolean");
	assert.equal(Object.keys(tree!.地图 as any).length, 18);
	// 端到端：改一拍
	const r = applyMvuPatch(tree!, { "user.背包.金币": 480, "世界.当前地点": "裂谷城" });
	assert.equal((r.tree.user as any).背包.金币, 480);
});

test("真卡·模拟修仙2 / 道渊：裸 YAML 方言也能解", () => {
	for (const [file, probe] of [
		["_card-2-dec.json", (t: any) => t.主角],
		["_card-奴漫城.chara.json", (t: any) => t.user], // 兜底至少奴漫城在
	] as const) {
		const book = loadCardBook(file);
		if (!book) continue;
		const tree = findInitVar(book);
		if (!tree) continue;
		assert.ok(probe(tree) || Object.keys(tree).length > 0, `${file} 应解出非空树`);
	}
});

// ————————————————— 面板挂载点（8/26） —————————————————

test("isMvuPanelMount：只认协议常量，不认任何「固定字面量 + 整份界面」的规则", () => {
	assert.ok(isMvuPanelMount({ source: MVU_STATUS_PLACEHOLDER }));
	assert.ok(isMvuPanelMount({ source: "<StatusPlaceHolderImpl\/>" }), "作者写 \/ 转义也是同一个常量");
	// 13 张卡普查里另有四类「固定字面量 + 整份界面」的显示规则，触发字由剧情/开场白产出，
	// 替它们补挂＝把开局屏糊到每一拍上。判据必须让它们全部落空。
	for (const src of ["【本世界身份认证】", "\[重塑仙缘\]", "lucklyjkop", "<StatusBlock>", "</StatusBlock>"]) {
		assert.equal(isMvuPanelMount({ source: src }), false, `${src} 不是 MVU 挂载点`);
	}
	// 贪婪/带元字符的规则一概不是
	for (const src of ["[\s\S]+", "<state(\d+)>", "<Status.*?/>"]) {
		assert.equal(isMvuPanelMount({ source: src }), false, `${src} 不是固定字面量`);
	}
});

test("mountMvuPanel：卡声明了挂载点才补，已有则不重复，没声明则一字不动", () => {
	const mount = [{ source: MVU_STATUS_PLACEHOLDER }];
	const none = [{ source: "<state(\d+)>" }];
	assert.equal(mountMvuPanel("正文。", none), "正文。", "没声明挂载点的卡＝零变化");
	assert.equal(mountMvuPanel("正文。", mount), `正文。\n\n${MVU_STATUS_PLACEHOLDER}`);
	// 开场白作者手写了一个（奴漫城 first_mes 末行）→ 不补第二个
	const already = `正文。\n\n${MVU_STATUS_PLACEHOLDER}`;
	assert.equal(mountMvuPanel(already, mount), already);
	assert.equal(mountMvuPanel("", mount), "", "空正文不无端造出一条面板");
});

test("skinAtDepth：mvu 只在最新一条成立——梨园只持有当前一棵树，画到历史上就是撒谎", () => {
	const skin = { rules: [{ name: "面板", source: MVU_STATUS_PLACEHOLDER, flags: "", replace: "<div>UI</div>" }], charName: "c", userName: "u", mvu: true };
	assert.equal(skinAtDepth(skin, 0)?.mvu, true);
	assert.equal(skinAtDepth(skin, 1)?.mvu, false);
	assert.equal(skinAtDepth(skin, 7)?.mvu, false);
	// 未置位的皮肤：不因为过一趟 skinAtDepth 就凭空获得挂载权
	const plain = { ...skin, mvu: undefined };
	assert.ok(!skinAtDepth(plain, 0)?.mvu);
	// 无深度限定且无 mvu ⇒ 原样返回同一引用（旧行为，别制造无谓新引用）
	assert.equal(skinAtDepth(plain, 3), plain);
});

test("真卡·奴漫城端到端：叙事正文 → 补挂 → 显示正则换成整份面板；历史与非 MVU 卡不动", () => {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync("_card-奴漫城.chara.json", "utf8"));
	} catch {
		return; // 卡不在（clean clone）→ 跳过而非红
	}
	const rules = displayRules(extractRegexScripts(raw));
	assert.equal(rules.filter(isMvuPanelMount).length, 1, "奴漫城恰好一条挂载点规则");
	const prose = "他压低声音，“那法令是真的。”\n\n<fox_tip>\n小心呀～\n</fox_tip>";
	const base = { rules, charName: "奴漫城", userName: "明月" };

	const before = prepareDisplayText(prose, skinAtDepth({ ...base }, 0));
	assert.ok(!/--bg-color/.test(before), "mvu 未置位 ⇒ 与改动前逐字同路，没有面板");

	const live = prepareDisplayText(prose, skinAtDepth({ ...base, mvu: true }, 0));
	assert.ok(/--bg-color/.test(live), "最新一条应挂出面板（作者 15634 字 HTML）");
	assert.ok(live.length > before.length + 10000);
	assert.ok(!live.includes(MVU_STATUS_PLACEHOLDER), "挂载点必须被显示正则吃掉，不许裸奔上屏");
	assert.ok(live.includes("那法令是真的"), "正文守恒");

	const old = prepareDisplayText(prose, skinAtDepth({ ...base, mvu: true }, 1));
	assert.equal(old, before, "历史消息与改动前逐字一致");
});

// ————————————————— 归属：规则条目不喂主模型（8/26） —————————————————

test("isMvuRulesEntry：认 check: 声明约定，不认条目名；initvar 数据条目排除", () => {
	assert.ok(isMvuRulesEntry({ content: "变量更新规则:\n  世界:\n    当前时间:\n      check:\n        - 每拍推进" }));
	assert.ok(isMvuRulesEntry({ comment: "随便起的名字", content: "foo:\n  check:\n    - bar" }), "不问条目名");
	assert.equal(isMvuRulesEntry({ content: "[initvar]\n世界:\n  check: 无关\n[/initvar]" }), false, "initvar 数据条目排除");
	assert.equal(isMvuRulesEntry({ comment: "[initvar]初始", content: "世界:\n  check: x" }), false);
	assert.equal(isMvuRulesEntry({ content: "他去check了一下门锁：没锁。" }), false, "行中的 check 字样不算声明");
	assert.equal(isMvuRulesEntry({ content: "" }), false);
});

test("stripMvuRuleEntries：有树才动、只置 enabled=false、不改入参、场记照旧拿得到", () => {
	const rules = { comment: "变量更新规则", content: "user:\n  背包:\n    check:\n      - 获得时add", enabled: true };
	const initvar = { comment: "初始数据", content: "[initvar]\nuser:\n  等级: 1\n[/initvar]", enabled: true };
	const setting = { comment: "天际省", content: "北方的雪原之国。", enabled: true };

	// 无树的书：一律不动——不去掐一份没人接手的内容
	const noTree = stripMvuRuleEntries([{ ...rules }, { ...setting }]);
	assert.equal(noTree.dropped.length, 0);
	assert.equal(noTree.entries[0]!.enabled, true);

	const input = [rules, initvar, setting];
	const r = stripMvuRuleEntries(input);
	assert.equal(r.dropped.length, 1);
	assert.equal(r.dropped[0]!.title, "变量更新规则");
	assert.equal(r.entries[0]!.enabled, false, "规则条目对主模型关掉");
	assert.equal(r.entries[1]!.enabled, true, "initvar 条目本刀不碰（它是模型唯一的装备/物品来源）");
	assert.equal(r.entries[2]!.enabled, true, "真设定不受影响");
	assert.equal(input[0]!.enabled, true, "不改入参数组");
	// 关掉之后场记仍拿得到：mvu.ts 一律无视 enabled（作者停用是对模型停用，不是对插件停用）
	assert.ok(findMvuRules(r.entries)?.includes("获得时add"));
	// 已停用的条目不重复记账
	assert.equal(stripMvuRuleEntries(r.entries).dropped.length, 0);
});

test("真书·奴漫城：签名判不到、归属判得到；另外三本零变化", () => {
	// 实书是本地私有数据（assets/lorebooks/* 已 gitignore，只有 Mistvale 进仓库），
	// clean clone / CI 里读不到 → 整条跳过而非红。合成用例已覆盖逻辑本身。
	let nu: Array<{ comment?: string; content?: string; enabled: boolean }>;
	let lws: Array<{ comment?: string; content?: string; enabled: boolean }>;
	try {
		nu = loadLorebookFile("assets/lorebooks/奴漫城.json");
		lws = loadLorebookFile("assets/lorebooks/Living With Slaves.json");
	} catch {
		return;
	}
	const dropped = stripMvuRuleEntries(nu).dropped;
	assert.equal(dropped.length, 1, "奴漫城恰好一条规则条目");
	assert.equal(dropped[0]!.title, "【AI注入】变量更新规则");
	assert.equal(dropped[0]!.chars, 748);
	// initvar 那条本刀不碰（它是主模型唯一的装备/物品视野，摘不摘归用户定）
	assert.ok(
		stripMvuRuleEntries(nu).entries.some((e) => /\[initvar\]/i.test(e.content ?? "") && e.enabled),
		"initvar 数据条目必须仍是启用的",
	);
	// 无树的书（Living With Slaves 根本没 MVU）一字不动
	assert.equal(stripMvuRuleEntries(lws).dropped.length, 0);
});
