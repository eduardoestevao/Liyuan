/**
 * 「提示词」面板（docs/PLAN-AGENT-SLOTS.md §七，2026-09-08 用户定名与分栏）：
 * - 全局系统提示词：SYSTEM.md（梨园扮演骨架，改后重启生效）+ APPEND_SYSTEM.md
 *   （全局，对所有卡生效——角色相当于原来的预设）
 * - 局部提示词：这张卡的 AGENTS.md（卡档案）+ 这张卡的 APPEND_SYSTEM.md
 * - 预设库（2026-09-12 用户定案：预设直用，不转译）——「装载」设为活动预设，
 *   改动经「保存」写回预设文件本身；条目带来源标注（预设块 / 梨园槽位）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	apiDelete,
	apiGet,
	apiGetPeek,
	apiPost,
	apiPut,
	downloadJson,
	type CardAgentsResponse,
	type CardAgentsSaveResponse,
	type PresetBlockPatch,
	type PresetBlockView,
	type PresetResponse,
	type PresetsResponse,
	type RulesResponse,
	type RulesSaveResponse,
} from "../api.ts";
import { ConfirmButton, PanelStatus, SliderField, Toggle, useAction, usePanelData } from "./kit.tsx";
import {
	appendEntry,
	deleteEntry,
	parsePromptEntries,
	setEntryContent,
	toggleEntry,
} from "../../../src/prompt-entries.ts";

const CHANNEL_LABEL: Record<string, string> = {
	system: "历史前",
	postHistory: "历史后",
};

const SAMPLER_META: Array<{ key: string; min: number; max: number; step: number; hint: string }> = [
	{ key: "temperature", min: 0, max: 2, step: 0.01, hint: "越高越随机发散，越低越确定" },
	{ key: "top_p", min: 0, max: 1, step: 0.01, hint: "核采样：只从累计概率 top_p 的词里选" },
	{ key: "top_k", min: 0, max: 200, step: 1, hint: "只从概率最高的 k 个词里选（0=不限）" },
	{ key: "frequency_penalty", min: -2, max: 2, step: 0.01, hint: "惩罚高频词，抑制复读" },
	{ key: "presence_penalty", min: -2, max: 2, step: 0.01, hint: "惩罚已出现词，鼓励换话题" },
	{ key: "repetition_penalty", min: 1, max: 2, step: 0.01, hint: "重复惩罚（1=不惩罚）" },
	{ key: "min_p", min: 0, max: 1, step: 0.01, hint: "过滤概率低于峰值 min_p 倍的词" },
];

/** 行级对照（投影 vs 文件）：只给「差在哪」的直觉，不追求完整 diff 算法 */
function diffPreview(base: string, mine: string): string {
	const a = base.split("\n");
	const b = mine.split("\n");
	const setA = new Set(a);
	const setB = new Set(b);
	const out: string[] = [];
	for (const l of a) if (!setB.has(l)) out.push(`- ${l.slice(0, 120)}`);
	for (const l of b) if (!setA.has(l)) out.push(`+ ${l.slice(0, 120)}`);
	if (out.length === 0) return "（与投影无差异）";
	return out.slice(0, 80).join("\n") + (out.length > 80 ? `\n… 共 ${out.length} 行差异` : "");
}

/** 转译条目的来源识别（2026-09-12 用户定案）：界面给「预设」徽标，辨认不靠正文里的「转译自」字样 */
function presetDerivedOf(name: string, content: string): boolean {
	if (name.includes("转译自")) return true;
	const first = content.split("\n").find((l) => l.trim() !== "");
	return !!first && first.trim().startsWith(">") && first.includes("转译自");
}

/** 标题里的（转译自「…」）注记从显示名剥掉——来源进徽标，标题保持干净 */
const stripSourceNote = (name: string) => name.replace(/（转译自[^）]*）+/g, "").trim();

/** 条目形提示词文件的双视图编辑器（GitHub 式 条目|源码）：文件是真源，条目是投影 */
function EntriesEditor({
	title,
	initial,
	onSave,
	busy,
	effect = "beat",
}: {
	title: string;
	initial: string;
	onSave: (content: string) => Promise<void>;
	busy: boolean;
	/** 保存后何时生效：beat=下一拍（默认），restart=需重启 */
	effect?: "beat" | "restart";
}) {
	const [text, setText] = useState(initial);
	const [dirty, setDirty] = useState(false);
	const [view, setView] = useState<"entries" | "source">("entries");
	const [open, setOpen] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [newContent, setNewContent] = useState("");
	const [createError, setCreateError] = useState<string | null>(null);
	const lastInitial = useRef(initial);
	useEffect(() => {
		if (!dirty && initial !== lastInitial.current) setText(initial);
		lastInitial.current = initial;
	}, [initial, dirty]);

	const entries = useMemo(() => parsePromptEntries(text), [text]);
	const apply = (next: string | null) => {
		if (next !== null) {
			setText(next);
			setDirty(true);
		}
	};
	const effectNote = effect === "restart" ? "保存后重启生效" : "保存后下一拍生效";

	const confirmCreate = () => {
		const name = newName.trim();
		if (!name) return;
		if (entries.some((e) => e.name === name)) {
			setCreateError(`已有同名条目「${name}」`);
			return;
		}
		const next = appendEntry(text, name, newContent);
		if (next === null) return;
		apply(next);
		setCreating(false);
		setOpen(name);
		setDrafts((d) => ({ ...d, [name]: newContent }));
	};
	const cancelCreate = () => {
		setCreating(false);
		setCreateError(null);
	};

	return (
		<section className="sp-section">
			<div className="preset-chan-head">
				<h4>{title}</h4>
				<div className="preset-block-acts">
					<div className="preset-tabs" role="tablist" style={{ margin: 0 }}>
						<button
							type="button"
							role="tab"
							aria-selected={view === "entries"}
							className={`preset-tab ${view === "entries" ? "active" : ""}`}
							onClick={() => setView("entries")}
						>
							条目
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={view === "source"}
							className={`preset-tab ${view === "source" ? "active" : ""}`}
							onClick={() => setView("source")}
						>
							源码
						</button>
					</div>
					<button
						className="drawer-btn save-btn"
						disabled={busy || !dirty}
						onClick={() => void onSave(text).then(() => setDirty(false))}
					>
						{dirty ? "保存 *" : "保存"}
					</button>
				</div>
			</div>
			{view === "source" ? (
				<textarea
					className="panel-search ta preset-block-ta"
					rows={12}
					spellCheck={false}
					value={text}
					disabled={busy}
					placeholder="写给模型的常驻提示词（markdown）…"
					onChange={(e) => {
						setText(e.target.value);
						setDirty(true);
					}}
				/>
			) : (
				<>
					{entries.map((e) => (
						<div key={e.name} className={`lore-item preset-block ${e.enabled ? "" : "off"} ${open === e.name ? "open" : ""}`}>
							<div className="lore-head">
								<button
									type="button"
									className="preset-block-toggle"
									aria-expanded={open === e.name}
									onClick={() => {
										setOpen(open === e.name ? null : e.name);
										setDrafts((d) => ({ ...d, [e.name]: e.content }));
									}}
								>
									<span className={`group-caret ${open === e.name ? "open" : ""}`}>▸</span>
									<div className="block-info">
										<span className="lore-title">
											{(presetDerivedOf(e.name, e.content) ? stripSourceNote(e.name) : e.name) || "（开头）"}
										</span>
										{presetDerivedOf(e.name, e.content) && <span className="preset-src-badge preset">预设</span>}
										<span className="lore-meta">
											{e.content.length.toLocaleString()} 字 · {e.enabled ? "开" : "关"}
										</span>
									</div>
								</button>
								<div className="preset-block-acts">
									<Toggle checked={e.enabled} disabled={busy} onChange={(v) => apply(toggleEntry(text, e.name, v))} />
								</div>
							</div>
							{open === e.name && (
								<div className="preset-block-body">
									<label className="field-label">正文</label>
									<textarea
										className="panel-search ta preset-block-ta"
										rows={8}
										spellCheck={false}
										value={drafts[e.name] ?? e.content}
										disabled={busy}
										onChange={(ev) => setDrafts((d) => ({ ...d, [e.name]: ev.target.value }))}
									/>
									<div className="panel-row" style={{ marginTop: 6 }}>
										<button
											className="act"
											disabled={busy}
											onClick={() => {
												apply(setEntryContent(text, e.name, drafts[e.name] ?? e.content));
												setOpen(null);
											}}
										>
											保存条目
										</button>
										<button className="act" onClick={() => setOpen(null)}>
											收起
										</button>
										<ConfirmButton
											className="act preset-del-btn"
											disabled={busy}
											confirmText="确认删除"
											onConfirm={() => {
												apply(deleteEntry(text, e.name));
												setOpen(null);
											}}
										>
											删除
										</ConfirmButton>
									</div>
								</div>
							)}
						</div>
					))}
					{creating && (
						<div className="lore-item preset-block open">
							<div className="lore-head">
								<div className="block-info" style={{ flex: 1 }}>
									<input
										className="panel-search"
										placeholder="条目名（## 小节标题）"
										value={newName}
										disabled={busy}
										autoFocus
										onChange={(ev) => {
											setNewName(ev.target.value);
											setCreateError(null);
										}}
										onKeyDown={(ev) => {
											if (ev.key === "Enter") void confirmCreate();
											if (ev.key === "Escape") cancelCreate();
										}}
									/>
								</div>
							</div>
							<div className="preset-block-body">
								<label className="field-label">正文</label>
								<textarea
									className="panel-search ta preset-block-ta"
									rows={6}
									spellCheck={false}
									value={newContent}
									disabled={busy}
									onChange={(ev) => setNewContent(ev.target.value)}
								/>
								{createError && (
									<div className="field-hint" style={{ color: "var(--danger, #e07a5f)" }}>
										{createError}
									</div>
								)}
								<div className="panel-row" style={{ marginTop: 6 }}>
									<button className="act" disabled={busy || !newName.trim()} onClick={() => void confirmCreate()}>
										添加
									</button>
									<button className="act" onClick={() => cancelCreate()}>
										取消
									</button>
								</div>
							</div>
						</div>
					)}
					<div className="panel-row" style={{ marginTop: 6 }}>
						<button
							className="act"
							disabled={busy || creating}
							onClick={() => {
								setCreating(true);
								setNewName("");
								setNewContent("");
								setCreateError(null);
							}}
						>
							＋ 添加条目
						</button>
					</div>
				</>
			)}
			<div className="field-hint">
				{text.length.toLocaleString()} 字{dirty ? " · 未保存" : ""} · {effectNote}
			</div>
		</section>
	);
}

/** 底座 blob 编辑器（SYSTEM.md 用）：纯源码 */
function RulesEditor({
	title,
	initial,
	onSave,
	busy,
	effect = "beat",
}: {
	title: string;
	initial: string;
	onSave: (content: string) => Promise<void>;
	busy: boolean;
	effect?: "beat" | "restart";
}) {
	const [text, setText] = useState(initial);
	const [dirty, setDirty] = useState(false);
	// 外部重载（面板重开/换卡）时同步进编辑框：没动过的直接跟随，动过的保留用户手里的
	const lastInitial = useRef(initial);
	useEffect(() => {
		if (!dirty && initial !== lastInitial.current) {
			setText(initial);
		}
		lastInitial.current = initial;
	}, [initial, dirty]);

	return (
		<section className="sp-section">
			<div className="preset-chan-head">
				<h4>{title}</h4>
				<button
					className="drawer-btn save-btn"
					disabled={busy || !dirty}
					onClick={() => void onSave(text).then(() => setDirty(false))}
				>
					{dirty ? "保存 *" : "保存"}
				</button>
			</div>
			<textarea
				className="panel-search ta preset-block-ta"
				rows={12}
				spellCheck={false}
				value={text}
				disabled={busy}
				placeholder="写给模型的常驻提示词（markdown）…"
				onChange={(e) => {
					setText(e.target.value);
					setDirty(true);
				}}
			/>
			<div className="field-hint">
				{text.length.toLocaleString()} 字{dirty ? " · 未保存" : ""} · {effect === "restart" ? "保存后重启生效" : "保存后下一拍生效"}
			</div>
		</section>
	);
}

export function PresetPanel({
	toast,
	onAssistantPrompt,
}: {
	toast: (level: "info" | "warning" | "error", text: string) => void;
	/** 发话给右栏助手（刀3 生成路径：把投影全文交给助手整理成卡档案） */
	onAssistantPrompt?: (text: string) => void;
}) {
	const files = usePanelData(() => apiGet<PresetsResponse>("/api/presets"), { cacheKey: "/api/presets" });
	const rules = usePanelData(() => apiGet<RulesResponse>("/api/rules"), { cacheKey: "/api/rules" });
	const agents = usePanelData(() => apiGet<CardAgentsResponse>("/api/card-agents"), { cacheKey: "/api/card-agents" });
	const { busy, run } = useAction(toast);

	const [tab, setTab] = useState<"global" | "local" | "library">("global");
	const [showDiff, setShowDiff] = useState(false);

	const saveRules = useCallback(
		async (scope: "global" | "card", content: string) => {
			const r = await apiPut<RulesSaveResponse>("/api/rules", { scope, content });
			toast("info", `已保存（${r.chars.toLocaleString()} 字），下一拍生效`);
		},
		[toast],
	);

	/** SYSTEM.md：全局系统提示词（改后重启生效，提示语随保存回执） */
	const saveSystem = useCallback(
		async (content: string) => {
			const r = await apiPut<RulesSaveResponse>("/api/rules", { scope: "system", content });
			toast("info", `SYSTEM.md 已保存（${r.chars.toLocaleString()} 字）——重启梨园后生效`);
		},
		[toast],
	);

	// ---------------- 预设库：装载 / 保存（用户定案 2026-09-12：预设直用，改动存回预设本身） ----------------

	/** 装载：把库里的预设设为活动预设（config.preset，编辑器随之出现） */
	const loadPreset = (file: string) =>
		run(async () => {
			await apiPost("/api/presets/select", { file });
			toast("info", "已装载——在下方编辑器里改动，点「保存」写回文件");
			files.reload();
			if (rules.data?.card) {
				toast("warning", "本卡已有规矩文件（APPEND_SYSTEM.md），预设会与它同时生效");
			}
		});

	/** 保存：把活动预设的未落盘改动写回文件（与编辑器工具条的「保存」同一条端点） */
	const savePreset = () =>
		run(async () => {
			await apiPost("/api/preset/save", {});
			setDirty(false);
			files.reload();
		}, "预设已保存到文件");

	/** 卸载：不再使用活动预设（文件保留在库里） */
	const unloadPreset = () =>
		run(async () => {
			await apiPost("/api/presets/select", { file: null });
			toast("info", "已卸载——预设文件保留在库里");
			files.reload();
		});

	/** 卡档案（刀3）：保存 / 删除回投影 / 让助手生成 */
	const saveAgents = useCallback(
		async (content: string) => {
			const r = await apiPut<CardAgentsSaveResponse>("/api/card-agents", { content });
			toast("info", `卡档案已保存（${r.chars.toLocaleString()} 字），下一拍生效`);
			agents.reload();
		},
		[toast, agents],
	);

	const deleteAgents = () =>
		run(async () => {
			await apiDelete("/api/card-agents");
			toast("info", "已删除卡档案——回到自动投影");
			agents.reload();
		});

	/** 生成路径：把全量投影（含被停用条目）作为用户消息交给助手整理（模型做取舍判断，产物是看得见的文件） */
	const generateAgents = () => {
		if (!agents.data || !onAssistantPrompt) return;
		const d = agents.data;
		const droppedNote =
			d.droppedTitles.length > 0
				? [
						"以下条目目前被运行时整条停用（原因附后）——逐条重新判断：真正的**输出版式**（状态栏格式、排版要求）保留进档案；纯插件协议指令（要求输出 <UpdateVariable>、JSON Patch、表格更新之类）不进——世界状态记账由梨园场记自动完成，模型照协议输出只会污染正文。",
						...d.droppedTitles.map((t) => `- ${t}`),
					].join("\n")
				: "（没有条目被停用）";
		const instruction = [
			`给「${d.cardName}」这张卡建立 AGENTS.md（卡档案），写到 ${d.path}。`,
			"",
			"下面是这张卡全部常驻内容的全量投影（卡字段 + 常驻世界书 + 作者指令，含被停用条目）。整理成卡档案时：",
			"- 保留全部事实设定与人物信息，保留状态栏等输出版式要求——那是卡作者要的格式；状态栏的标签包裹（如 <normal_status>）必须原样保留，前端据此渲染。",
			"- 插件协议指令不进来（停用条目的处理见下）；写清你在哪些地方做了取舍。",
			"- 关键词触发（绿灯）的世界书条目不进来——它们保持可检索。",
			"- 结构清楚即可（markdown 小节），写事实不写元指令；这是给扮演 agent 读的常驻说明。",
			"",
			droppedNote,
			"",
			"===== 全量投影（含停用条目）=====",
			d.unfilteredProjection,
			"===== 投影结束 =====",
			"",
			`用文件工具把整理结果写到 ${d.path}，写完简要报告你做了哪些取舍。`,
		].join("\n");
		onAssistantPrompt(instruction);
		toast("info", "已把卡内容全量投影发给助手整理——在右栏「助手」里看它工作");
	};

	// ---------------- 遗留态：未迁移的活动预设（块级编辑，与旧面板一致） ----------------

	type DraftBlock = PresetBlockView & { content: string };
	type DraftPreset = { name: string; samplers: Record<string, number>; blocks: DraftBlock[] };
	type FullPresetResponse = PresetResponse & {
		dirty?: boolean;
		preset: { name: string; samplers: Record<string, number>; blocks: Array<PresetBlockView & { content?: string }> } | null;
	};
	const PRESET_FULL_PATH = "/api/preset?full=1&working=1";

	const [draft, setDraft] = useState<DraftPreset | null>(null);
	const [dirty, setDirty] = useState(false);
	const [missing, setMissing] = useState<string | undefined>();
	const [loadingDetail, setLoadingDetail] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [legacyTab, setLegacyTab] = useState<"samplers" | "prompt">("samplers");
	const applyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pendingRef = useRef<PresetBlockPatch[]>([]);
	const pendingSamplersRef = useRef<Record<string, number> | null>(null);
	const activeFile = files.data?.active ?? null;

	const loadFromDisk = useCallback(async () => {
		if (!apiGetPeek<FullPresetResponse>(PRESET_FULL_PATH)) setLoadingDetail(true);
		setLoadError(null);
		try {
			const r = await apiGet<FullPresetResponse>(PRESET_FULL_PATH);
			setMissing(r.missing);
			setDirty(r.dirty === true);
			setDraft(
				r.preset
					? {
							name: r.preset.name,
							samplers: { ...r.preset.samplers },
							blocks: r.preset.blocks.map((b) => ({
								...b,
								marker: b.marker === true,
								chars: b.content?.length ?? b.chars,
								content: b.content ?? "",
							})),
						}
					: null,
			);
		} catch (e) {
			setLoadError(e instanceof Error ? e.message : String(e));
			setDraft(null);
		} finally {
			setLoadingDetail(false);
		}
	}, []);

	useEffect(() => {
		if (files.data === null) return;
		if (activeFile) void loadFromDisk();
		else {
			setDraft(null);
			setMissing(undefined);
		}
	}, [activeFile, files.data, loadFromDisk]);

	const applyRuntime = useCallback(
		(patches: PresetBlockPatch[], samplers?: Record<string, number>) => {
			pendingRef.current.push(...patches);
			if (samplers) pendingSamplersRef.current = samplers;
			if (applyTimer.current) clearTimeout(applyTimer.current);
			applyTimer.current = setTimeout(() => {
				const merged = new Map<string, PresetBlockPatch>();
				for (const p of pendingRef.current) merged.set(p.id, { ...merged.get(p.id), ...p });
				const body: { blocks: PresetBlockPatch[]; samplers?: Record<string, number> } = {
					blocks: [...merged.values()],
				};
				if (pendingSamplersRef.current) body.samplers = pendingSamplersRef.current;
				pendingRef.current = [];
				pendingSamplersRef.current = null;
				void (async () => {
					try {
						await apiPut("/api/preset", body);
					} catch (e) {
						toast("error", e instanceof Error ? e.message : String(e));
					}
				})();
			}, 280);
		},
		[toast],
	);

	const patchDraft = (
		mutator: (d: DraftPreset) => DraftPreset,
		patches: PresetBlockPatch[],
		samplers?: Record<string, number>,
	) =>
		setDraft((prev) => {
			if (!prev) return prev;
			setDirty(true);
			applyRuntime(patches, samplers);
			return mutator(prev);
		});

	const patchBlock = (id: string, patch: Partial<DraftBlock>) =>
		patchDraft(
			(d) => ({
				...d,
				blocks: d.blocks.map((b) => {
					if (b.id !== id) return b;
					const merged = { ...b, ...patch };
					if (typeof patch.content === "string") merged.chars = patch.content.length;
					return merged;
				}),
			}),
			[
				{
					id,
					...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
					...(typeof patch.name === "string" ? { name: patch.name } : {}),
					...(typeof patch.content === "string" ? { content: patch.content } : {}),
				},
			],
		);

	const patchSamplers = (key: string, value: number) =>
		setDraft((prev) => {
			if (!prev) return prev;
			const samplers = { ...prev.samplers, [key]: value };
			setDirty(true);
			applyRuntime([], samplers);
			return { ...prev, samplers };
		});

	const blocks = (draft?.blocks ?? []).filter((b) => !b.marker);

	const saveToDisk = () =>
		run(async () => {
			await apiPost("/api/preset/save", {});
			setDirty(false);
			files.reload();
		}, "预设已保存到文件");

	const revertDraft = () =>
		run(async () => {
			await apiPost("/api/preset/revert", {});
			await loadFromDisk();
		}, "已恢复为文件中的版本");

	const doImport = async (file: File) => {
		try {
			const json = JSON.parse(await file.text()) as Record<string, unknown>;
			const r = await apiPost<{ file: string; kind: "st" | "rp"; blockCount: number; enabledCount: number }>(
				"/api/presets/import",
				{ name: file.name.replace(/\.json$/i, ""), json },
			);
			toast("info", `已导入预设库（${r.blockCount} 条 · 启用 ${r.enabledCount}）——已设为活动预设`);
			files.reload();
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		}
	};

	const doExport = async (file: string) => {
		try {
			const r = await apiGet<{ name: string; json: unknown }>(`/api/presets/export?file=${encodeURIComponent(file)}`);
			downloadJson(`${r.name}.json`, r.json);
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		}
	};

	const removePreset = (file: string) =>
		run(async () => {
			await apiDelete(`/api/presets?file=${encodeURIComponent(file)}`);
			files.reload();
		}, "已从预设库删除");

	return (
		<div className="panel-body">
			<div className="preset-tabs" role="tablist">
				<button
					type="button"
					role="tab"
					aria-selected={tab === "global"}
					className={`preset-tab ${tab === "global" ? "active" : ""}`}
					onClick={() => setTab("global")}
				>
					全局系统提示词
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "local"}
					className={`preset-tab ${tab === "local" ? "active" : ""}`}
					onClick={() => setTab("local")}
				>
					局部提示词
					{agents.data?.active === "projection" ? <span className="preset-tab-count">投影</span> : null}
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "library"}
					className={`preset-tab ${tab === "library" ? "active" : ""}`}
					onClick={() => setTab("library")}
				>
					预设库
					{activeFile ? <span className="preset-tab-count">未转译</span> : null}
				</button>
			</div>

			{tab === "global" && (
				<>
					<PanelStatus loading={rules.loading} error={rules.error} hasData={!!rules.data} />
					{rules.data && (
						<>
							<RulesEditor
								title="SYSTEM.md"
								effect="restart"
								initial={rules.data.system.content}
								onSave={(c) => saveSystem(c)}
								busy={busy}
							/>
							<EntriesEditor
								title="APPEND_SYSTEM.md（全局）"
								initial={rules.data.global.content}
								onSave={(c) => saveRules("global", c)}
								busy={busy}
							/>
						</>
					)}
				</>
			)}

			{tab === "local" && (
				<>
					<PanelStatus loading={agents.loading} error={agents.error} hasData={!!agents.data} />
					{agents.data && (
						<section className="sp-section">
							<div className="preset-chan-head">
								<h4>卡档案{agents.data.active === "file" ? "（生效中）" : "（未建立）"}</h4>
								<div className="preset-block-acts">
									{agents.data.active === "projection" && onAssistantPrompt && (
										<button className="act" disabled={busy} onClick={generateAgents}>
											让助手生成
										</button>
									)}
									<button className="act" disabled={busy} onClick={() => setShowDiff((v) => !v)}>
										{showDiff ? "收起对照" : "对照投影"}
									</button>
									{agents.data.exists && (
										<ConfirmButton className="act preset-del-btn" disabled={busy} confirmText="确认删除（回到投影）" onConfirm={() => void deleteAgents()}>
											删除
										</ConfirmButton>
									)}
								</div>
							</div>
							{agents.data.active === "projection" && (
								<div className="field-hint">还没有卡档案——当前卡内容以自动投影提供。</div>
							)}
							{showDiff && (
								<pre className="field-hint" style={{ whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto" }}>
									{diffPreview(agents.data.projection, agents.data.content || agents.data.projection)}
								</pre>
							)}
						</section>
					)}
					{agents.data && (
						<EntriesEditor
							title="AGENTS.md（卡档案）"
							initial={agents.data.content}
							onSave={saveAgents}
							busy={busy}
						/>
					)}
					{rules.data && (
						<EntriesEditor
							title="APPEND_SYSTEM.md（这张卡）"
							initial={rules.data.card.content}
							onSave={(c) => saveRules("card", c)}
							busy={busy}
						/>
					)}
				</>
			)}

			{tab === "library" && (
				<>
					<section className="sp-section">
						<div className="preset-chan-head">
							<h4>预设库</h4>
							<label className="drawer-btn" title="导入酒馆预设 JSON（原文存档，导入后自动装载）">
								导入
								<input
									type="file"
									accept=".json,application/json"
									hidden
									onChange={(e) => {
										const f = e.target.files?.[0];
										if (f) void doImport(f);
										e.target.value = "";
									}}
								/>
							</label>
						</div>
							<PanelStatus loading={files.loading} error={files.error} hasData={!!files.data} />
						{files.data?.presets.map((p) => (
							<div key={p.file} className="lore-item">
								<div className="lore-head">
									<div className="block-info">
										<span className="lore-title">{p.name}</span>
										{activeFile === p.file && <span className="lore-meta">活动预设</span>}
									</div>
									<div className="preset-block-acts">
										<button
											className="act"
											disabled={busy || activeFile === p.file}
											onClick={() => void loadPreset(p.file)}
										>
											{activeFile === p.file ? "已装载" : "装载"}
										</button>
										<button
											className="act"
											disabled={busy || activeFile !== p.file}
											title="把未落盘的改动写回预设文件"
											onClick={() => void savePreset()}
										>
											保存
										</button>
										<button className="act" disabled={busy} onClick={() => void doExport(p.file)}>
											导出
										</button>
										<ConfirmButton
											className="act preset-del-btn"
											disabled={busy}
											confirmText="确认删除"
											onConfirm={() => void removePreset(p.file)}
										>
											删除
										</ConfirmButton>
									</div>
								</div>
							</div>
						))}
						{files.data && files.data.presets.length === 0 && (
							<div className="sp-empty">预设库是空的。</div>
						)}
					</section>

					{activeFile && (
						<section className="sp-section">
							<div className="preset-chan-head">
								<h4>活动预设</h4>
								<ConfirmButton className="act" disabled={busy} confirmText="确认卸载（不再使用，文件保留）" onConfirm={() => void unloadPreset()}>
									卸载
								</ConfirmButton>
							</div>
									<div className="panel-row list-toolbar preset-actions">
								<button className="drawer-btn save-btn" disabled={busy || !dirty} onClick={() => void saveToDisk()}>
									{dirty ? "保存 *" : "保存"}
								</button>
								<button className="drawer-btn" disabled={busy || !dirty} onClick={() => void revertDraft()}>
									还原
								</button>
							</div>
							{dirty && (
								<div className="field-hint preset-dirty-hint">
									有未保存修改：已立即用于对话；点「保存」写回预设文件。
								</div>
							)}
							<PanelStatus loading={loadingDetail} error={loadError} hasData={!!draft || !!missing} />
							{missing && <div className="panel-error">配置指向的预设文件不存在：{missing}</div>}
							{draft && (
								<>
									<div className="preset-tabs" role="tablist">
										<button
											type="button"
											role="tab"
											aria-selected={legacyTab === "samplers"}
											className={`preset-tab ${legacyTab === "samplers" ? "active" : ""}`}
											onClick={() => setLegacyTab("samplers")}
										>
											参数
										</button>
										<button
											type="button"
											role="tab"
											aria-selected={legacyTab === "prompt"}
											className={`preset-tab ${legacyTab === "prompt" ? "active" : ""}`}
											onClick={() => setLegacyTab("prompt")}
										>
											提示词
											<span className="preset-tab-count">
												{blocks.filter((b) => b.enabled).length}/{blocks.length}
											</span>
										</button>
									</div>
									{legacyTab === "samplers" && (
										<section className="sp-section">
											{Object.keys(draft.samplers).length === 0 && (
												<div className="sp-empty">该预设未带采样参数。</div>
											)}
											{SAMPLER_META.filter((m) => m.key in draft.samplers).map((m) => (
												<SliderField
													key={m.key}
													label={m.key}
													hint={m.hint}
													value={draft.samplers[m.key]}
													min={m.min}
													max={m.max}
													step={m.step}
													onChange={(nv) => patchSamplers(m.key, nv)}
												/>
											))}
										</section>
									)}
									{legacyTab === "prompt" &&
										blocks.map((b) => (
											<div key={b.id} className={`lore-item preset-block ${b.enabled ? "" : "off"}`}>
												<div className="lore-head">
													<div className="block-info">
														<span className="lore-title">{b.name || b.id}</span>
															<span className={"preset-src-badge " + (b.marker ? "liyuan" : "preset")}>{b.marker ? "梨园槽位" : "预设"}</span>
														<span className="lore-meta">
															{b.content.length.toLocaleString()} 字 ·{" "}
															{CHANNEL_LABEL[b.channel] ?? b.channel}
														</span>
													</div>
													<div className="preset-block-acts">
														<Toggle
															checked={b.enabled}
															disabled={busy}
															onChange={(v) => patchBlock(b.id, { enabled: v })}
														/>
													</div>
												</div>
											</div>
										))}
								</>
							)}
						</section>
					)}
				</>
			)}
		</div>
	);
}
