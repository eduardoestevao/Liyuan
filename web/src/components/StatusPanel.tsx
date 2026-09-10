/**
 * 戏境状态栏面板（右侧分栏）：
 * 完整展示当前会话生效的世界状态（时间、地点、人物羁绊与状态、物品、标记、剧情线）。
 * 桌面端在右侧同图层平立分栏展开，与左侧扮演区平立并排。
 */

import { apiPut, type StatePatchResult } from "../api.ts";
import type { WorldState } from "../wire.ts";
import { IconTrash } from "./icons.tsx";
import { ConfirmButton, useAction } from "./kit.tsx";
import { Editable, isEmptyState } from "./StatusStrip.tsx";

export interface StatusPanelProps {
	state: WorldState | null;
	toast: (level: "info" | "warning" | "error", text: string) => void;
}

export function StatusPanel({ state, toast }: StatusPanelProps) {
	const { run } = useAction(toast);

	const patch = (p: Record<string, unknown>) =>
		run(async () => {
			const r = await apiPut<StatePatchResult>("/api/state", { patch: p });
			for (const w of r.warnings) toast("warning", w);
		});

	const num = (v: string, fallback: number): number => {
		const n = Number(v);
		return Number.isFinite(n) ? n : fallback;
	};

	const empty = !state || isEmptyState(state);
	const characters = Object.entries(state?.characters ?? {});
	const flags = Object.entries(state?.flags ?? {});
	const inventory = state?.inventory ?? [];
	const plotThreads = state?.plot_threads ?? [];

	return (
		<div className="status-panel">
			<div className="status-panel-scroll">
				{empty && (
					<div className="sp-empty-banner">
						随剧情展开，时间、地点、登场人物与随身行囊将由场记自动登记入册。
					</div>
				)}
				{/* ── 戏境时空 ── */}
				<section className="sp-section">
					<div className="sp-section-title">戏境时空</div>
					<div className="sp-card">
						<div className="kv">
							<span className="kv-k">时间</span>
							<span className="kv-v">
								<Editable value={state?.time ?? ""} placeholder="（随剧情自动推进）" onSave={(v) => patch({ time: v })} />
							</span>
						</div>
						<div className="kv">
							<span className="kv-k">地点</span>
							<span className="kv-v">
								<Editable value={state?.location ?? ""} placeholder="（当前场景所在）" onSave={(v) => patch({ location: v })} />
							</span>
						</div>
					</div>
				</section>

				{/* ── 登场人物与好感 ── */}
				<section className="sp-section">
					<div className="sp-section-title-row">
						<span className="sp-section-title">登场人物羁绊</span>
						<span className="sp-section-count">{characters.length} 人</span>
					</div>
					{characters.length === 0 ? (
						<div className="sp-empty-hint">暂未记录登场人物（随对话自然浮现）</div>
					) : (
						<div className="sp-char-list">
							{characters.map(([name, c]) => (
								<div key={name} className="sp-char">
									<div className="sp-char-head">
										<span className="sp-char-name">{name}</span>
										<span className="sp-affinity">
											好感{" "}
											<Editable
												value={String(c.affinity)}
												onSave={(v) => patch({ characters: { [name]: { affinity: num(v, c.affinity) } } })}
											/>
										</span>
										<ConfirmButton
											title={`移除「${name}」的状态记录`}
											aria-label="移除角色记录"
											confirmText="确认移除"
											onConfirm={() => patch({ characters: { [name]: null } })}
										>
											<IconTrash size={12} />
										</ConfirmButton>
									</div>
									<div className="affinity-bar" aria-hidden="true">
										<div className="affinity-mid" />
										<div
											className={`affinity-fill ${c.affinity < 0 ? "neg" : ""}`}
											style={
												c.affinity >= 0
													? { left: "50%", width: `${Math.min(50, (c.affinity / 100) * 50)}%` }
													: { right: "50%", width: `${Math.min(50, (-c.affinity / 100) * 50)}%` }
											}
										/>
									</div>
									<div className="sp-char-line">
										<span className="sp-meta-label">状态：</span>
										<Editable value={c.status} placeholder="（当前神态/动作）" onSave={(v) => patch({ characters: { [name]: { status: v } } })} />
									</div>
									<div className="sp-char-line">
										<span className="sp-meta-label">现处：</span>
										<Editable
											value={c.at ?? ""}
											placeholder="（所在地）"
											onSave={(v) => patch({ characters: { [name]: { at: v } } })}
										/>
									</div>
									{c.notes && (
										<div className="sp-char-line sp-notes">
											<span className="sp-meta-label">心绪：</span>
											<Editable value={c.notes} placeholder="（心境与暗线）" onSave={(v) => patch({ characters: { [name]: { notes: v } } })} />
										</div>
									)}
								</div>
							))}
						</div>
					)}
				</section>

				{/* ── 随身行囊 ── */}
				<section className="sp-section">
					<div className="sp-section-title">随身物品</div>
					<div className="sp-card">
						<div className="kv">
							<span className="kv-k">行囊</span>
							<span className="kv-v">
								<Editable
									value={inventory.join("、")}
									placeholder="（无随身器物）"
									onSave={(v) => patch({ inventory: v.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) })}
								/>
							</span>
						</div>
					</div>
				</section>

				{/* ── 剧情与暗线 ── */}
				<section className="sp-section">
					<div className="sp-section-title">剧情线与推进</div>
					<div className="sp-card">
						<Editable
							multiline
							value={plotThreads.join("\n")}
							placeholder="（暂无活跃主支线，每行一条）"
							onSave={(v) => patch({ plot_threads: v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) })}
						/>
					</div>
				</section>

				{/* ── 世态标记 ── */}
				{flags.length > 0 && (
					<section className="sp-section">
						<div className="sp-section-title">世界标记</div>
						<div className="sp-card">
							{flags.map(([k, v]) => (
								<div key={k} className="kv">
									<span className="kv-k">{k}</span>
									<span className="kv-v">
										<Editable value={v} onSave={(nv) => patch({ flags: { [k]: nv } })} />
										<ConfirmButton title={`删除标记「${k}」`} aria-label="删除标记" confirmText="确认" onConfirm={() => patch({ flags: { [k]: null } })}>
											<IconTrash size={12} />
										</ConfirmButton>
									</span>
								</div>
							))}
						</div>
					</section>
				)}

				<div className="sp-footer-hint">
					数据随剧情推进自动更新；点铅笔可直接校正，改动随当前世界线分支保存与回退。
				</div>
			</div>
		</div>
	);
}
