/**
 * 回合工作区（PLAN-RP-AGENT-EXEC M-A §2.2）——正文成为工件的落点。
 *
 * 一拍一个工作区：模型直出正文由引擎代收落稿，
 * harness 只执行与验证，不替模型生成任何内容（控制反转的落地处）。
 *
 * 三条铁律：
 * - draft_write 是唯一交稿入口，且已不是模型可调工具——引擎「直出代收」按名调它落地正文；
 * - 记账不在台上：world_state_update 已撤出，账本归封笔后的场记旁路（scribe-run.ts）；
 * - 工作区只活在引擎单拍内，不跨模块共享（jiti 二象性红线，不触 globalThis）。
 *
 * 纯函数 + 注入依赖，零 pi 依赖、可单测（执行器全部复用 draft.ts / state.ts 现成代码）。
 */

import { type DraftRules } from "../draft.ts";

export interface TurnWorkspace {
	/** 当前稿（draft_write 全量替换语义；draft_append 追加语义） */
	draft: string;
	/** 已封笔（M-E）：正文写完了（8/10 起封笔只是状态切换，不触发任何检验） */
	sealed: boolean;
	/** 交稿次数（含宽进严出代收） */
	writes: number;
	/** draft_append 追加段数（M-E KPI：分段续写是否真发生） */
	appends: number;
	/** draft_edit 成功套用的次数（M-B KPI：定点改稿是否真替代了全文重交） */
	edits: number;
	/**
	 * 本拍查过几次世界（lorebook / memory / world_state_get；不含 skill_read）。
	 *
	 * 用作「这一拍有没有戏」的外部事实：查过世界＝中途确实遇到了需要停下来处理的
	 * 事，那这一拍本该一段一段演。draft_write 的门禁据此判定（见 runWriteTool）。
	 */
	lookups: number;
	/**
	 * 本拍面板写入次数（panel_write / panel_close 调用计数，engine 维护）。
	 */
	panelWrites: number;
	/**
	 * 本拍时间线（思考/工具/正文按**发生顺序**）。
	 *
	 * 定稿只落最后一稿正文，中间轮的思考与工具轨迹本会丢失——但用户要看的
	 * 正是「思考→工具→正文→思考」这条链。故在此按序记档，落树时随 details
	 * 持久化，刷新与 resync 后仍在。
	 */
	timeline: TurnSegment[];
	/**
	 * 稿外直出文本（engine 每轮更新）：首轮直出＋稿落地前的 text 通道产出中，
	 * 未被代收进稿的部分。seal 回执把它作为事实补认——不回喂原文、不给指令，
	 * 处置（draft_edit 补进去 / 当旁白不理）归模型判断。
	 */
	strayText?: string;
	/**
	 * 本拍的媒体交付（show_image/audio/video/html、tts，8/06 重接）。
	 *
	 * wire 层只把树上的 `role:"toolResult"` 条目翻成媒体帧，而台上引擎落树时
	 * 剥离工具轨迹——故媒体结果在此收集，谢幕后随正文一起落成 toolResult 条目，
	 * 让 live 推送与刷新重放走同一条路径。
	 */
	mediaDeliveries?: Array<{ toolName: string; details: Record<string, unknown>; text: string }>;
}

/** 时间线段：与前端 web/src/timeline.ts 的 TurnSegment 同构（跨边界只走 JSON） */
export type TurnSegment =
	| { kind: "thinking"; text: string }
	/** draft=true 标记「这段是工作区稿件」，重交/改稿时原地替换而非叠加 */
	| { kind: "text"; text: string; draft?: boolean }
	| { kind: "tool"; activities: Array<{ kind: string; name: string; detail?: string; isError?: boolean }> };

export function createWorkspace(): TurnWorkspace {
	return {
		draft: "",
		sealed: false,
		writes: 0,
		appends: 0,
		edits: 0,
		lookups: 0,
		panelWrites: 0,
		timeline: [],
	};
}

/** 时间线追加：同类并入末段（连续工具聚成一组），异类开新段 */
export function recordSegment(
	ws: TurnWorkspace,
	seg:
		| { kind: "thinking"; text: string }
		| { kind: "text"; text: string }
		| { kind: "tool"; activity: { kind: string; name: string; detail?: string; isError?: boolean } },
): void {
	const last = ws.timeline[ws.timeline.length - 1];
	if (seg.kind === "tool") {
		if (last && last.kind === "tool") last.activities.push(seg.activity);
		else ws.timeline.push({ kind: "tool", activities: [seg.activity] });
		return;
	}
	if (!seg.text) return;
	// text 记档（尾巴流式等，无 draft 标记）不并入稿段——稿段是 draft_append/resync
	// 维护的作品分段，尾巴黏进去会让「稿段拼接 ≠ 现稿」，定稿分段同构随之失效。
	const mergeable = last && last.kind === seg.kind && !(last.kind === "text" && last.draft === true);
	if (mergeable) last.text += seg.text;
	else ws.timeline.push({ kind: seg.kind, text: seg.text });
}

/**
 * 定稿时间线（8/09 输出形式定案：分段同构——重放形态 = 流式形态）。
 *
 * 常态：稿段（draft=true，= 屏上一段段长出来的故事）原位保留；finalText 相对现稿
 * 多出的尾巴（状态栏 / catsay，text 通道直出）收成独立末段。落树正文 finalText 与
 * 时间线正文（稿段拼接 + 尾巴段）内容一致，且分段结构与用户流式所见相同。
 *
 * 兜底：无稿（直出正文路径）或稿段与现稿脱同步时，退回「全文单段放首个 text 位置」
 * 的塌段形态——内容正确优先于形态。
 */
export function finalTimeline(ws: TurnWorkspace, finalText: string): TurnSegment[] {
	// 分段同构（8/09 输出形式定案）：定稿保持稿段原位——重放形态 = 流式形态。
	// mergeFinalText 的产物必为「稿全文」或「稿全文 + 尾巴」，故 startsWith 成立时
	// 尾巴 = 稿之后的部分（状态栏等 text 通道产出），收成独立末段（不带 draft）。
	// 非稿 text 段（尾巴的流式记档）丢弃——内容已归并进尾巴段，避免重复。
	const draft = ws.draft.trim();
	const flat = (s: string) => s.replace(/\s+/g, "");
	const draftSegs = ws.timeline.filter(
		(s): s is Extract<TurnSegment, { kind: "text" }> => s.kind === "text" && s.draft === true,
	);
	const joined = draftSegs.map((s) => s.text).join("\n\n");
	if (draft && finalText.startsWith(draft) && flat(joined) === flat(draft)) {
		const tail = finalText.slice(draft.length).trim();
		const out: TurnSegment[] = [];
		for (const s of ws.timeline) {
			if (s.kind === "tool") {
				if (s.activities.length > 0) out.push(s);
				continue;
			}
			if (s.kind === "text") {
				if (s.draft === true && s.text.trim()) out.push(s);
				continue;
			}
			if (s.text.trim().length > 0) out.push(s);
		}
		if (tail) out.push({ kind: "text", text: tail });
		return out;
	}
	// 兜底（无稿 / 直出代收 / 稿段与现稿脱同步）：全文单段放首个 text 位置（旧行为）
	const out: TurnSegment[] = [];
	let textPlaced = false;
	for (const s of ws.timeline) {
		if (s.kind === "tool") {
			if (s.activities.length > 0) out.push(s);
			continue;
		}
		if (s.kind === "text") {
			if (!textPlaced) {
				textPlaced = true;
				out.push({ kind: "text", text: finalText, draft: true });
			}
			continue;
		}
		if (s.text.trim().length > 0) out.push(s);
	}
	if (!textPlaced && finalText.trim()) out.push({ kind: "text", text: finalText, draft: true });
	return out;
}

/**
 * 稿件入时间线：**替换**已记的稿，而不是再追加一段。
 *
 * 多稿重交（M-B 实弹的 882→849→838）与定点改稿都作用在同一份稿上，
 * 逐次追加会让同一段正文在屏上叠出几份（EXEC §4.5.4 记的重复上屏欠账）。
 * 故先摘掉此前记过的稿段，再把最新稿记在当前位置——位置随最后一次动笔走，
 * 前面的思考与工具轨迹不动。
 */
function replaceDraftSegment(ws: TurnWorkspace, content: string): void {
	ws.timeline = ws.timeline.filter((s) => !(s.kind === "text" && s.draft === true));
	ws.timeline.push({ kind: "text", text: content, draft: true });
}

/**
 * 稿件按空行切段——分段的**同源算法**：时间线重切（下方 resyncDraftSegments）、
 * 引擎的 draft_resync 帧（修复后前端原位替换稿段）都用它，保证前后端看到同一套分段。
 */
export function splitDraftSegments(draft: string): string[] {
	return draft.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
}

export interface WorkspaceDeps {
	rules: DraftRules;
	userName: string;
	charName: string;
}

export interface WriteToolResult {
	/** 回给模型的 toolResult 文本 */
	text: string;
	/** 过程条短句（无则不出条） */
	activity?: string;
	/** true = 本次调用是有效交稿/记账（引擎统计与流转用） */
	ok: boolean;
}

/**
 * 封笔事实（8/10 验收整体退役后仅存的回执信息）：稿外直出补认一行。
 * 禁词/比喻/句式的匹配统计连同 checkDraft 已全部删除——落笔之后 harness
 * 不对稿件内容说任何话；质量投资全在落笔前（预设原文＋素材＋思考空间）。
 */
function sealFacts(ws: TurnWorkspace): string {
	const stray = (ws.strayText ?? "").trim();
	if (!stray) return "";
	const chars = stray.replace(/\s+/g, "").length;
	return `
另：text 通道有约 ${chars} 字直出不在稿内（起头「${stray.slice(0, 15)}…」）。`;
}

/**
 * 执行一次写侧工具调用。未知工具/参数缺失都返回可读文本（不抛，不打断本拍）。
 * 读侧三件（lorebook/memory/world_state_get）仍走 tools.ts runStageTool。
 */
export function runWriteTool(
	ws: TurnWorkspace,
	deps: WorkspaceDeps,
	name: string,
	args: Record<string, unknown>,
	/**
	 * 内部代收（宽进严出）：跳过 draft_write 门禁。
	 *
	 * 引擎把模型直出的正文代收为 draft_write 时，那不是模型的选择而是兜底——
	 * 若被门禁拦下，这拍的正文就凭空丢了。只有 engine #agentLoop 传 true。
	 */
	internal = false,
): WriteToolResult {
	// draft_write / draft_seal 不再是模型可调工具（第三步：撤出模型视野）——但 handler 保留：
	// 引擎在「直出代收」时按名调 draft_write(internal=true) 落地正文（engine #agentLoop），
	// 收束时兜底调 draft_seal。append/edit/read/search 是「分段续写/改稿」工作流，随预设主导
	// 一次性输出而整体退役（打磨回到思考里），连 handler 一并删。
	if (name === "draft_write") {
		const content = typeof args.content === "string" ? args.content : "";
		if (!content.trim()) return { text: "content 为空。", ok: false };
		ws.draft = content;
		ws.writes++;
		ws.sealed = true; // 全量交稿即完整稿，天然封笔
		replaceDraftSegment(ws, content);
		return { text: `已收稿（第 ${ws.writes} 稿）。${sealFacts(ws)}`, activity: `交稿 ${content.length} 字`, ok: true };
	}

	if (name === "draft_seal") {
		if (!ws.draft.trim()) return { text: "工作区还没有稿件。", ok: false };
		ws.sealed = true;
		return { text: `已封笔。${sealFacts(ws)}`, activity: "封笔", ok: true };
	}

	return { text: `未知写侧工具 ${name}。`, ok: false };}
