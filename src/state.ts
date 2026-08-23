/**
 * 结构化世界状态：读写、补丁合并、注入格式化。
 * 这是对 ST「模型忘状态」痛点的架构级解法（PLAN.md §3）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readJsonFile } from "./jsonio.ts";
import type { CharacterState, StateRoster, WorldState } from "./types.ts";

const TOP_KEYS = ["time", "location", "characters", "inventory", "flags", "plot_threads"] as const;

export function defaultState(): WorldState {
	return {
		time: "",
		location: "",
		characters: {},
		inventory: [],
		flags: {},
		plot_threads: [],
	};
}

export function loadState(file: string): WorldState {
	try {
		const raw = readJsonFile(file) as Partial<WorldState>;
		return { ...defaultState(), ...raw };
	} catch {
		return defaultState();
	}
}

export function saveState(file: string, state: WorldState): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
}

export interface PatchResult {
	state: WorldState;
	/** 人类可读的变更摘要（用于工具返回，让模型确认写入了什么） */
	applied: string[];
	warnings: string[];
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const normName = (s: string) => s.trim().toLowerCase();

/**
 * 把补丁中的角色键归一到已知的规范名（大小写/首尾空白不敏感），
 * 防止同一角色被记成多份（实测 flash 会写出 "Alice"/"alice " 变体）。
 * 中文译名与原名的等同（爱丽丝=Alice）无法机械判定，交给 Phase 2 scribe。
 */
export function canonicalizeCharacterKeys(
	patch: Record<string, unknown>,
	knownNames: string[],
): Record<string, unknown> {
	const chars = patch.characters;
	if (!chars || typeof chars !== "object" || Array.isArray(chars)) return patch;

	const canon = new Map<string, string>();
	for (const n of knownNames) {
		const k = normName(n);
		if (k && !canon.has(k)) canon.set(k, n.trim());
	}
	const out: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(chars as Record<string, unknown>)) {
		const key = canon.get(normName(name)) ?? name.trim();
		if (!canon.has(normName(name))) canon.set(normName(name), key);
		// 补丁内部撞到同一规范名：浅合并（后写的字段覆盖）
		if (out[key] && value && typeof value === "object" && typeof out[key] === "object") {
			out[key] = { ...(out[key] as object), ...(value as object) };
		} else {
			out[key] = value;
		}
	}
	return { ...patch, characters: out };
}

/**
 * 合并补丁。语义（工具描述中向模型说明）：
 * - time / location：字符串整体替换
 * - characters：按角色名合并字段；传 null 删除该角色
 * - flags：按键合并；传 null 删除该键
 * - inventory / plot_threads：数组整体替换（须传完整数组）
 * - 未知顶层键拒绝并告警（保持 schema 诚实）
 */
export function applyPatch(state: WorldState, patch: Record<string, unknown>): PatchResult {
	const next: WorldState = structuredClone(state);
	const applied: string[] = [];
	const warnings: string[] = [];

	for (const [key, value] of Object.entries(patch)) {
		switch (key) {
			case "time":
			case "location": {
				if (typeof value === "string") {
					next[key] = value;
					applied.push(`${key} → ${value}`);
				} else warnings.push(`${key} 需要字符串，已忽略`);
				break;
			}
			case "characters": {
				if (value && typeof value === "object" && !Array.isArray(value)) {
					for (const [name, cs] of Object.entries(value as Record<string, unknown>)) {
						if (cs === null) {
							delete next.characters[name];
							applied.push(`characters.${name} 已移除`);
							continue;
						}
						if (!cs || typeof cs !== "object") {
							warnings.push(`characters.${name} 需要对象或 null，已忽略`);
							continue;
						}
						const cur: CharacterState = next.characters[name] ?? { affinity: 0, status: "", notes: "" };
						const p = cs as Partial<Record<keyof CharacterState, unknown>>;
						if (typeof p.affinity === "number") cur.affinity = clamp(Math.round(p.affinity), -100, 100);
						if (typeof p.status === "string") cur.status = p.status;
						if (typeof p.notes === "string") cur.notes = p.notes;
						if (typeof p.at === "string") cur.at = p.at;
						next.characters[name] = cur;
						applied.push(`characters.${name} 已更新`);
					}
				} else warnings.push("characters 需要对象，已忽略");
				break;
			}
			case "flags": {
				if (value && typeof value === "object" && !Array.isArray(value)) {
					for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
						if (v === null) {
							delete next.flags[k];
							applied.push(`flags.${k} 已移除`);
						} else if (typeof v === "string") {
							next.flags[k] = v;
							applied.push(`flags.${k} → ${v}`);
						} else {
							next.flags[k] = JSON.stringify(v);
							applied.push(`flags.${k} 已更新`);
						}
					}
				} else warnings.push("flags 需要对象，已忽略");
				break;
			}
			case "inventory":
			case "plot_threads": {
				if (Array.isArray(value)) {
					// 非字符串元素**不静默丢弃**：模型常传 [{name,数量}] 这类对象，
					// 旧实现 filter 掉后仍回报「成功」（applied 里是空数组），模型只能反复试错。
					const kept = value.filter((x): x is string => typeof x === "string");
					const dropped = value.filter((x) => typeof x !== "string");
					if (dropped.length > 0) {
						warnings.push(
							`${key} 有 ${dropped.length} 项不是字符串已丢弃（${dropped
								.slice(0, 2)
								.map((d) => JSON.stringify(d))
								.join("、")}${dropped.length > 2 ? "…" : ""}）——` +
								`本字段是字符串数组，请写成 ["补气丹（已服用）"] 这样的一句话条目。`,
						);
					}
					next[key] = kept;
					applied.push(`${key} → [${kept.join("、")}]`);
				} else warnings.push(`${key} 需要完整数组（整体替换语义），已忽略`);
				break;
			}
			case "roster": {
				// 登场名录编辑（用户主权，REST 侧用；模型工具 schema 不含此键）：
				// {characters/places/items/events: {名称: null(删除) | 字符串(改登场时间)}}。
				// 注意：删除**活跃**条目会被本函数末尾的 registerRoster 立即重新登记——名录必须覆盖在场条目。
				if (value && typeof value === "object" && !Array.isArray(value)) {
					const roster: StateRoster = next.roster ?? { characters: {}, items: {}, events: {} };
					if (!roster.places) roster.places = {};
					for (const table of ["characters", "places", "items", "events"] as const) {
						const patchTable = (value as Record<string, unknown>)[table];
						if (patchTable === undefined) continue;
						if (!patchTable || typeof patchTable !== "object" || Array.isArray(patchTable)) {
							warnings.push(`roster.${table} 需要对象，已忽略`);
							continue;
						}
						const dest = table === "places" ? roster.places : roster[table];
						for (const [name, v] of Object.entries(patchTable as Record<string, unknown>)) {
							if (v === null) {
								delete dest[name];
								applied.push(`roster.${table}.${name} 已移除`);
							} else if (typeof v === "string") {
								dest[name] = v.slice(0, 60);
								applied.push(`roster.${table}.${name} 已更新`);
							} else warnings.push(`roster.${table}.${name} 需要字符串或 null，已忽略`);
						}
					}
					next.roster = roster;
				} else warnings.push("roster 需要对象，已忽略");
				break;
			}
			default:
				warnings.push(`未知字段 ${key}，允许的顶层字段：${TOP_KEYS.join(", ")}`);
		}
	}
	registerRoster(next);
	return { state: next, applied, warnings };
}

/** 注入用的紧凑可读格式 */
export function formatState(state: WorldState): string {
	const lines: string[] = [];
	if (state.time) lines.push(`时间：${state.time}`);
	if (state.location) lines.push(`地点：${state.location}`);
	for (const [name, c] of Object.entries(state.characters)) {
		const parts = [`好感 ${c.affinity}`];
		if (c.status) parts.push(`状态：${c.status}`);
		// 位置：与 location 相同＝在场，不同＝人在别处。给的是两个地名这条事实，
		// 「他能不能看见这边」由模型自己判断（不替它下结论）。
		if (c.at) parts.push(c.at === state.location ? "在场" : `在：${c.at}`);
		if (c.notes) parts.push(`备注：${c.notes}`);
		lines.push(`${name}：${parts.join("；")}`);
	}
	if (state.inventory.length) lines.push(`物品：${state.inventory.join("、")}`);
	for (const [k, v] of Object.entries(state.flags)) lines.push(`${k}：${v}`);
	if (state.plot_threads.length) lines.push(`剧情线：${state.plot_threads.map((t) => `「${t}」`).join(" ")}`);
	return lines.length ? lines.join("\n") : "（尚无记录）";
}

// ---------- 登场名录（agent 索引表） ----------

/** 名录各表容量上限（超出丢最旧——Record 保持插入序）。防剧情线改写措辞导致的近重复无限累积。 */
const ROSTER_CAPS = { characters: 100, items: 100, events: 60, places: 60 } as const;

/** 名录登记时给条目的标记预算（存首次登场的剧情时间，自由文本如「第二天清晨」） */
const ROSTER_BLURB_MAX = 30;

function capRoster(reg: Record<string, string>, cap: number): Record<string, string> {
	const keys = Object.keys(reg);
	if (keys.length <= cap) return reg;
	const out: Record<string, string> = {};
	for (const k of keys.slice(keys.length - cap)) out[k] = reg[k]!;
	return out;
}

/**
 * 名录登记（applyPatch 咽喉点调用）：把当前活跃的人物/物品/剧情线并入名录，
 * 附上**首次登场时的剧情时间**（`state.time`，自由文本；为空则只留名字）。
 *
 * ## 为什么存时间而不是状态简述（8/23 改判）
 *
 * 原先人物存的是 `c.status`（如「奴隶」）——那是**当前状态**，而当前状态在
 * 【世界状态】里已有全量新鲜版；名录存它必然过期（只增不改），改成跟着覆盖又会把
 * 用户经 applyPatch 手改的简述当场冲掉。物品与剧情线更是一直存空串，白占结构。
 *
 * 换成登场时间后三件事一次性成立：
 * 1. **时间是固定事实**——事件发生在哪一刻不会变，所以「只增不改」从缺陷变成正确设计；
 * 2. 有时间就有先后——此前几十条剧情线平铺无序，模型无从判断进展到哪了；
 * 3. 职责彻底分开：【世界状态】＝当前（覆盖式），【登场名录】＝出现过什么+何时（追加式）。
 *
 * 借鉴 st-memory-enhancement（木悠记忆表格）的表切分：它把「时空表格」（保持一行的
 * 当前状态）与「重要事件历史表格」（带`日期`列的追加历史）分成两张表，日期只是普通一列。
 */
function registerRoster(next: WorldState): void {
	const r: StateRoster = next.roster ?? { characters: {}, items: {}, events: {} };
	const places = r.places ?? {};
	const at = (next.time || "").slice(0, ROSTER_BLURB_MAX);
	for (const name of Object.keys(next.characters)) {
		if (!(name in r.characters)) r.characters[name] = at;
	}
	for (const it of next.inventory) {
		if (it && !(it in r.items)) r.items[it] = at;
	}
	for (const t of next.plot_threads) {
		if (t && !(t in r.events)) r.events[t] = at;
	}
	// 地点：当前场景 + 各角色所在地都算「到过」。此前名录三张表独缺地点，
	// 「回到曾去过的地方」这类判定无从成立（而地点是剧情里最常复访的东西）。
	for (const p of [next.location, ...Object.values(next.characters).map((c) => c.at ?? "")]) {
		if (p && !(p in places)) places[p] = at;
	}
	next.roster = {
		characters: capRoster(r.characters, ROSTER_CAPS.characters),
		items: capRoster(r.items, ROSTER_CAPS.items),
		events: capRoster(r.events, ROSTER_CAPS.events),
		places: capRoster(places, ROSTER_CAPS.places),
	};
}

/**
 * 名录索引单节的预算（超出则该节退成纯名字表——名字不截断）。
 *
 * 1200 ≈ 30 条剧情线带时间。实测真实会话：剧情线名字均长 21.6 字（常是整句，如
 * 「灵族大祭司求见，欲借大昭为靠山…」），加上登场时间后一节就要 ~317 字——旧预算 240
 * **一加时间就触顶、整节退回纯名字**，等于白改。三节实测合计约 620 字/拍
 * （人物 84 + 物品 220 + 剧情线 317），相对蓝灯常驻每拍无条件的 25632 字约 2.4%。
 * 触顶时的降级仍是「牺牲时间不牺牲名字」——名字全量是「名录之外才是新登场」的前提。
 */
const ROSTER_SECTION_MAX_CHARS = 1200;

function rosterSection(label: string, entries: Array<[string, string]>): string | undefined {
	if (entries.length === 0) return undefined;
	const withBlurb = entries.map(([name, blurb]) => (blurb ? `${name}（${blurb}）` : name));
	// 名字必须全量出：「名录之外的名字才是新登场」这条推断只有在名录完整时才成立，
	// 按条目截断会让被截掉的角色变成「新人」。装不下就整节退成纯名字，牺牲简述不牺牲完整性。
	// 规模有界：ROSTER_CAPS 已把条目数封在 100/100/60。
	const total = withBlurb.reduce((n, t) => n + t.length + 1, 0);
	const titles = total <= ROSTER_SECTION_MAX_CHARS ? withBlurb : entries.map(([name]) => name);
	return `${label}：${titles.join("、")}`;
}

/**
 * 名录索引渲染：**全量**列出本局登记过的人物/物品/剧情线（在场的也列）。
 * 与【世界状态】的分工是详略而非有无——状态给当前详情，名录给「出现过什么」的完整名字表，
 * 模型据此判断一个名字是旧识还是新登场，细节靠 memory_search 召回。
 *
 * **全空也出块**（「（尚无登记）」），与 formatState 的「（尚无记录）」同一口径：开场那拍
 * 名录必然是空的，而那恰恰是最需要让模型看见「这里有可查的东西、现在是空的」的一拍——
 * 空着不出块，模型根本不知道有这回事。给的是通道状态这条事实，不是「你去查」这条指令。
 */
export function formatRosterIndex(state: WorldState): string {
	const r = state.roster;
	const sections = r
		? [
				rosterSection("人物", Object.entries(r.characters)),
				rosterSection("地点", Object.entries(r.places ?? {})),
				rosterSection("物品", Object.entries(r.items)),
				rosterSection("剧情线", Object.entries(r.events)),
			].filter((s): s is string => Boolean(s))
		: [];
	return sections.length ? sections.join("；") : "（尚无登记）";
}
