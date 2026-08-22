/**
 * 预设族工具（PLAN-RP-TOOLING M-D8）。
 *
 * `ToolDomain` 早就声明了 `"preset"`，但统一层里一件实现都没有——助手侧只有两件手写的
 * typebox 工具（`preset_read` / `preset_toggle`），本族把它们收编并补齐**创作**能力。
 *
 * ## 为什么必须工具化（2026-08-23 用户定案）
 *
 * 两条理由，都不是「补全清单」那种：
 * 1. **预设与梨园本来就不完全兼容**——预设是给酒馆引擎写的源码，梨园模拟它跑一遍。
 *    实际使用中撞上的不兼容，得让 agent 当场去改预设，而不是只能报告「这块有问题」。
 * 2. **有作者会想用梨园写预设**。那就不能只有「改已有块」，得能新建块、定位置、
 *    另存成新预设。`patchPresetRaw` 的 `add` 就是为这条补的。
 *
 * ## 位置就是语义（本族最要紧的一条）
 *
 * ST 预设里没有「system 段 / postHistory 段」这种字段——**块在 `chatHistory` 之前还是之后，
 * 就是它进 system 还是进历史末尾**。所以 `preset_write` 的 `before`/`after` 不是排版偏好，
 * 是「这块什么时候送达模型」。新建块时不指位置＝追加到末尾＝落在 chatHistory 之后。
 *
 * ## 为什么整族只在助手面
 *
 * 台上模型**每拍都在读整份预设**（装配产物 `presetBefore` 就是 system prompt 的主体），
 * 它不缺「看见预设」的通道；缺的是改。而让扮演中的模型改自己正在被驱动的那份预设，
 * 等于让它中途改写自己的剧本——出了问题连复现都难。改预设是诊断动作，归右栏。
 *
 * ## 草稿与落盘
 *
 * 改动默认只写**运行时草稿**（`.liyuan/preset-override.json`），下一拍即生效但不动用户的
 * 预设文件；`preset_save` 才落盘。这是面板既有的两段式，工具沿用同一套，
 * 免得「agent 改了预设，用户在面板点撤销却撤不掉」。
 */

import { errText, intArg, strArg, type ToolResult, type ToolSpec } from "./registry.ts";

/** 块视图子集（不依赖 preset-doc.ts 全形，便于离线单测） */
export interface PresetBlockLike {
	id: string;
	name: string;
	role: string;
	enabled: boolean;
	/** 酒馆内置槽位（Chat History / Char Description…）：占位，内容不可编辑 */
	marker: boolean;
	/** 派生：相对 chatHistory 的前后 */
	channel: "system" | "postHistory";
	depth?: number;
	chars: number;
	content?: string;
}

export interface PresetInfoLike {
	name: string;
	kind: string;
	samplers: Record<string, number>;
	blocks: PresetBlockLike[];
	/** 有未保存草稿 */
	dirty: boolean;
}

export interface PresetDeps {
	/** 当前生效预设（含未保存草稿）；null = 未配置预设 */
	readPreset?: () => PresetInfoLike | null;
	/** 预设库：全部预设文件 + 当前用的是哪份 */
	listPresets?: () => { presets: Array<{ file: string; name: string }>; active: string | null };
	/** 打补丁到**运行时草稿**（不落盘）；返回改动后的块数 */
	writePreset?: (patch: {
		blocks?: Array<{ id: string; name?: string; content?: string; enabled?: boolean; remove?: boolean }>;
		add?: Array<{
			id?: string;
			name: string;
			content: string;
			role?: string;
			enabled?: boolean;
			before?: string;
			after?: string;
			depth?: number;
		}>;
		samplers?: Record<string, number>;
	}) => { blocks: number; added: string[] };
	/** 草稿落盘（true）或丢弃草稿（false） */
	savePreset?: (save: boolean) => void;
	/** 新建一份空白预设并选用；返回相对路径；null = 同名已存在 */
	createPreset?: (name: string) => { file: string } | null;
	/** 另存当前预设（含草稿）为新文件；null = 同名已存在 */
	saveAsPreset?: (name: string) => { file: string } | null;
	/** 切换到某份预设（file 从 preset_list 取）；false = 文件不存在 */
	selectPreset?: (file: string | null) => boolean;
}

const roleMark = (b: PresetBlockLike): string => (b.role && b.role !== "system" ? `·${b.role}` : "");

/**
 * 调用情境：诊断「模型为什么这么输出」的第一步，或改块之前先取 id。
 *
 * 给 id 才给正文——预设动辄几百块、几 MB，整份倒出来会把助手自己的上下文撑爆。
 */
export const presetRead: ToolSpec<PresetDeps> = {
	name: "preset_read",
	domain: "preset",
	mode: "read",
	surfaces: ["assistant"],
	label: "读预设",
	description: () =>
		"读当前生效的预设：块清单（id/名称/角色/开关/所在通道/字数）与采样参数。给 id 则返回那一块的全文。" +
		"通道 system = 排在 chatHistory 之前（进系统提示词），postHistory = 排在它之后（贴在历史末尾）。" +
		"标了「槽位」的是酒馆内置占位（角色卡描述、聊天历史等），只有位置没有内容。",
	parameters: () => ({
		type: "object",
		properties: {
			id: { type: "string", description: "块 id（给出则返回该块全文）" },
			keyword: { type: "string", description: "只列名称含此字样的块（缺省列全部）" },
		},
		required: [],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.readPreset) return { text: "本环境不支持读预设。" };

		let info: PresetInfoLike | null;
		try {
			info = deps.readPreset();
		} catch (err) {
			return { text: `读预设失败：${errText(err)}` };
		}
		if (!info) return { text: "当前未配置预设文件（用 preset_list 看有哪些，config_write 换用）。" };

		const id = strArg(args, "id");
		if (id) {
			const b = info.blocks.find((x) => x.id === id);
			if (!b) return { text: `找不到预设块：${id}（用不带参数的 preset_read 取 id）。` };
			if (b.marker) {
				return { text: `「${b.name}」（id=${b.id}）是酒馆内置槽位，只有位置没有内容——它声明的是「${b.name}这类材料插在这里」。` };
			}
			return {
				text: `「${b.name}」（id=${b.id}，${b.channel}${roleMark(b)}${b.depth !== undefined ? `，深度 ${b.depth}` : ""}，${b.enabled ? "启用" : "停用"}）\n\n${b.content ?? ""}`,
				activity: `读预设块「${b.name}」`,
			};
		}

		const kw = strArg(args, "keyword").toLowerCase();
		const list = kw ? info.blocks.filter((b) => b.name.toLowerCase().includes(kw)) : info.blocks;
		if (list.length === 0) {
			return { text: kw ? `预设「${info.name}」共 ${info.blocks.length} 块，无名称含「${kw}」的。` : `预设「${info.name}」没有任何块。` };
		}
		const lines = list.map(
			(b) =>
				`- [${b.enabled ? "开" : "关"}] ${b.id}「${b.name}」｜${b.marker ? "槽位" : b.channel}${roleMark(b)}` +
				`${b.depth !== undefined ? `｜深度 ${b.depth}` : ""}｜${b.chars} 字`,
		);
		const head = `预设「${info.name}」（${info.kind}${info.dirty ? "，**含未保存草稿**" : ""}）${kw ? ` 含「${kw}」的 ${list.length}/${info.blocks.length} 块` : ` 共 ${list.length} 块`}：`;
		return {
			text: `${head}\n${lines.join("\n")}\n采样参数：${JSON.stringify(info.samplers)}`,
			activity: `读预设 · ${list.length} 块`,
		};
	},
};

/**
 * 调用情境：诊断要换预设比对，或用户问「我有哪些预设」。
 */
export const presetList: ToolSpec<PresetDeps> = {
	name: "preset_list",
	domain: "preset",
	mode: "read",
	surfaces: ["assistant"],
	label: "列出预设库",
	description: () =>
		"列出预设库里的全部预设文件并标出当前用的是哪份。换用某份请调 preset_select。",
	parameters: () => ({ type: "object", properties: {}, required: [] }),
	async run(_args, deps): Promise<ToolResult> {
		if (!deps.listPresets) return { text: "本环境不支持列举预设库。" };

		let r: { presets: Array<{ file: string; name: string }>; active: string | null };
		try {
			r = deps.listPresets();
		} catch (err) {
			return { text: `列举预设失败：${errText(err)}` };
		}
		if (r.presets.length === 0) return { text: "预设库是空的（用 preset_create 新建一份）。", activity: "列预设 · 0 份" };
		const lines = r.presets.map((p) => `- ${p.name}${p.file === r.active ? "｜**当前**" : ""}｜${p.file}`);
		return {
			text: `预设库 ${r.presets.length} 份：\n${lines.join("\n")}${r.active ? "" : "\n（当前未使用任何预设）"}`,
			activity: `列预设 · ${r.presets.length} 份`,
		};
	},
};

/**
 * 调用情境（M-D8）：改一块的正文/名称/开关、删一块、加一块、调采样参数。
 *
 * 一件工具吃下整份补丁而不是拆成 write/toggle/add/remove 四件——它们改的是同一份文档，
 * 拆开会让「把这块内容挪到 chatHistory 之后」这种一次成型的编辑变成三次往返。
 */
export const presetWrite: ToolSpec<PresetDeps> = {
	name: "preset_write",
	domain: "preset",
	mode: "write",
	surfaces: ["assistant"],
	label: "改预设",
	description: () =>
		"改当前预设：blocks 改已有块（正文/名称/开关，remove=true 整块删），add 加新块，samplers 调采样参数。" +
		"**只写运行时草稿，下一拍即生效但不动预设文件**——满意了调 preset_save 落盘，不满意 preset_save(save=false) 丢弃。" +
		"加新块时 before/after 决定它排在哪：排在 chatHistory 之前进系统提示词，之后则贴在历史末尾；" +
		"给了 depth 则改为按深度插进历史中间。改动较大时先跟用户确认。",
	parameters: () => ({
		type: "object",
		properties: {
			blocks: {
				type: "array",
				description: "要改的已有块（id 从 preset_read 取）",
				items: {
					type: "object",
					properties: {
						id: { type: "string", description: "块 id" },
						name: { type: "string", description: "新名称" },
						content: { type: "string", description: "新正文（整块替换）" },
						enabled: { type: "boolean", description: "启用/停用" },
						remove: { type: "boolean", description: "true = 从预设里整块删除" },
					},
					required: ["id"],
				},
			},
			add: {
				type: "array",
				description: "要新增的块",
				items: {
					type: "object",
					properties: {
						name: { type: "string", description: "块名称" },
						content: { type: "string", description: "块正文" },
						role: { type: "string", enum: ["system", "user", "assistant"], description: "消息角色，缺省 system" },
						before: { type: "string", description: "插在这个块之前（id）" },
						after: { type: "string", description: "插在这个块之后（id）" },
						depth: { type: "number", description: "改为按深度插进历史（0=最新一条之后）；给了它就不看 before/after" },
						enabled: { type: "boolean", description: "缺省 true" },
					},
					required: ["name", "content"],
				},
			},
			samplers: { type: "object", description: "采样参数，如 {\"temperature\":0.9}" },
		},
		required: [],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.writePreset) return { text: "本环境不支持改预设。" };

		const blocks = Array.isArray(args.blocks)
			? (args.blocks.filter((b) => b && typeof b === "object" && typeof (b as { id?: unknown }).id === "string") as Array<{
					id: string;
					name?: string;
					content?: string;
					enabled?: boolean;
					remove?: boolean;
				}>)
			: [];
		const add = Array.isArray(args.add)
			? (args.add.filter(
					(b) =>
						b &&
						typeof b === "object" &&
						typeof (b as { name?: unknown }).name === "string" &&
						typeof (b as { content?: unknown }).content === "string",
				) as Array<{ name: string; content: string; role?: string; enabled?: boolean; before?: string; after?: string; depth?: number }>)
			: [];
		const samplers =
			args.samplers && typeof args.samplers === "object" && !Array.isArray(args.samplers)
				? (args.samplers as Record<string, number>)
				: undefined;
		if (blocks.length === 0 && add.length === 0 && !samplers) {
			return { text: "没有要改的东西（blocks / add / samplers 至少给一样）。" };
		}

		let r: { blocks: number; added: string[] };
		try {
			r = deps.writePreset({ ...(blocks.length ? { blocks } : {}), ...(add.length ? { add } : {}), ...(samplers ? { samplers } : {}) });
		} catch (err) {
			return { text: `改预设失败：${errText(err)}` };
		}
		const parts = [
			r.blocks ? `改了 ${r.blocks} 块` : "",
			r.added.length ? `新增 ${r.added.length} 块（id ${r.added.join("、")}）` : "",
			samplers ? "调了采样参数" : "",
		].filter(Boolean);
		return {
			text: `${parts.join("，")}。**这是运行时草稿**：下一拍即生效，但预设文件还没动——满意了调 preset_save 落盘。`,
			activity: `改预设 · ${parts.join("，")}`,
			details: { added: r.added },
		};
	},
};

/**
 * 调用情境：草稿验证过了要留下（save=true），或试坏了要退回（save=false）。
 */
export const presetSave: ToolSpec<PresetDeps> = {
	name: "preset_save",
	domain: "preset",
	mode: "write",
	surfaces: ["assistant"],
	label: "保存/丢弃预设草稿",
	description: () =>
		"把 preset_write 的运行时草稿落盘到预设文件（save=true），或整份丢弃退回磁盘版本（save=false）。" +
		"落盘会覆盖用户的预设文件——**改动大时先让用户看过再存**；想留退路就先 preset_saveas 另存一份。",
	parameters: () => ({
		type: "object",
		properties: { save: { type: "boolean", description: "true = 落盘，false = 丢弃草稿" } },
		required: ["save"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.savePreset) return { text: "本环境不支持保存预设。" };
		if (typeof args.save !== "boolean") return { text: "缺少 save 参数（true = 落盘，false = 丢弃草稿）。" };
		try {
			deps.savePreset(args.save);
		} catch (err) {
			return { text: `${args.save ? "保存" : "丢弃"}预设草稿失败：${errText(err)}` };
		}
		return args.save
			? { text: "草稿已落盘，预设文件已更新。", activity: "保存预设" }
			: { text: "草稿已丢弃，预设退回磁盘版本。", activity: "丢弃预设草稿" };
	},
};

/**
 * 调用情境：用户要**用梨园写一份新预设**，或要在现有预设上分叉一版来试。
 *
 * 新预设是可用的最小骨架：一个主提示词块 + chatHistory 槽位。
 * 没有 chatHistory 槽位的预设，历史无处可插——所以骨架里必须有它。
 */
export const presetCreate: ToolSpec<PresetDeps> = {
	name: "preset_create",
	domain: "preset",
	mode: "write",
	surfaces: ["assistant"],
	label: "新建预设",
	description: () =>
		"新建一份空白预设并立即选用。骨架＝一个主提示词块 + 聊天历史槽位，之后用 preset_write 往里加块。" +
		"要在现有预设上分叉一版，用 preset_saveas（连当前草稿一起另存）。同名已存在会被拒绝。",
	parameters: () => ({
		type: "object",
		properties: { name: { type: "string", description: "预设名（会成为文件名）" } },
		required: ["name"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.createPreset) return { text: "本环境不支持新建预设。" };
		const name = strArg(args, "name");
		if (!name) return { text: "缺少 name 参数（预设名）。" };
		let r: { file: string } | null;
		try {
			r = deps.createPreset(name);
		} catch (err) {
			return { text: `新建预设失败：${errText(err)}` };
		}
		if (!r) return { text: `已有同名预设「${name}」，未新建。`, activity: "建预设 · 重名跳过" };
		return {
			text: `已新建预设「${name}」（${r.file}）并选用。现在只有主提示词块与聊天历史槽位——用 preset_write 的 add 往里加块。`,
			activity: `建预设「${name}」`,
			details: { file: r.file },
		};
	},
};

/**
 * 调用情境：改之前先留一份退路，或把调好的一版命名固定下来。
 */
export const presetSaveAs: ToolSpec<PresetDeps> = {
	name: "preset_saveas",
	domain: "preset",
	mode: "write",
	surfaces: ["assistant"],
	label: "另存预设",
	description: () =>
		"把当前预设（含未保存草稿）整份另存为新预设文件。用于改动前留退路、或把调好的一版固定下来。" +
		"另存**不切换**当前使用的预设，要切换用 preset_select。同名已存在会被拒绝。",
	parameters: () => ({
		type: "object",
		properties: { name: { type: "string", description: "新预设名（会成为文件名）" } },
		required: ["name"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.saveAsPreset) return { text: "本环境不支持另存预设。" };
		const name = strArg(args, "name");
		if (!name) return { text: "缺少 name 参数（新预设名）。" };
		let r: { file: string } | null;
		try {
			r = deps.saveAsPreset(name);
		} catch (err) {
			return { text: `另存预设失败：${errText(err)}` };
		}
		if (!r) return { text: `已有同名预设「${name}」，未另存。`, activity: "另存预设 · 重名跳过" };
		return { text: `已另存为「${name}」（${r.file}）。当前使用的预设未变。`, activity: `另存预设「${name}」`, details: { file: r.file } };
	},
};

/**
 * 调用情境：换用另一份预设做对照，或用户说「换回原来那个预设」。
 *
 * ⚠ 换预设会**丢弃未保存的草稿**（与面板同一语义）——有草稿时先问用户要不要 preset_save。
 */
export const presetSelect: ToolSpec<PresetDeps> = {
	name: "preset_select",
	domain: "preset",
	mode: "write",
	surfaces: ["assistant"],
	label: "切换预设",
	description: () =>
		"换用另一份预设（file 从 preset_list 取），传空则不使用任何预设。" +
		"**会丢弃未保存的草稿**，且换的是整局的输出形态——只在用户明确要求时调用，有草稿时先问要不要保存。",
	parameters: () => ({
		type: "object",
		properties: { file: { type: "string", description: "预设文件路径（从 preset_list 取）；空串 = 不用预设" } },
		required: [],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.selectPreset) return { text: "本环境不支持切换预设。" };
		const file = strArg(args, "file");
		let ok: boolean;
		try {
			ok = deps.selectPreset(file || null);
		} catch (err) {
			return { text: `切换预设失败：${errText(err)}` };
		}
		if (!ok) return { text: `预设文件不存在：${file}（用 preset_list 重取路径）。` };
		return file
			? { text: `已切换到预设 ${file}，下一拍起生效（未保存的草稿已丢弃）。`, activity: "换预设" }
			: { text: "已改为不使用任何预设，下一拍起生效。", activity: "停用预设" };
	},
};

/** 预设族全部工具（M-D8：读/列/改/存/建/另存/切换） */
export const presetTools: ToolSpec<PresetDeps>[] = [
	presetRead,
	presetList,
	presetWrite,
	presetSave,
	presetCreate,
	presetSaveAs,
	presetSelect,
];
