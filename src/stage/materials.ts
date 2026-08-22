/**
 * 台上素材装载（PLAN-RP-HARNESS M1）。
 *
 * 每拍开演前从磁盘现读：配置 / 角色卡 / 世界书 / 预设（宏求值）。
 * 引擎每回合调用一次——改卡、改预设、挂书即时生效，没有热重载缝隙。
 * 顺带刷新显示层折叠标签注册表（server 侧单实例，与扩展无共享）。
 *
 * 本模块只读盘、不写盘、零 pi 依赖。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { loadCardFile, applyMacros, readCardRawJson } from "../card.ts";
import { promptRules, extractRegexScripts, type DisplayRule } from "../cardfront.ts";
import {
	applyDisabledLore,
	constantEntries,
	loadLorebookFile,
	mergeEntries,
	mountedLorebookPaths,
	overlayPathFor,
	setMountedLorebooks,
} from "../lorebook.ts";
import { addHistoryStripTags, resetDisplayTagExtras } from "../postprocess.ts";
import { stripProtocolEntries, type ProtocolDrop } from "../protocol-detect.ts";
import {
	assemble,
	type AssembledPiece,
	type AssembleReportItem,
	type DepthPiece,
	type MarkerMaterials,
} from "../preset-assemble.ts";
import { loadPresetDoc, type PresetDoc } from "../preset-doc.ts";
import { resolveConfigPath } from "../paths.ts";
import { DEFAULT_CONFIG, type CharacterCard, type LorebookEntry, type RpConfig } from "../types.ts";

/**
 * 预设格式栈的已知标签：**只在送模历史整块剥**（防往拍模仿），显示层照常渲染。
 * 这些是用户要看的产出（咪咪点评/选择框/变量面板），不是脚手架。
 */
const FORMAT_STACK_TAGS = ["w2g", "catsay", "UpdateVariable", "JSONPatch", "Analysis", "draft_notes", "wfeeling"];

/**
 * 预设装配产物的一片。marker 槽位填的是梨园材料（卡/世界书/人设的原文），
 * 预设块填的是宏求值后的原文——两者都不加 harness 引导语。
 */
export type { AssembledPiece } from "../preset-assemble.ts";

export interface StageMaterials {
	config: RpConfig;
	card: CharacterCard;
	/** 已挂载世界书 + 补充设定集 overlay，禁用项与外部插件协议条目已剔除 */
	entries: LorebookEntry[];
	/** 预设文档（原文 + 归一条目）；null＝未配置且无默认预设 */
	presetDoc: PresetDoc | null;
	/** 装配产物：chatHistory 槽位之前的片段（含已归位的 marker 材料），按预设作者原序 */
	presetBefore: AssembledPiece[];
	/** injection_position=1 的深度注入片段（数据层保真；消费待后续里程碑接入） */
	presetDepth: DepthPiece[];
	/** 预设声明过的 marker 槽位 id——没声明的槽位由梨园按兜底版式补，避免卡内容丢失 */
	declaredMarkers: Set<string>;
	/** skill 一等素材位（M-R2）：工作目录 skills/<name>/SKILL.md 扫描产物 */
	skillFiles: SkillFile[];
	/** 装配报告：每块去向（engine 落盘 .liyuan/preset-assembly.json） */
	presetAssembly: AssembleReportItem[];
	/** 历史前段全部求值后内容——机械规则提取（extractDraftRules）用 */
	presetRuleTexts: string[];
	/** marker 槽位材料（卡/世界书/人设）——引擎每拍重装历史后段时复用同一份 */
	markerMaterials: MarkerMaterials;
	/** 任一渠道有启用块——扮演规范让位给预设的判定依据 */
	presetActive: boolean;
	/** 宏求值遇到的清单外宏名（供引擎降级告警） */
	macroWarnings: string[];
	/** M-C2：被判死的外部插件协议条目（世界书通道 H 类退场，进装配报告） */
	protocolDrops: ProtocolDrop[];
	/** 送模侧作者正则（promptOnly/破坏性，预设+卡）——rebuildHistory 应用，剥「作者不想让模型看」的块 */
	promptRules: DisplayRule[];
}

const resolvePath = (cwd: string, p: string): string => (isAbsolute(p) ? p : join(cwd, p));

/** 读配置（含旧字段迁移）；文件缺失/损坏回落默认 */
export function loadStageConfig(cwd: string): RpConfig {
	const configPath = resolveConfigPath(cwd);
	let raw: RpConfig = { ...DEFAULT_CONFIG };
	if (existsSync(configPath)) {
		try {
			raw = { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(configPath, "utf8")) as Partial<RpConfig>) };
		} catch {
			raw = { ...DEFAULT_CONFIG };
		}
	}
	return setMountedLorebooks(raw, mountedLorebookPaths(raw));
}

/** skill 文件（agentskills.io 布局：skills/<name>/SKILL.md，frontmatter name+description 必填） */
export interface SkillFile {
	name: string;
	/** L1 触发面（只写 when）；进 system `# 可用 skill` 索引 */
	description: string;
	/** 常驻档：正文随 system 送达（每拍都用的流程骨架）；拉取档走 skill_read */
	resident: boolean;
	/** 必定读取（每轮）：落笔前受理门强制先 skill_read（制造停顿=死磕燃料）；与 resident 互斥 */
	everyBeat: boolean;
	body: string;
	/** 存储目录名（skills/<dir>/SKILL.md；编辑器按它定位文件，通常与 name 一致） */
	dir?: string;
}

/**
 * 扫描 skills/ 目录（M-R2 §4.C）。frontmatter 缺 name/description 的包跳过（不猜）；
 * 解析是死板的数据读取——内容全部署名归包作者，harness 零改写。
 */
export function scanSkillFiles(cwd: string): SkillFile[] {
	const root = join(cwd, "skills");
	if (!existsSync(root)) return [];
	const out: SkillFile[] = [];
	for (const dir of readdirSync(root, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		const file = join(root, dir.name, "SKILL.md");
		if (!existsSync(file)) continue;
		let raw = "";
		try {
			raw = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		// frontmatter: --- fence, key: value lines (no regex; line-based)
		const rawLines = raw.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
		if ((rawLines[0] ?? "").trim() !== "---") continue;
		const endIdx = rawLines.findIndex((l, i) => i > 0 && l.trim() === "---");
		if (endIdx < 0) continue;
		const meta = new Map<string, string>();
		for (const line of rawLines.slice(1, endIdx)) {
			const colon = line.indexOf(":");
			if (colon > 0) meta.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
		}
		const name = meta.get("name") ?? "";
		const description = meta.get("description") ?? "";
		if (!name || !description) continue;
		out.push({
			name,
			description: description.slice(0, 1024),
			resident: meta.get("resident") === "true",
			everyBeat: meta.get("每轮") === "true",
			body: rawLines.slice(endIdx + 1).join("\n").trim(),
			dir: dir.name,
		});
	}
	return out;
}

/** 装载一拍所需全部素材；卡缺失/损坏时抛错（引擎转告用户，不演） */
/**
 * 素材缓存（8/22）：按输入文件的 (mtime, size) 指纹缓存解析结果。
 *
 * **为什么值得**：本函数是「每拍现读」的——引擎里 7 个调用点（装配 1 处，
 * 外加每个工具依赖闭包各 1 处：searchLore / listLore / overlayOf / readCard / getSkill）。
 * 最贵的一步是整读并解析用户预设：狐神抚那份 5.1 MB，单次全量 ~27ms，
 * 一拍跑满 20 轮光这一件就 500ms+。会话「打开一次、新建一次」各触发一次全量装载，
 * 用户实测「加载太频繁」。
 *
 * **键**：全部输入文件的 (mtime, size)。文件新建/删除也算（不存在记 `-`），
 * 所以 `lorebook_write` 落 overlay、面板改预设、编辑器存 skill 都会在下一次调用时
 * 自动看到新内容——**没有任何调用方需要记得手动失效**（手动失效的通道必然被忘掉）。
 *
 * ⚠ 两条不进缓存：
 * 1. `resetDisplayTagExtras()` / `addHistoryStripTags()` 改的是 postprocess 的模块级注册表，
 *    扩展侧 session_start 也会重置它——**命中缓存时照样执行**，否则显示层标签随缓存漂移。
 * 2. `skillFiles` 每次现扫（scanSkillFiles ~0.4ms），skill 编辑器存盘立刻可见。
 *
 * ⚠ 不变量：**返回的对象不许被调用方原地改**（现在没人改：constantEntries/withAliases
 * 都是 map/filter 出新数组）。要改先复制。
 */
interface MaterialsCacheEntry {
	stamp: string;
	/** overlay 路径要卡名才推得出，缓存下来免得为算指纹再解析一次卡 */
	overlayFile: string;
	value: StageMaterials;
}
let materialsCache: { cwd: string; entry: MaterialsCacheEntry } | null = null;

/** 单文件指纹；不存在记 `-`（否则「删掉」会被当成「没变」） */
function fileStamp(abs: string): string {
	try {
		const s = statSync(abs);
		return `${s.mtimeMs}:${s.size}`;
	} catch {
		return "-";
	}
}

/** 除 overlay 外的全部输入指纹（overlay 单独拼，见 MaterialsCacheEntry.overlayFile） */
function inputStamp(cwd: string, config: RpConfig): string {
	const parts = [fileStamp(resolveConfigPath(cwd)), fileStamp(resolvePath(cwd, config.card))];
	for (const rel of mountedLorebookPaths(config)) parts.push(fileStamp(resolvePath(cwd, rel)));
	parts.push(fileStamp(join(cwd, ".liyuan", "preset-override.json")));
	parts.push(fileStamp(config.preset ? resolvePath(cwd, config.preset) : join(cwd, "presets", "默认.json")));
	// disabledLore 住在 config 里，已被 config 指纹覆盖
	return parts.join("|");
}

export function loadStageMaterials(cwd: string): StageMaterials {
	const config = loadStageConfig(cwd);

	// 缓存命中：指纹一致即内容一致。副作用与 skill 扫描照常走（见上方 ⚠）。
	const cached = materialsCache?.cwd === cwd ? materialsCache.entry : null;
	if (cached) {
		const stamp = `${inputStamp(cwd, config)}|${fileStamp(cached.overlayFile)}`;
		if (stamp === cached.stamp) {
			resetDisplayTagExtras();
			if (cached.value.presetDoc) addHistoryStripTags(FORMAT_STACK_TAGS);
			return { ...cached.value, skillFiles: scanSkillFiles(cwd) };
		}
	}

	const cardAbs = resolvePath(cwd, config.card);
	const card = loadCardFile(cardAbs);
	// 卡原文（含 extensions.regex_scripts）：显示/送模两侧与 cardfront 快照同源
	const cardRegexScripts = (() => {
		try {
			return extractRegexScripts(readCardRawJson(cardAbs).raw);
		} catch {
			return [];
		}
	})();

	// 世界书：已挂载独立书（0..N）+ 补充设定集 overlay；卡内 character_book 不自动进上下文
	const fileGroups: LorebookEntry[][] = [];
	for (const rel of mountedLorebookPaths(config)) {
		const abs = resolvePath(cwd, rel);
		if (existsSync(abs)) fileGroups.push(loadLorebookFile(abs));
	}
	const fileEntries = mergeEntries(...fileGroups);
	const overlayFile = overlayPathFor(cwd, card.name);
	const overlayEntries = existsSync(overlayFile) ? loadLorebookFile(overlayFile) : [];
	// 用户级停用 → 外部插件协议判死（M-C2）。协议条目是 H 类「脑内 harness」：
	// 指望酒馆插件解析的输出格式强制令，梨园无解析器且原生 world_state_update 已覆盖其功能，
	// 留着只会与 draft_write「纯剧情文字」互斥（实测首拍 31% 思考 + 正文污染 + 双份记账）。
	const protocolFiltered = stripProtocolEntries(
		applyDisabledLore(mergeEntries(fileEntries, overlayEntries), config.disabledLore),
	);
	const entries = protocolFiltered.entries;
	const protocolDrops = protocolFiltered.dropped;

	// 预设：工作草稿（preset-override.json）优先，与预设页签热编辑一致。落盘即原文，这里只读不转换。
	const readDoc = (abs: string, name: string): PresetDoc | null => {
		if (!existsSync(abs)) return null;
		try {
			return loadPresetDoc(JSON.parse(readFileSync(abs, "utf8")), name);
		} catch {
			return null;
		}
	};
	let presetDoc: PresetDoc | null = null;
	if (config.preset) {
		const name = (config.preset.split(/[\\/]/).pop() ?? config.preset).replace(/\.json$/i, "");
		presetDoc =
			readDoc(join(cwd, ".liyuan", "preset-override.json"), name) ?? readDoc(resolvePath(cwd, config.preset), name);
	} else {
		// §4.A 默认预设：文风兜底迁出源码，数据发行（presets/默认.json，用户可见可改可换）。
		// 只在没有用户预设时装；用户预设在场完全不装（不叠加）。
		presetDoc = readDoc(join(cwd, "presets", "默认.json"), "默认");
	}

	// marker 材料：梨园按酒馆的槽位交货，**位置由预设作者的 prompt_order 决定**。
	// 填的是原文——包装（标题/小节名）归预设作者，梨园不替他们加话（铁律一）。
	const macroCtx = { charName: card.name, userName: config.userName };
	const markerMaterials: MarkerMaterials = {};
	const putSlot = (slot: keyof MarkerMaterials, text: string | undefined): void => {
		if (text && text.trim()) markerMaterials[slot] = applyMacros(text, macroCtx);
	};
	putSlot("charDescription", card.description);
	putSlot("charPersonality", card.personality);
	putSlot("scenario", card.scenario);
	putSlot("dialogueExamples", card.mesExample);
	putSlot("personaDescription", config.userPersona);
	// 梨园的 LorebookEntry 没有 ST 的 before/after position，常驻条目整份交 worldInfoBefore
	const constantLore = constantEntries(entries);
	if (constantLore.length > 0) {
		putSlot(
			"worldInfoBefore",
			constantLore.map((e) => `- ${e.comment ? `【${e.comment}】` : ""}${e.content}`).join("\n"),
		);
	}

	// 装配：模拟酒馆引擎按开关拼一次。历史后段每拍重装（{{lastusermessage}}），此处只取静态面。
	const assembled = presetDoc
		? assemble(presetDoc.entries, { materials: markerMaterials, charName: card.name, userName: config.userName })
		: null;
	const presetBefore = assembled?.before ?? [];
	const presetDepth = assembled?.depth ?? [];
	const declaredMarkers = new Set((assembled?.markers ?? []).map((mk) => mk.id));
	const presetAssembly = assembled?.report ?? [];
	const presetRuleTexts = presetBefore.filter((p) => p.source === "block").map((p) => p.text);
	const presetActive = !!assembled && assembled.before.length + assembled.after.length + assembled.depth.length > 0;
	const unsupported = new Set(assembled?.unsupported ?? []);

	// 显示层折叠标签：**猜名单已退役（8/19）**。
	//
	// 原本这里扫预设正文、猜「哪些标签是思维链脚手架」，猜中的登记成 fold ⇒ 显示层整块删。
	// 实测它对狐神抚预设猜出 11 个：`draft fox_front fox_front_insert fox-front-view`
	// **`content`** `ft_clock Fox正文前思考 think html head meta`——其中 `content` 正是
	// 作者装**正文**的标签，于是每一拍的正文都被梨园自己整块删掉（用户实测「正文被删」的
	// 真因，与作者正则无关）；`html/head/meta` 更说明这类猜测的污染面。
	//
	// 铁律三：识别「别人发明的名字」的名单只许冻结、收缩、删除。折不折叠归作者的
	// regex_scripts（本预设自带：depth≤2 做成思维链卡、depth≥3 整块删），梨园不猜。
	// 名称模式 FOLD_NAME_RE 仍在（thinking/draft/思考… 那批公有名，冻结不动）。
	//
	// 格式栈标签（catsay/w2g…）仍只注册到**历史剥**通道——它们是用户要看的产出，
	// 混进 extraFold 会让显示层连内容一起删（8/05：模型写了咪咪点评，屏上没有）。
	resetDisplayTagExtras();
	if (presetDoc) {
		addHistoryStripTags(FORMAT_STACK_TAGS);
	}

	const materials: StageMaterials = {
		config,
		card,
		entries,
		presetDoc,
		presetBefore,
		presetDepth,
		declaredMarkers,
		skillFiles: scanSkillFiles(cwd),
		presetAssembly,
		presetRuleTexts,
		markerMaterials,
		presetActive,
		macroWarnings: [...unsupported],
		protocolDrops,
		// 送模侧作者正则：预设 + 卡（与 cardfront 显示侧同源；promptOnly/破坏性规则）
		promptRules: promptRules([...(presetDoc?.raw?.extensions?.regex_scripts ?? []), ...cardRegexScripts]),
	};

	// 指纹在**装载之后**取：装载期间若有人改文件，这次算出的指纹属于旧内容，
	// 下一次调用会因指纹不符重算（宁可多算一次，不可缓存一份读了一半的世界）。
	materialsCache = {
		cwd,
		entry: {
			stamp: `${inputStamp(cwd, config)}|${fileStamp(overlayFile)}`,
			overlayFile,
			value: materials,
		},
	};
	return materials;
}

/**
 * 历史后段每拍重装（{{lastusermessage}} 在此生效）。
 *
 * 整份重跑而不是"接着历史前段的变量表往下算"——酒馆每轮就是整份重拼，
 * 只重算后半段会让 `getvar` 看到的值与酒馆不一致。前半段字节稳定（除非块里用了
 * `{{lastusermessage}}`），前缀缓存不受影响。无预设或后段为空返回 undefined。
 */
export function assemblePresetAfter(m: StageMaterials, userText: string): AssembledPiece[] | undefined {
	if (!m.presetDoc) return undefined;
	const r = assemble(m.presetDoc.entries, {
		materials: m.markerMaterials,
		charName: m.card.name,
		userName: m.config.userName,
		userText,
	});
	return r.after.length > 0 ? r.after : undefined;
}

/** 常驻世界书条目（enabled+constant，按 order 排序）——system prompt 素材 */
export function constantLoreOf(m: StageMaterials): LorebookEntry[] {
	return constantEntries(m.entries);
}
