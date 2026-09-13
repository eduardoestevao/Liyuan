/**
 * 预设窄拆声明（docs/PLAN-PRESET-HARNESS-STRIP.md）：编译后全文 → 模型一次性声明站点
 * → 用户过目 → 按声明分流转译（身份→卡级 APPEND_SYSTEM.md，写作规则→卡档案 AGENTS.md，
 * 机制模拟段落成关闭条目，材料包装跳过）。
 *
 * 管线位置（2026-09-12 用户定序）：导入 JSON 原样复现 → 在预设块编辑器里拨开关（人称/基调/
 * 文风等选项就是块的 enabled）→ 保存 → 引擎 `assemble()` 按开关编译成一份提示词 → 本模块
 * 二次处理。选项在上游由引擎带开关重跑取得，本模块**不读未启用块、不手搓宏求值**。
 *
 * 三条规矩（窄拆法既定）：
 * - 判断权在模型（声明一次）＋用户（过目可改），落成看得见的数据；不建块名名单（铁律三）。
 * - 拿不准一律留（→ writing，进卡档案）；破限/身份一律 identity（不停用）。
 * - 末尾连续 assistant＝酒馆预填位，丢弃（8/23 定案；engine 同规则），不经声明。
 *
 * 纯函数 + 零模块级可变状态（jiti 二象性红线），可单测。
 */
import { assemble, type AssembledPiece, type AssembleResult } from "./preset-assemble.ts";
import type { PresetDoc } from "./preset-doc.ts";
import { PRESET_SOURCE_SUFFIX, formatEntry, stripEntriesWhere, uniqueEntryName } from "./prompt-entries.ts";

/** 站点闭集：每个站点带标签与去向（数据表，UI 与报告共用） */
export type DeclareStation = "identity" | "writing" | "thinking" | "draft" | "output" | "memory" | "wrapper";

export const STATION_META: Record<DeclareStation, { label: string; dest: string }> = {
	identity: { label: "身份/破限", dest: "APPEND_SYSTEM.md" },
	writing: { label: "写作规则", dest: "卡档案 AGENTS.md" },
	thinking: { label: "思考协议", dest: "停用（原生思考＋agent 循环）" },
	draft: { label: "草稿协议", dest: "停用（稿纸工具）" },
	output: { label: "输出合约", dest: "停用（输出通道／MVU／面板）" },
	memory: { label: "记忆记账", dest: "停用（场记＋世界状态）" },
	wrapper: { label: "材料包装", dest: "跳过（装配器本职）" },
};

const STATIONS = Object.keys(STATION_META) as DeclareStation[];

export const isDeclareStation = (v: unknown): v is DeclareStation =>
	typeof v === "string" && (STATIONS as string[]).includes(v);

export interface DeclareEntry {
	identifier: string;
	name: string;
	role: "system" | "user" | "assistant";
	where: "before" | "after" | "depth";
	chars: number;
	station: DeclareStation;
	/** 模型给的一句理由（过目用，≤30 字） */
	note?: string;
}

export interface PresetDeclaration {
	version: 1;
	preset: string;
	createdAt: string;
	/** 声明用的模型（留档；重声明会覆盖） */
	model?: string;
	entries: DeclareEntry[];
}

/** 装配结果里可声明的片段（非 marker；after 尾部连续 assistant 预填位除外） */
export interface DeclarePiece extends AssembledPiece {
	where: "before" | "after" | "depth";
}

/** 取可声明片段（编译文档序：历史前 → 历史后 → 深度注入） */
export function declarePieces(r: AssembleResult): DeclarePiece[] {
	let end = r.after.length;
	while (end > 0 && r.after[end - 1].role === "assistant") end--;
	return [
		...r.before.map((p) => ({ ...p, where: "before" as const })),
		...r.after.slice(0, end).map((p) => ({ ...p, where: "after" as const })),
		...r.depth.map((p) => ({ ...p, where: "depth" as const })),
	];
}

/** 声明与转译共用的装配入口（同一 AssembleResult，不另造规则） */
export const assembleForDeclare = (
	doc: PresetDoc,
	opts: { charName: string; userName: string },
): AssembleResult => assemble(doc.entries, opts);

// ---------------- 声明提示词（数据加工通道，非 RP 送模面） ----------------

const STATION_DEFINITIONS: Record<DeclareStation, string> = {
	identity: "设定「你是谁」：身份/人格/作家扮演、破限信件、内容边界共识、反审查声明",
	writing:
		"写给模型照着写正文的规则：文风、描写边界、禁词表、对白规则、转述/承接规则、nsfw 准则、字数要求",
	thinking: "规定模型怎么思考：思考模板、思考量要求、思考容器标签、逐项自检清单、思维链开头/收尾",
	draft: "规定正文落笔方式：分段草稿/排练注释（如段前 HTML 注释）、改稿仪式",
	output:
		"规定输出结构：格式模块顺序、正文包裹标签、状态栏/选项/摘要等每拍附加输出的规格、反审查输出仪式",
	memory: "要求每拍输出摘要/关键记忆/事件记录供前端留存（自建记忆系统）",
	wrapper: "包裹卡内容槽位的开闭标签、分节标题、加载演出（如 [World Loading...]）",
};

export function buildDeclarePrompt(
	pieces: DeclarePiece[],
	meta: { preset: string },
): { systemPrompt: string; userText: string } {
	const segments = pieces
		.map(
			(p, i) =>
				`⟦片段${i + 1}｜${p.id}｜${p.role}｜${p.where === "before" ? "历史前" : p.where === "after" ? "历史后" : "深度注入"}｜${p.name}⟧\n${p.text}`,
		)
		.join("\n\n");

	const systemPrompt = [
		"你分析角色扮演预设的结构。输入是一份预设经引擎编译后的线性提示词，已按来源块切成分段，每段头部带 ⟨标识符｜角色｜位置｜块名⟩。",
		"",
		"给每个分段声明一个站点类别，判据：",
		...STATIONS.map((s) => `- ${s}：${STATION_DEFINITIONS[s]}（去向：${STATION_META[s].dest}）`),
		"",
		"规则：",
		"- 破限与身份类内容一律 identity，不做取舍。",
		"- 拿不准的分段一律 writing（保守保留）。",
		"- 只分类，不评价、不改写分段内容。",
		"- 位置与角色只是信号，不是判据本身。",
		"",
		"输出 JSON 数组，逐段一项，不要输出其他文字：",
		'[{"id":"<标识符>","station":"<类别>","note":"<不超过20字的理由>"}]',
	].join("\n");

	const userText = [
		`预设「${meta.preset}」。分段内容如下（⟦…⟧ 标记行是分度信息，不属于分段正文）：`,
		"",
		segments,
	].join("\n");

	return { systemPrompt, userText };
}

// ---------------- 响应解析（宽容；拿不准落 writing） ----------------

export interface ParseDeclareResult {
	entries: DeclareEntry[];
	/** 模型实际声明了几个（对齐 pieces 后） */
	declared: number;
	/** 没被声明、按保守规则落 writing 的标识符 */
	defaulted: string[];
}

const extractJsonArray = (text: string): unknown[] | null => {
	const stripped = text.replace(/```(?:json)?/gi, "");
	const start = stripped.indexOf("[");
	const end = stripped.lastIndexOf("]");
	if (start < 0 || end <= start) return null;
	try {
		const v = JSON.parse(stripped.slice(start, end + 1));
		return Array.isArray(v) ? v : null;
	} catch {
		return null;
	}
};

export function parseDeclareResponse(text: string, pieces: DeclarePiece[]): ParseDeclareResult {
	const raw = extractJsonArray(text) ?? [];
	const byId = new Map<string, { station?: unknown; note?: string }>();
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const o = item as Record<string, unknown>;
		const id = typeof o.id === "string" ? o.id : typeof o.identifier === "string" ? o.identifier : "";
		if (!id) continue;
		byId.set(id, {
			station: o.station,
			note: typeof o.note === "string" ? o.note.slice(0, 60) : undefined,
		});
	}
	const entries: DeclareEntry[] = [];
	const defaulted: string[] = [];
	for (const p of pieces) {
		const hit = byId.get(p.id);
		const station = hit && isDeclareStation(hit.station) ? hit.station : "writing";
		if (!hit) defaulted.push(p.id);
		entries.push({
			identifier: p.id,
			name: p.name,
			role: p.role,
			where: p.where,
			chars: p.text.length,
			station,
			note: hit?.note,
		});
	}
	return { entries, declared: entries.length - defaulted.length, defaulted };
}

/** 用户过目后的声明同样走这里归一（改错的站别落 writing，多余的条目忽略） */
export function normalizeDeclaration(
	declaration: PresetDeclaration,
	pieces: DeclarePiece[],
): PresetDeclaration {
	const parsed = parseDeclareResponse(JSON.stringify(declaration.entries), pieces);
	return { ...declaration, version: 1, entries: parsed.entries };
}

// ---------------- 按声明分流转译 ----------------

/**
 * 转译产物形态：**逐块条目，不合并**——每个编译后片段一条 `## 块名（预设）` 条目
 * （标题后缀＝来源标注，见 prompt-entries.ts；条目视图剥掉显示、挂徽标）。
 * - 身份块 → 卡级 APPEND_SYSTEM.md（`# 预设提示词` 下，活动条目）
 * - 写作块 → 卡档案 AGENTS.md（平级活动条目，不设伞形板块）
 * - 停用的机制块（思考/草稿/输出/记忆）→ AGENTS.md 里 **HTML 注释包裹的关闭条目**——
 *   送模零成本，条目视图里看得见、想要哪段拨开即可——停用是可见可逆的数据，不是消失
 * - 材料包装 → 跳过
 */
export interface DeclareLineItem {
	identifier: string;
	name: string;
	chars: number;
	action:
		| "append"
		| "agents"
		| "disabled"
		| "wrapper"
		| "skipped-marker"
		| "skipped-disabled"
		| "skipped-empty"
		| "dropped-prefill";
	station?: DeclareStation;
	note?: string;
}

export interface DeclareTranslateResult {
	/** 卡级 APPEND_SYSTEM.md 追加段（`# 预设提示词` ＋ 身份条目；无身份块则空串） */
	appendMarkdown: string;
	/** 卡档案 AGENTS.md 追加段（写作条目＋关闭的机制条目；无则空串） */
	agentsSection: string;
	lines: DeclareLineItem[];
	samplers: Record<string, number>;
	usesLastUserMessage: string[];
	unsupportedMacros: string[];
}

export function translatePresetWithDeclaration(
	doc: PresetDoc,
	declaration: PresetDeclaration,
	opts: { charName: string; userName: string },
): DeclareTranslateResult {
	const r = assemble(doc.entries, { charName: opts.charName, userName: opts.userName });
	const pieces = declarePieces(r);
	const norm = normalizeDeclaration(declaration, pieces);
	const stationOf = new Map(norm.entries.map((e) => [e.identifier, e]));

	const appendNames = new Set<string>();
	const agentsNames = new Set<string>();
	const appendEntries: string[] = [];
	const agentsEntries: string[] = [];
	const lines: DeclareLineItem[] = [];

	for (const p of pieces) {
		const e = stationOf.get(p.id);
		const station = e?.station ?? "writing";
		const item: DeclareLineItem = {
			identifier: p.id,
			name: p.name,
			chars: p.text.length,
			action: "agents",
			station,
			note: e?.note,
		};
		if (station === "wrapper") {
			item.action = "wrapper";
		} else if (station === "identity") {
			appendEntries.push(formatEntry(uniqueEntryName(p.name, PRESET_SOURCE_SUFFIX, appendNames), p.text));
			item.action = "append";
		} else if (station === "writing") {
			agentsEntries.push(formatEntry(uniqueEntryName(p.name, PRESET_SOURCE_SUFFIX, agentsNames), p.text));
			item.action = "agents";
		} else {
			agentsEntries.push(formatEntry(uniqueEntryName(p.name, PRESET_SOURCE_SUFFIX, agentsNames), p.text, false));
			item.action = "disabled";
		}
		lines.push(item);
	}

	// 预填位丢弃
	let end = r.after.length;
	while (end > 0 && r.after[end - 1].role === "assistant") end--;
	for (const p of r.after.slice(end)) {
		lines.push({ identifier: p.id, name: p.name, chars: p.text.length, action: "dropped-prefill" });
	}
	// 非片段去向（marker / 关闭 / 零字 / 缺失）——关闭的块是上游开关的结果，只入账不取内容
	for (const item of r.report) {
		if (pieces.some((p) => p.id === item.identifier)) continue;
		if (item.action === "marker 槽位" || item.action === "marker 无料") {
			if (item.identifier === "chatHistory") continue;
			lines.push({ identifier: item.identifier, name: item.name, chars: item.chars, action: "skipped-marker" });
		} else if (item.action === "关闭") {
			lines.push({ identifier: item.identifier, name: item.name, chars: item.chars, action: "skipped-disabled" });
		} else if (item.action === "零字" || item.action === "缺失定义") {
			lines.push({ identifier: item.identifier, name: item.name, chars: item.chars, action: "skipped-empty" });
		}
	}

	// 产物只有条目，不夹备注行：来源在标题后缀里、去向在转译报告里；
	// 单行 <!-- --> 不是条目引擎认的块注释，会混进上一条正文送模，重转译也剥不掉。
	const appendMarkdown =
		appendEntries.length === 0
			? ""
			: [`# 预设提示词${PRESET_SOURCE_SUFFIX}`, ``, ...appendEntries].join("\n");

	const agentsSection = agentsEntries.length === 0 ? "" : agentsEntries.join("\n");

	return {
		appendMarkdown,
		agentsSection,
		lines,
		samplers: { ...doc.samplers },
		usesLastUserMessage: r.usesLastUserMessage,
		unsupportedMacros: r.unsupported,
	};
}

/** 从现有全文剥掉所有预设来源条目（含关闭态）——重转译幂等的前半步；没有可剥的原样返回 */
export function stripPresetEntries(md: string): string {
	return stripEntriesWhere(md, (e) => e.source?.kind === "preset");
}

// ---------------- 报告 ----------------

const DECLARE_ACTION_LABEL: Record<DeclareLineItem["action"], string> = {
	append: "收入 APPEND_SYSTEM.md（身份/破限，活动条目）",
	agents: "收入卡档案（写作规则，活动条目）",
	disabled: "停用（卡档案里的关闭条目，可拨开）",
	wrapper: "跳过（装配器本职）",
	"skipped-marker": "跳过（槽位）",
	"skipped-disabled": "未启用（预设开关关着）",
	"skipped-empty": "无正文",
	"dropped-prefill": "丢弃（预填位，8/23 定案）",
};

export function declareTranslateReport(
	doc: PresetDoc,
	r: DeclareTranslateResult,
	declaration: PresetDeclaration,
	sourceFile: string,
): string {
	const count = (a: DeclareLineItem["action"]) => r.lines.filter((l) => l.action === a).length;
	const head = [
		`# 转译报告：${doc.name}（窄拆）`,
		``,
		`- 原文：\`${sourceFile}\`（未改动，可重新转译）`,
		`- 日期：${declaration.createdAt}${declaration.model ? `；声明模型：${declaration.model}` : ""}`,
		`- 产物一：本卡 APPEND_SYSTEM.md（${count("append")} 条身份条目，${r.appendMarkdown.length.toLocaleString()} 字）`,
		`- 产物二：本卡 AGENTS.md（写作条目 ${count("agents")} 条＋关闭的机制条目 ${count("disabled")} 条，共 ${r.agentsSection.length.toLocaleString()} 字；关闭条目不进送模）`,
		`- 预设开关关着的块：${count("skipped-disabled")} 块（要它们就在预设编辑器里打开、保存、重新转译）`,
		`- 采样参数：${Object.keys(r.samplers).length} 项 → 已迁入 config.samplers`,
	];
	if (r.usesLastUserMessage.length > 0) {
		head.push(`- ⚠ 引用 {{lastusermessage}} 的块（逐拍宏，转译按空串求值）：${r.usesLastUserMessage.join("、")}`);
	}
	if (r.unsupportedMacros.length > 0) {
		head.push(`- ⚠ 清单外宏（原样保留在文本里）：${r.unsupportedMacros.join("、")}`);
	}
	head.push(``, `## 逐块去向`, ``);
	const rows = r.lines.map((l) => {
		const station = l.station ? `（${STATION_META[l.station].label}）` : "";
		const note = l.note ? `——${l.note}` : "";
		return `- ${l.name || l.identifier} · ${l.chars.toLocaleString()} 字：${DECLARE_ACTION_LABEL[l.action]}${station}${note}`;
	});
	const tail = [
		``,
		`## 已知代价（窄拆既定，不当 bug 查）`,
		``,
		`- 破限信件对原是带角色的消息（模型见「自己已答应」），转译后拍平为文件内引文，结构弱化、语义保留。`,
		`- 停输出合约后，靠预设教模型吐状态栏/选项的卡会停止吐——梨园里这是预期行为（MVU/面板/ask 接管）；卡自带的输出格式不受影响。`,
		`- 声明草稿留档：assets/presets/.liyuan/预设声明-*.json（全局一份，可改后重新转译）。`,
	];
	return [...head, ...rows, ...tail, ""].join("\n");
}
