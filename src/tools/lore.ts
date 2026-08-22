/**
 * 世界书族工具（PLAN-RP-TOOLING M-D1 垂直切片）。
 *
 * 合一前 `lorebook_search` 有三份实现（stage / assistant / roleplay），底层都调同一个
 * `searchEntries`，**差的是语料与话术**。没有一份是另外两份的超集。
 *
 * 合一取法（2026-08-04 用户裁定）：
 *   - **语料差异归依赖注入**——`LoreDeps.entries()` 由各面自己提供。
 *     台上注入「世界书 + overlay + 外部插件协议剥离」；
 *     助手注入**原始**世界书（**不剥协议**——助手是诊断面，用户问「我的卡为什么带
 *     UpdateVariable」时它必须看得见那些条目；协议剥离是台上生成的需要，不是检索的需要）。
 *   - 中文别名增强（扩展侧 withAliases）依赖 LLM 侧生成+缓存，留后续里程碑。
 *   - **话术按面裁剪**：台上要「查不到＝未被写下，可自行创造」的授权与记账去向；
 *     助手要语料规模与命中回声（诊断口径）。二者住同一文件，不会再各自漂移。
 */

import { checkWriteGate } from "./gate.ts";
import { errText, intArg, strArg, type ToolResult, type ToolSpec } from "./registry.ts";

/** 命中条目的结构子集（不依赖 LorebookEntry 全形，便于离线单测） */
export interface LoreEntryLike {
	uid?: number;
	comment?: string;
	keys?: string[];
	content?: string;
	/** 常驻注入（列举/写入回执要报） */
	constant?: boolean;
	/** 是否启用；false = 被 disabledLore 停用（列举要标出来） */
	enabled?: boolean;
	/**
	 * 这条是 agent 自己写下的（住在补充设定集里）。缺省/false = 用户自己的世界书。
	 * 列举据此标「补充」——**标少数不标多数**：用户的书通常几十上百条，
	 * 给每一行挂个「用户的」等于纯噪声。
	 *
	 * agent 对两者都有改/删权限（2026-08-22 用户定案：「agent 就是应该有这些权限」）；
	 * 这个标记不是权限边界，是**份量提示**——删自己写的便签与删用户的原稿不是一回事。
	 */
	agentWritten?: boolean;
}

export interface LoreHitLike {
	entry: LoreEntryLike;
	score?: number;
}

export interface LoreDeps {
	/**
	 * 本面的检索语料 → 命中。limit 由工具传入（各面默认值不同，见 schema）。
	 * 语料范围是各面注入时的决定（见文件头），工具本身不关心条目从哪来。
	 */
	searchLore: (query: string, limit: number) => LoreHitLike[];
	/** 语料规模（助手诊断话术要报「共 N 条」）；未注入则不报 */
	loreSize?: () => number;

	// ---- 以下为 M-D2 世界书族补全；未注入则该工具不可用（各面按能力注册） ----

	/** 写一条正典；book 给出则写进那本世界书，缺省写补充设定集。返回 null＝内容重复未写入 */
	writeLore?: (input: {
		title: string;
		keys: string[];
		content: string;
		constant?: boolean;
		book?: string;
	}) => LoreEntryLike | null;
	/**
	 * 改一条条目（按指纹，寻址范围＝书单全部世界书 + 补充设定集）；null = 哪本里都没这条。
	 * 返回改后的条目、新指纹（改正文即换身份）与**改了哪本**。
	 * 宿主负责迁移 `config.disabledLore` 里的旧指纹——否则用户关掉的条目会静默复活。
	 */
	updateLore?: (
		fingerprint: string,
		patch: { title?: string; keys?: string[]; content?: string; constant?: boolean },
	) => { entry: LoreEntryLike; newFingerprint: string; path?: string } | null;
	/** 删一条条目（同一寻址）；null = 哪本里都没这条。返回被删条目与所在书 */
	deleteLore?: (fingerprint: string) => { entry: LoreEntryLike; path?: string } | null;
	/** 列举全部条目（含停用的——列举的意义正是让 agent 看见能启停什么） */
	listLore?: () => LoreEntryLike[];
	/** 书单 + 当前挂载状态（`lorebook_files`） */
	listBooks?: () => { books: Array<{ path: string; name: string; entryCount: number }>; mounted: string[] };
	/**
	 * 新建一本世界书，**连第一条一起写**并挂载；返回路径；null = 同名已存在。
	 *
	 * 为什么不给「建一本空书」：空书在本系统里根本不成立——书单按条目数过滤（0 条视为
	 * 「同目录混进来的卡/预设」而跳过），挂载校验也拒空书。于是空书既列不出也挂不上、
	 * 连 `writeLore` 的 book 参数都寻址不到它。建书就得建成可用的。
	 */
	createBook?: (
		name: string,
		first: { title: string; keys: string[]; content: string; constant?: boolean },
	) => { path: string; mounted: string[] } | null;
	/** 挂载/卸载一本；返回挂载后的完整列表；抛错 = 路径不是有效世界书 */
	mountBook?: (path: string, mounted: boolean) => string[];
	/** 按内容指纹启停；返回实际生效的条数 */
	toggleLore?: (fingerprints: string[], enabled: boolean) => number;
	/** 条目内容 → 指纹（启停的持久键；由调用方注入避免 src/tools 依赖 crypto） */
	fingerprint?: (content: string) => string;
	/** 本拍用户原文 + 门禁档位（写侧门禁判定用，见 gate.ts） */
	gate?: () => { lastUserText: string; creationMode?: "ask" | "silent" };
}

/** 台上默认命中数（一拍封顶 3 次检索，每次 3 条：控上下文预算） */
const STAGE_LIMIT = 3;
/** 助手默认命中数（诊断面要看得广，可调到 20） */
const ASSISTANT_LIMIT = 5;

/**
 * 命中格式化：`### 标题（关键词：…）\n正文`。
 *
 * 合一前三份的括号/分隔符各不相同（全角「（关键词：…）」/ 全角「（keys: …）」/ 半角「 (keys: …)」）。
 * 统一取台上那版：全角中文标签、顿号分隔、**无关键词时整段省略**（不留空括号）。
 */
function formatHits(hits: LoreHitLike[]): string {
	return hits
		.map((h) => {
			const title = h.entry.comment || h.entry.keys?.[0] || "条目";
			const keys = h.entry.keys?.length ? `（关键词：${h.entry.keys.join("、")}）` : "";
			return `### ${title}${keys}\n${h.entry.content ?? ""}`;
		})
		.join("\n\n");
}

export const lorebookSearch: ToolSpec<LoreDeps> = {
	name: "lorebook_search",
	domain: "lore",
	mode: "read",
	surfaces: ["stage", "assistant", "extension"],
	label: "检索世界书",
	description: (ctx) =>
		ctx.surface === "stage"
			? `检索设定集（世界书与补充设定集）：地点、族群、历史、人物、法术等设定细节。` +
				`正文将涉及你没有十足把握的世界细节时，先查再写——查不到才是「未被写下」，那时可自行创造并保持与既有事实一致。` +
				`用设定原文的语言检索（多为${ctx.language}或英文）。`
			: `检索本项目的世界书与补充设定集，用于诊断设定内容（含被台上按外部插件协议剥离的条目）。` +
				`用设定原文的语言检索（多为${ctx.language}或英文）。`,
	parameters: (ctx) => {
		const query = {
			type: "string",
			description:
				ctx.surface === "stage" ? "关键词（空格分隔），非整句问题" : "检索词（用世界书原文语言），关键词而非整句",
		};
		// 台上不开 limit：一拍检索配额有限，条数固定才好控上下文预算；助手是诊断面，放开。
		if (ctx.surface === "stage") {
			return { type: "object", properties: { query }, required: ["query"] };
		}
		return {
			type: "object",
			properties: {
				query,
				limit: { type: "number", description: `命中上限（默认 ${ASSISTANT_LIMIT}，最多 20）` },
			},
			required: ["query"],
		};
	},
	async run(args, deps, ctx): Promise<ToolResult> {
		const stage = ctx.surface === "stage";
		const query = strArg(args, "query");
		if (!query) return { text: "缺少 query 参数。" };

		const limit = stage ? STAGE_LIMIT : intArg(args, "limit", ASSISTANT_LIMIT, 1, 20);
		let hits: LoreHitLike[] = [];
		try {
			hits = deps.searchLore(query, limit);
		} catch (err) {
			// 不抛：告诉模型怎么往下走（台上继续演，助手报障）
			return {
				text: stage
					? `设定集检索失败：${errText(err)}。按已知事实继续写。`
					: `设定集检索失败：${errText(err)}`,
			};
		}

		if (hits.length === 0) {
			if (stage) {
				return {
					text: "设定集无命中——该细节尚未被写下。可自行创造，但须与既有事实一致（重要的创造会由场记记进账本）。",
					activity: `查设定「${query}」· 无命中`,
				};
			}
			const size = deps.loreSize?.();
			return {
				text: `（世界书${typeof size === "number" ? `共 ${size} 条，` : ""}未命中「${query}」）`,
				activity: `查设定「${query}」· 无命中`,
			};
		}

		return {
			text: formatHits(hits),
			activity: `查设定「${query}」· ${hits.length} 条`,
			details: { hits: hits.map((h) => ({ uid: h.entry.uid, score: h.score })) },
		};
	},
};

// ---------------- M-D2：写侧 + 列举 + 启停 ----------------

/**
 * 调用情境（D-T3）：用户明确说「把这条记下来/写进设定集」。
 * **不是**模型自己觉得该记就记——那是门禁挡的（gate.ts），也是描述里反复强调的。
 * 剧情进展归封笔后的场记旁路，此工具只收**世界设定**。
 */
export const lorebookWrite: ToolSpec<LoreDeps> = {
	name: "lorebook_write",
	domain: "lore",
	mode: "write",
	surfaces: ["stage", "assistant", "extension"],
	label: "写入设定集",
	description: () =>
		"把用户明确要求留存的世界设定（设定/规则/人物志）写进设定集：跨会话保留，此后 lorebook_search 可命中。" +
		"**仅在用户明确要求记录时调用**——不要自作主张写，也不要反问「要不要写下来」。" +
		"只收世界设定；剧情进展不归这里（自有去处）。内容重复会被拒绝。" +
		"缺省落在补充设定集；要写进某一本世界书就给 book（路径从 lorebook_files 取）。",
	parameters: () => ({
		type: "object",
		properties: {
			title: { type: "string", description: "条目标题，如「北境骨誓风俗」" },
			keys: {
				type: "array",
				items: { type: "string" },
				description: "检索关键词（中文与任何原文名都放进来，否则日后检索不到）",
			},
			content: { type: "string", description: "正典正文（简洁、陈述性、用剧情语言）" },
			constant: { type: "boolean", description: "true = 常驻注入（仅限全局关键事实，滥用会挤占上下文）" },
			book: { type: "string", description: "写进哪本世界书（路径从 lorebook_files 取）；缺省写补充设定集" },
		},
		required: ["title", "keys", "content"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.writeLore) return { text: "设定集未就绪（本会话尚未装载角色卡）。" };

		const title = strArg(args, "title");
		const content = strArg(args, "content");
		if (!title || !content) return { text: "缺少 title 或 content 参数。" };
		const keys = Array.isArray(args.keys)
			? args.keys.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim())
			: [];
		const book = strArg(args, "book");

		// 写入门禁（D-T4）：仅在用户本轮明确要求时放行
		const g = deps.gate?.();
		if (g) {
			const verdict = checkWriteGate({
				toolName: "lorebook_write",
				lastUserText: g.lastUserText,
				creationMode: g.creationMode,
			});
			if (!verdict.allow) return { text: verdict.reason, activity: "写设定 · 门禁拦下" };
		}

		let entry: LoreEntryLike | null;
		try {
			entry = deps.writeLore({ title, keys, content, constant: args.constant === true, ...(book ? { book } : {}) });
		} catch (err) {
			return { text: `写入设定集失败：${errText(err)}` };
		}
		if (!entry) return { text: "内容与已有条目重复，未写入。", activity: "写设定 · 重复跳过" };

		return {
			text:
				`已固化为正典：【${entry.comment}】关键词 ${entry.keys?.join("、") || "（无）"}` +
				`${entry.constant ? "（常驻注入）" : ""}${book ? `，写在 ${book}` : ""}。此后检索可命中，跨会话保留。`,
			activity: `写设定「${entry.comment}」`,
			details: { uid: entry.uid },
		};
	},
};

/**
 * 调用情境（M-D7）：写下去的那条错了/过时了——用户说「那条改一下」「不是这样的」。
 *
 * 与 `lorebook_toggle` 的分工：toggle 是**开关**，update 是**改内容**。
 * 寻址范围含用户自己的世界书（2026-08-22 用户定案：agent 就该有这些权限）——
 * 所以回执必须报**改了哪本**，用户翻记录时看得见动的是谁的文件。
 */
export const lorebookUpdate: ToolSpec<LoreDeps> = {
	name: "lorebook_update",
	domain: "lore",
	mode: "write",
	surfaces: ["stage", "assistant"],
	label: "修改设定集条目",
	description: () =>
		"改一条设定集条目（指纹从 lorebook_list 取）：标题/关键词/正文/常驻，只传要改的字段，没传的原样保留。" +
		"标了「补充」的是你自己写下的；没标的是用户自己的世界书，改它等于改用户的原稿。",
	parameters: () => ({
		type: "object",
		properties: {
			fingerprint: { type: "string", description: "要改的条目指纹（从 lorebook_list 取）" },
			title: { type: "string", description: "新标题" },
			keys: { type: "array", items: { type: "string" }, description: "新检索关键词（整组替换）" },
			content: { type: "string", description: "新正典正文（整段替换）" },
			constant: { type: "boolean", description: "是否常驻注入" },
		},
		required: ["fingerprint"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.updateLore) return { text: "本环境不支持修改设定集条目。" };

		const fingerprint = strArg(args, "fingerprint");
		if (!fingerprint) return { text: "缺少 fingerprint 参数（指纹从 lorebook_list 取）。" };

		const patch: { title?: string; keys?: string[]; content?: string; constant?: boolean } = {};
		const title = strArg(args, "title");
		if (title) patch.title = title;
		const content = strArg(args, "content");
		if (content) patch.content = content;
		if (Array.isArray(args.keys)) {
			patch.keys = args.keys.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim());
		}
		if (typeof args.constant === "boolean") patch.constant = args.constant;
		if (Object.keys(patch).length === 0) return { text: "没有要改的字段（title/keys/content/constant 至少给一个）。" };

		const g = deps.gate?.();
		if (g) {
			const verdict = checkWriteGate({
				toolName: "lorebook_update",
				lastUserText: g.lastUserText,
				creationMode: g.creationMode,
			});
			if (!verdict.allow) return { text: verdict.reason, activity: "改设定 · 门禁拦下" };
		}

		let r: { entry: LoreEntryLike; newFingerprint: string; path?: string } | null;
		try {
			r = deps.updateLore(fingerprint, patch);
		} catch (err) {
			return { text: `修改设定集条目失败：${errText(err)}` };
		}
		if (!r) {
			return {
				text: "哪本世界书里都没有这个指纹（条目可能已被改过——指纹随正文变，重新 lorebook_list 取一次）。",
				activity: "改设定 · 未命中",
			};
		}

		return {
			text:
				`已改【${r.entry.comment}】${r.path ? `（${r.path}）` : ""}` +
				`${patch.content ? `，正文已换，新指纹 ${r.newFingerprint}` : ""}。`,
			activity: `改设定「${r.entry.comment}」`,
			details: { fingerprint: r.newFingerprint, path: r.path },
		};
	},
};

/**
 * 调用情境（M-D7）：用户说「把那条设定删了」——写错的、重复的、后来推翻的。
 *
 * 删除与停用的分工：停用是**可逆开关**，删除是**从源文件里抹掉且没有备份**。
 * 所以描述里那句「拿不准就停用」不是客套，是这个工具唯一的安全网。
 */
export const lorebookDelete: ToolSpec<LoreDeps> = {
	name: "lorebook_delete",
	domain: "lore",
	mode: "write",
	surfaces: ["stage", "assistant"],
	label: "删除设定集条目",
	description: () =>
		"删掉一条设定集条目（指纹从 lorebook_list 取）。**仅在用户明确要求删除时调用**，" +
		"不要自作主张、也不要反问「要不要删」。直接改源文件、不可撤销：" +
		"没标「补充」的是用户自己的世界书；拿不准就用 lorebook_toggle 停用。",
	parameters: () => ({
		type: "object",
		properties: {
			fingerprint: { type: "string", description: "要删的条目指纹（从 lorebook_list 取）" },
		},
		required: ["fingerprint"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.deleteLore) return { text: "本环境不支持删除设定集条目。" };

		const fingerprint = strArg(args, "fingerprint");
		if (!fingerprint) return { text: "缺少 fingerprint 参数（指纹从 lorebook_list 取）。" };

		const g = deps.gate?.();
		if (g) {
			const verdict = checkWriteGate({
				toolName: "lorebook_delete",
				lastUserText: g.lastUserText,
				creationMode: g.creationMode,
			});
			if (!verdict.allow) return { text: verdict.reason, activity: "删设定 · 门禁拦下" };
		}

		let r: { entry: LoreEntryLike; path?: string } | null;
		try {
			r = deps.deleteLore(fingerprint);
		} catch (err) {
			return { text: `删除设定集条目失败：${errText(err)}` };
		}
		if (!r) {
			return {
				text: "哪本世界书里都没有这个指纹（条目可能已被改过——指纹随正文变，重新 lorebook_list 取一次）。",
				activity: "删设定 · 未命中",
			};
		}

		return {
			text: `已删除【${r.entry.comment}】${r.path ? `（${r.path}）` : ""}，此后检索不再命中。`,
			activity: `删设定「${r.entry.comment}」`,
			details: { path: r.path },
		};
	},
};

/**
 * 调用情境（D-T3）：模型想知道「这个世界里都写了些什么」——检索靠关键词命中，
 * 列举才答得了「有哪些条目」「哪些被停用了」。也是 lorebook_toggle 取指纹的入口。
 */
export const lorebookList: ToolSpec<LoreDeps> = {
	name: "lorebook_list",
	domain: "lore",
	mode: "read",
	surfaces: ["stage", "assistant"],
	label: "列举世界书条目",
	description: () =>
		"列举设定集的全部条目（标题/关键词/是否常驻/是否已停用/指纹），用于纵览有哪些设定、" +
		"或为 lorebook_toggle 取指纹。要查具体内容用 lorebook_search——本工具只给目录不给正文。",
	parameters: () => ({
		type: "object",
		properties: {
			keyword: { type: "string", description: "只列标题或关键词含此字样的条目（缺省列全部）" },
		},
		required: [],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.listLore || !deps.fingerprint) return { text: "本环境不支持列举世界书条目。" };

		let all: LoreEntryLike[];
		try {
			all = deps.listLore();
		} catch (err) {
			return { text: `列举设定集失败：${errText(err)}` };
		}

		const kw = strArg(args, "keyword").toLowerCase();
		const list = kw
			? all.filter(
					(e) =>
						(e.comment ?? "").toLowerCase().includes(kw) ||
						(e.keys ?? []).some((k) => k.toLowerCase().includes(kw)),
				)
			: all;

		if (list.length === 0) {
			return {
				text: kw ? `设定集共 ${all.length} 条，无标题/关键词含「${kw}」的条目。` : "设定集是空的。",
				activity: `列设定${kw ? `「${kw}」` : ""}· 0 条`,
			};
		}

		const fp = deps.fingerprint;
		const lines = list.map((e) => {
			// 「补充」= agent 自己写下的。**标少数**：用户的书动辄上百条，给每行挂个「用户的」是纯噪声。
			const marks = [e.constant ? "常驻" : "", e.enabled === false ? "**已停用**" : "", e.agentWritten ? "补充" : ""]
				.filter(Boolean)
				.join("·");
			const keys = e.keys?.length ? `关键词 ${e.keys.join("、")}` : "无关键词";
			return `- ${e.comment || e.keys?.[0] || "条目"}｜${keys}${marks ? `｜${marks}` : ""}｜指纹 ${fp(e.content ?? "")}`;
		});
		const head = kw ? `设定集含「${kw}」的条目 ${list.length}/${all.length} 条：` : `设定集共 ${list.length} 条：`;
		return {
			text: `${head}\n${lines.join("\n")}`,
			activity: `列设定${kw ? `「${kw}」` : ""}· ${list.length} 条`,
		};
	},
};

/**
 * 调用情境（D-T3）：某条设定与当前剧情/预设冲突，或用户说「别再用那条设定了」。
 *
 * ⚠ 复用 `config.disabledLore` 指纹通道——与 M-C2 的外部插件协议禁用是**同一机制**
 * （TOOLING M-D2 明示不得另起一套）。停用是**用户级**的：跨会话、跨卡保留。
 */
export const lorebookToggle: ToolSpec<LoreDeps> = {
	name: "lorebook_toggle",
	domain: "lore",
	mode: "write",
	surfaces: ["stage", "assistant"],
	label: "启停世界书条目",
	description: () =>
		"启用/停用设定集条目（按指纹，指纹从 lorebook_list 取）。停用后该条不再注入上下文、检索也不命中。" +
		"用于某条设定与当前剧情冲突、或用户要求弃用某条设定时。" +
		"**这是用户级的持久开关**（跨会话保留），不是本拍的临时忽略——拿不准就先问用户。",
	parameters: () => ({
		type: "object",
		properties: {
			fingerprints: {
				type: "array",
				items: { type: "string" },
				description: "要启停的条目指纹（从 lorebook_list 取），可多条",
			},
			enabled: { type: "boolean", description: "true = 启用，false = 停用" },
		},
		required: ["fingerprints", "enabled"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.toggleLore) return { text: "本环境不支持启停世界书条目。" };

		const fps = Array.isArray(args.fingerprints)
			? args.fingerprints.filter((f): f is string => typeof f === "string" && f.trim().length > 0).map((f) => f.trim())
			: [];
		if (fps.length === 0) return { text: "缺少 fingerprints 参数（指纹从 lorebook_list 取）。" };
		if (typeof args.enabled !== "boolean") return { text: "缺少 enabled 参数（true = 启用，false = 停用）。" };

		const enabled = args.enabled;
		let count: number;
		try {
			count = deps.toggleLore(fps, enabled);
		} catch (err) {
			return { text: `启停失败：${errText(err)}` };
		}
		const verb = enabled ? "启用" : "停用";
		return {
			text: `已${verb} ${count} 条设定（用户级持久开关，跨会话保留）。${enabled ? "" : "停用的条目不再注入上下文，检索也不会命中。"}`,
			activity: `${verb}设定 · ${count} 条`,
		};
	},
};

// ---------------- M-D7：书一级（列 / 建 / 挂载）----------------
//
// 此前整族只有「条目」一级——agent 能往补充设定集里塞条目，却看不见项目里有哪些书、
// 建不了新书、也换不了挂载。用户 2026-08-22 定案：「agent 竟然连新建世界书的权限都没有，
// 这根本是工具化失败了」。以下三件补齐书一级。

/**
 * 调用情境：动书之前先看有什么书——建书前查重名、挂载前取路径、
 * 用户问「我这儿都有哪些世界书 / 现在挂了哪几本」。
 */
export const lorebookFiles: ToolSpec<LoreDeps> = {
	name: "lorebook_files",
	domain: "lore",
	mode: "read",
	surfaces: ["stage", "assistant"],
	label: "列世界书文件",
	description: () =>
		"列出项目里的全部世界书文件（路径/书名/条目数）并标出当前挂载了哪几本。" +
		"挂载的书才会进上下文与检索。要看条目用 lorebook_list，要看内容用 lorebook_search。",
	parameters: () => ({ type: "object", properties: {}, required: [] }),
	async run(_args, deps): Promise<ToolResult> {
		if (!deps.listBooks) return { text: "本环境不支持列举世界书文件。" };

		let shelf: { books: Array<{ path: string; name: string; entryCount: number }>; mounted: string[] };
		try {
			shelf = deps.listBooks();
		} catch (err) {
			return { text: `列举世界书失败：${errText(err)}` };
		}
		if (shelf.books.length === 0) {
			return { text: "项目里还没有世界书文件（用 lorebook_create 建一本）。", activity: "列世界书 · 0 本" };
		}
		const on = new Set(shelf.mounted);
		const lines = shelf.books.map(
			(b) => `- ${b.name}｜${b.entryCount} 条｜${on.has(b.path) ? "**已挂载**" : "未挂载"}｜${b.path}`,
		);
		return {
			text: `共 ${shelf.books.length} 本世界书（挂载 ${shelf.mounted.length} 本）：\n${lines.join("\n")}`,
			activity: `列世界书 · ${shelf.books.length} 本`,
			details: { mounted: shelf.mounted },
		};
	},
};

/**
 * 调用情境：设定攒到该分家了——用户说「给这些单独建一本世界书」，
 * 或 agent 要把某个主题的正典从补充设定集里独立出来。
 *
 * **建书连第一条一起建，并直接挂上**。不给「建空书」这个动作：空书列不出（书单按条目数
 * 过滤）、挂不上（挂载校验拒空书）、也寻址不到（writeLore 的 book 只认书单里的路径）——
 * 建了等于没建。此后往这本里加条目走 `lorebook_write` 带 book。
 */
export const lorebookCreate: ToolSpec<LoreDeps> = {
	name: "lorebook_create",
	domain: "lore",
	mode: "write",
	surfaces: ["stage", "assistant"],
	label: "新建世界书",
	description: () =>
		"新建一本世界书并写入第一条，建好即挂载生效。用于把某个主题的设定单独立册。" +
		"此后往这本里加条目用 lorebook_write 传 book。同名已存在会被拒绝。",
	parameters: () => ({
		type: "object",
		properties: {
			name: { type: "string", description: "书名，如「北境志」（会成为文件名）" },
			title: { type: "string", description: "第一条的标题" },
			keys: { type: "array", items: { type: "string" }, description: "第一条的检索关键词" },
			content: { type: "string", description: "第一条的正文" },
			constant: { type: "boolean", description: "第一条是否常驻注入" },
		},
		required: ["name", "title", "keys", "content"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.createBook) return { text: "本环境不支持新建世界书。" };

		const name = strArg(args, "name");
		const title = strArg(args, "title");
		const content = strArg(args, "content");
		if (!name) return { text: "缺少 name 参数（书名）。" };
		if (!title || !content) return { text: "缺少 title 或 content（新书要连第一条一起建）。" };
		const keys = Array.isArray(args.keys)
			? args.keys.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim())
			: [];

		const g = deps.gate?.();
		if (g) {
			const verdict = checkWriteGate({
				toolName: "lorebook_create",
				lastUserText: g.lastUserText,
				creationMode: g.creationMode,
			});
			if (!verdict.allow) return { text: verdict.reason, activity: "建世界书 · 门禁拦下" };
		}

		let r: { path: string; mounted: string[] } | null;
		try {
			r = deps.createBook(name, { title, keys, content, constant: args.constant === true });
		} catch (err) {
			return { text: `新建世界书失败：${errText(err)}` };
		}
		if (!r) return { text: `已有同名世界书「${name}」，未新建。`, activity: "建世界书 · 重名跳过" };

		return {
			text: `已新建世界书「${name}」（${r.path}）并挂载，首条【${title}】已写入。往这本里再加条目：lorebook_write 传 book="${r.path}"。`,
			activity: `建世界书「${name}」`,
			details: { path: r.path, mounted: r.mounted },
		};
	},
};

/**
 * 调用情境：用户说「把那本书挂上／取下来」，或新建的书写完第一条之后要生效。
 *
 * 与 `lorebook_toggle` 的分工：toggle 管**单条**，mount 管**整本**。
 * 二者都是用户级持久开关——拿不准就先问用户，别自作主张换语料。
 */
export const lorebookMount: ToolSpec<LoreDeps> = {
	name: "lorebook_mount",
	domain: "lore",
	mode: "write",
	surfaces: ["stage", "assistant"],
	label: "挂载/卸载世界书",
	description: () =>
		"挂载或卸载一本世界书（路径从 lorebook_files 取）。挂载的书才进上下文与检索。" +
		"**这是用户级的持久开关**（跨会话保留），换的是整局的语料——拿不准就先问用户。" +
		"单条的启停用 lorebook_toggle。",
	parameters: () => ({
		type: "object",
		properties: {
			path: { type: "string", description: "世界书路径（从 lorebook_files 取）" },
			mounted: { type: "boolean", description: "true = 挂上，false = 卸下" },
		},
		required: ["path", "mounted"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.mountBook) return { text: "本环境不支持挂载世界书。" };

		const path = strArg(args, "path");
		if (!path) return { text: "缺少 path 参数（路径从 lorebook_files 取）。" };
		if (typeof args.mounted !== "boolean") return { text: "缺少 mounted 参数（true = 挂上，false = 卸下）。" };

		const mounted = args.mounted;
		let list: string[];
		try {
			list = deps.mountBook(path, mounted);
		} catch (err) {
			return { text: `${mounted ? "挂载" : "卸载"}失败：${errText(err)}` };
		}
		return {
			text: `已${mounted ? "挂载" : "卸载"}${path}。当前挂载 ${list.length} 本${list.length ? `：${list.join("、")}` : ""}。下一拍起生效。`,
			activity: `${mounted ? "挂载" : "卸载"}世界书`,
			details: { mounted: list },
		};
	},
};

/** 世界书族全部工具（M-D1 检索；M-D2 写/列/启停；M-D7 改删 + 书一级列建挂） */
export const loreTools: ToolSpec<LoreDeps>[] = [
	lorebookSearch,
	lorebookWrite,
	lorebookUpdate,
	lorebookDelete,
	lorebookList,
	lorebookToggle,
	lorebookFiles,
	lorebookCreate,
	lorebookMount,
];
