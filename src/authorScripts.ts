/**
 * 作者运行时脚本（酒馆助手「脚本库」）——梨园从未消费过的第三条作者前端通道。
 *
 * 前两条已经在跑：`extensions.regex_scripts`（显示正则 → cardfront）、MVU 的
 * `[initvar]`/`<UpdateVariable>`（数据 → src/mvu.ts）。这一条是**运行时**：
 * 卡与预设可以在 `extensions.{TavernHelper,tavern_helper}.scripts[]` 里带 JS，
 * 酒馆助手把它们跑在一个子 iframe 里，脚本再往**父页** body 挂自己的 UI。
 * 那就是「悬浮球」的由来——它不是消息里的一段 HTML，而是页面级常驻 DOM。
 *
 * 为什么必须是独立通道而不是复用消息帧：消息帧的 iframe 在气泡里，`position:fixed`
 * 锚的是那个气泡盒子——球会随消息滚走、被盒子裁掉。作者写的坐标（`right:20px`
 * `bottom:20px` 之类）只有在**页面级**才有意义。
 *
 * 判据只认生态发行的协议形状（一个声明数组 + `enabled` 标志），**不认任何作者措辞**：
 * 不问脚本叫什么名字、不猜它是不是悬浮球、不列卡名。声明了就跑，没声明就没有——
 * 与 protocol-detect 认 `<UpdateVariable>`、mvu 认 `[initvar]`、frameDoc 认 HTML
 * 规范根元素同一路子（铁律三给的替代：声明落成数据，harness 死板执行）。
 *
 * 本地语料实测（14 卡 / 12 预设）：15 条唯一声明全部 `enabled`，其中 4 条是页面级 UI
 * （2 个悬浮球、1 个悬浮窗、1 组全屏面板），11 条是幕后逻辑（注册变量结构、状态约束、
 * 阶段路由、正则操作等）。字段形状统一为
 * `{id,name,type,content,enabled,button,data,info,export_with}`。
 */

/** 一条作者脚本（只带宿主要用的字段；button/data/info 暂不消费，别在数据里画没接线的口子） */
export interface AuthorScript {
	/** 作者给的稳定 id（用于宿主端去重与日志；缺失时由 source+序号兜底） */
	id: string;
	/** 作者给的名字（只进日志与调试面，不作任何判据） */
	name: string;
	/** JS 源码，原样交给宿主帧执行 */
	content: string;
	/** 来源：预设自带还是卡自带（顺序与冲突排查用） */
	source: "preset" | "card";
}

/** ST 的 extensions 位置有两处：卡是 `data.extensions`，预设是顶层 `extensions`（与 regex_scripts 同例） */
function extensionsOf(raw: Record<string, unknown>): Record<string, unknown> {
	const data = raw.data && typeof raw.data === "object" ? (raw.data as Record<string, unknown>) : raw;
	const ext = data.extensions && typeof data.extensions === "object" ? (data.extensions as Record<string, unknown>) : {};
	return ext;
}

/**
 * 取出声明数组。命名空间两种写法都认——**这不是名单，是同一个插件的两种历史拼写**：
 * 实测卡侧写 `TavernHelper`、预设侧写 `tavern_helper`，同一份数据同一种形状。
 */
function scriptsArrayOf(raw: Record<string, unknown>): unknown[] {
	const ext = extensionsOf(raw);
	for (const key of ["TavernHelper", "tavern_helper"]) {
		const ns = ext[key];
		if (!ns || typeof ns !== "object") continue;
		const list = (ns as Record<string, unknown>).scripts;
		if (Array.isArray(list)) return list;
	}
	return [];
}

/**
 * 一份原文 → 该来源的脚本清单。
 * `enabled === false` 一律跳过（作者停用就是对用户停用，与世界书条目同义）；
 * 空 content 跳过（占位条目）。解析永不抛：坏声明只是少一条脚本，不许拖垮整张卡。
 */
export function extractAuthorScripts(
	raw: Record<string, unknown> | null | undefined,
	source: AuthorScript["source"],
): AuthorScript[] {
	if (!raw || typeof raw !== "object") return [];
	const out: AuthorScript[] = [];
	const list = scriptsArrayOf(raw);
	for (const [i, item] of list.entries()) {
		if (!item || typeof item !== "object") continue;
		const s = item as Record<string, unknown>;
		if (s.enabled === false) continue;
		const content = typeof s.content === "string" ? s.content : "";
		if (!content.trim()) continue;
		const id = typeof s.id === "string" && s.id.trim() ? s.id : `${source}-${i}`;
		out.push({
			id,
			name: typeof s.name === "string" ? s.name : "",
			content,
			source,
		});
	}
	return out;
}

export function buildAuthorScripts(
	cardRaw: Record<string, unknown> | null | undefined,
	presetRaw: Record<string, unknown> | null | undefined,
): AuthorScript[] {
	const merged = [...extractAuthorScripts(presetRaw, "preset"), ...extractAuthorScripts(cardRaw, "card")];
	const seen = new Set<string>();
	const out: AuthorScript[] = [];
	for (const s of merged) {
		const key = `${s.source}:${s.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(s);
	}
	return out;
}

/**
 * 清单指纹：够前端判断「这批脚本变没变」，又不带正文（正文可达数 MB）。
 * 与 ScriptHost 里那个 generation 同一形状同一算法——**必须共用一份**：
 * 两处各算一遍，迟早出现「服务端说变了、前端算出没变」的对不上。
 */
export function authorScriptSig(
	scripts: Array<{ id: string; source: string; content?: string; len?: number }>,
): string {
	return scripts.map((s) => `${s.source}:${s.id}:${s.len ?? s.content?.length ?? 0}`).join("|");
}

/** hello 帧用的轻清单（无正文，只够算指纹） */
export function authorScriptManifest(
	scripts: AuthorScript[],
): Array<{ id: string; source: AuthorScript["source"]; len: number }> {
	return scripts.map((s) => ({ id: s.id, source: s.source, len: s.content.length }));
}
