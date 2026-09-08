/**
 * 「我的规矩」面板（刀2，docs/PLAN-AGENT-SLOTS.md §七）：
 * - 我的规矩：两级 APPEND_SYSTEM.md 编辑器（全局一份 + 当前卡一份），保存即落盘，
 *   下一拍生效（stage 每拍现读）
 * - 预设库：酒馆预设退场为一次性转译——导入原文 → 转译成本卡规矩文件 + 采样参数进
 *   config + 逐块去向报告。旧的块级编辑 UI 只在 config.preset 仍指向某文件时作为
 *   遗留态出现（未迁移用户不受影响，不强制）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	apiDelete,
	apiGet,
	apiGetPeek,
	apiPost,
	apiPut,
	downloadJson,
	type PresetBlockPatch,
	type PresetBlockView,
	type PresetResponse,
	type PresetsResponse,
	type PresetTranslateResponse,
	type RulesResponse,
	type RulesSaveResponse,
} from "../api.ts";
import { ConfirmButton, PanelStatus, SliderField, Toggle, useAction, usePanelData } from "./kit.tsx";

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

/** 一份规矩文件的编辑器：读 / 改 / 存 */
function RulesEditor({
	title,
	hint,
	initial,
	onSave,
	busy,
}: {
	title: string;
	hint: string;
	initial: string;
	onSave: (content: string) => Promise<void>;
	busy: boolean;
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
			<div className="field-hint">{hint}</div>
			<textarea
				className="panel-search ta preset-block-ta"
				rows={12}
				spellCheck={false}
				value={text}
				disabled={busy}
				placeholder="写给模型的常驻规矩（markdown）…"
				onChange={(e) => {
					setText(e.target.value);
					setDirty(true);
				}}
			/>
			<div className="field-hint">{text.length.toLocaleString()} 字 · 保存后下一拍生效</div>
		</section>
	);
}

export function PresetPanel({ toast }: { toast: (level: "info" | "warning" | "error", text: string) => void }) {
	const files = usePanelData(() => apiGet<PresetsResponse>("/api/presets"), { cacheKey: "/api/presets" });
	const rules = usePanelData(() => apiGet<RulesResponse>("/api/rules"), { cacheKey: "/api/rules" });
	const { busy, run } = useAction(toast);

	const [tab, setTab] = useState<"rules" | "library">("rules");

	const saveRules = useCallback(
		async (scope: "global" | "card", content: string) => {
			const r = await apiPut<RulesSaveResponse>("/api/rules", { scope, content });
			toast("info", `已保存（${r.chars.toLocaleString()} 字），下一拍生效`);
		},
		[toast],
	);

	/** 预设 → 本卡规矩文件（一次性转译） */
	const translate = (file: string, overwrite: boolean) =>
		run(async () => {
			const r = await apiPost<PresetTranslateResponse>("/api/presets/translate", { file, overwrite });
			if (r.exists) {
				toast(
					"warning",
					"本卡已有规矩文件——再点一次「转译」将覆盖（现有内容请先自行备份）",
				);
				return;
			}
			toast(
				"info",
				`已转译为本卡规矩文件（${(r.chars ?? 0).toLocaleString()} 字，${r.lines ?? 0} 块` +
					`；采样参数 ${r.samplersMoved ?? 0} 项迁入 config；报告见 ${r.report ?? ""}）`,
			);
			files.reload();
			rules.reload();
		});

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
			toast("info", `已导入预设库（${r.blockCount} 条 · 启用 ${r.enabledCount}）——点「转译」生成本卡规矩文件`);
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
					aria-selected={tab === "rules"}
					className={`preset-tab ${tab === "rules" ? "active" : ""}`}
					onClick={() => setTab("rules")}
				>
					我的规矩
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

			{tab === "rules" && (
				<>
					<PanelStatus loading={rules.loading} error={rules.error} hasData={!!rules.data} />
					{rules.data && (
						<>
							<RulesEditor
								title="全局规矩"
								hint={`对每张卡生效 · 文件：${rules.data.global.path}`}
								initial={rules.data.global.content}
								onSave={(c) => saveRules("global", c)}
								busy={busy}
							/>
							<RulesEditor
								title={`这张卡（${rules.data.card.cardName}）`}
								hint={`只对当前卡生效，接在全局之后 · 文件：${rules.data.card.path}`}
								initial={rules.data.card.content}
								onSave={(c) => saveRules("card", c)}
								busy={busy}
							/>
						</>
					)}
				</>
			)}

			{tab === "library" && (
				<>
					<section className="sp-section">
						<div className="preset-chan-head">
							<h4>预设库（转译用）</h4>
							<label className="drawer-btn" title="导入酒馆预设 JSON（原文存档，不做转换）">
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
						<div className="field-hint">
							预设不再是「活物」：转译一次，落成本卡规矩文件；采样参数进 config。原文永远留在库里，可重新转译。
						</div>
						<PanelStatus loading={files.loading} error={files.error} hasData={!!files.data} />
						{files.data?.presets.map((p) => (
							<div key={p.file} className="lore-item">
								<div className="lore-head">
									<div className="block-info">
										<span className="lore-title">{p.name}</span>
										{activeFile === p.file && (
											<span className="lore-meta">当前活动（未转译）</span>
										)}
									</div>
									<div className="preset-block-acts">
										<ConfirmButton
											className="act"
											disabled={busy}
											confirmText="确认转译（覆盖本卡规矩）"
											onConfirm={() => void translate(p.file, true)}
										>
											转译
										</ConfirmButton>
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
							<div className="sp-empty">预设库是空的。没有预设也完全可以——规矩直接写在「我的规矩」里。</div>
						)}
					</section>

					{activeFile && (
						<section className="sp-section">
							<div className="preset-chan-head">
								<h4>未转译的活动预设（旧编辑器）</h4>
								<button className="act" disabled={busy} onClick={() => void translate(activeFile, false)}>
									转译并停用预设
								</button>
							</div>
							<div className="field-hint">
								这份预设仍按旧管线装配。转译后它只留档，规矩进「我的规矩」，此编辑器随之消失。
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
									有未保存修改：已立即用于对话；转译前请先「保存」。
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
