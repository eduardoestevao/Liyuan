/**
 * 戏境状态栏面板（右侧分栏）：
 * 与左侧扮演正文完全平级、浑然一体的剧情设定总览。
 * 杜绝细碎气泡与悬浮框，采用优雅的文人长卷章节排版。
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
			{empty && (
				<div className="sp-empty-banner">
					随剧情展开，时间、地点、登场人物与随身行囊将由场记自动登记入册。
				</div>
			)}

			{/* ── 戏境时空 ── */}
			<section className="sp-section">
				<div className="sp-section-head">
					<span className="sp-section-title">戏境时空</span>
				</div>
				<div className="sp-section-body">
					<div className="sp-kv-row">
						<span className="sp-kv-key">纪年时间</span>
						<span className="sp-kv-val">
							<Editable value={state?.time ?? ""} placeholder="（随剧情自动推进）" onSave={(v) => patch({ time: v })} />
						</span>
					</div>
					<div className="sp-kv-row">
						<span className="sp-kv-key">当前地点</span>
						<span className="sp-kv-val">
							<Editable value={state?.location ?? ""} placeholder="（当前场景所在）" onSave={(v) => patch({ location: v })} />
						</span>
					</div>
				</div>
			</section>

			{/* ── 登场人物与羁绊 ── */}
			<section className="sp-section">
				<div className="sp-section-head">
					<span className="sp-section-title">登场人物羁绊</span>
					{characters.length > 0 && <span className="sp-section-badge">{characters.length} 人在案</span>}
				</div>
				<div className="sp-section-body">
					{characters.length === 0 ? (
						<div className="sp-empty-hint">暂无登场人物记录（随对话自然浮现）</div>
					) : (
						<div className="sp-char-stream">
							{characters.map(([name, c]) => (
								<div key={name} className="sp-char-entry">
									<div className="sp-char-meta-row">
										<span className="sp-char-name">{name}</span>
										<div className="sp-char-affinity-group">
											<span className="sp-char-affinity-label">好感</span>
											<Editable
												value={String(c.affinity)}
												onSave={(v) => patch({ characters: { [name]: { affinity: num(v, c.affinity) } } })}
											/>
										</div>
										<ConfirmButton
											title={`移除「${name}」的状态记录`}
											aria-label="移除角色记录"
											confirmText="移除"
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
									<div className="sp-char-desc-row">
										<span className="sp-desc-tag">状态</span>
										<span className="sp-desc-text">
											<Editable value={c.status} placeholder="（当前神态/动作）" onSave={(v) => patch({ characters: { [name]: { status: v } } })} />
										</span>
									</div>
									<div className="sp-char-desc-row">
										<span className="sp-desc-tag">现处</span>
										<span className="sp-desc-text">
											<Editable
												value={c.at ?? ""}
												placeholder="（所在地）"
												onSave={(v) => patch({ characters: { [name]: { at: v } } })}
											/>
										</span>
									</div>
									{c.notes && (
										<div className="sp-char-desc-row sp-notes-row">
											<span className="sp-desc-tag">心境</span>
											<span className="sp-desc-text sp-notes-text">
												<Editable value={c.notes} placeholder="（心境与暗线）" onSave={(v) => patch({ characters: { [name]: { notes: v } } })} />
											</span>
										</div>
									)}
								</div>
							))}
						</div>
					)}
				</div>
			</section>

			{/* ── 随身行囊 ── */}
			<section className="sp-section">
				<div className="sp-section-head">
					<span className="sp-section-title">随身物品</span>
				</div>
				<div className="sp-section-body">
					<div className="sp-kv-row">
						<span className="sp-kv-key">行囊持有</span>
						<span className="sp-kv-val">
							<Editable
								value={inventory.join("、")}
								placeholder="（无随身器物）"
								onSave={(v) => patch({ inventory: v.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) })}
							/>
						</span>
					</div>
				</div>
			</section>

			{/* ── 剧情主线与备忘 ── */}
			<section className="sp-section">
				<div className="sp-section-head">
					<span className="sp-section-title">剧情风云线</span>
				</div>
				<div className="sp-section-body">
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
					<div className="sp-section-head">
						<span className="sp-section-title">世态标记</span>
					</div>
					<div className="sp-section-body">
						{flags.map(([k, v]) => (
							<div key={k} className="sp-kv-row">
								<span className="sp-kv-key">{k}</span>
								<span className="sp-kv-val">
									<Editable value={v} onSave={(nv) => patch({ flags: { [k]: nv } })} />
									<ConfirmButton title={`删除标记「${k}」`} aria-label="删除标记" confirmText="删除" onConfirm={() => patch({ flags: { [k]: null } })}>
										<IconTrash size={12} />
									</ConfirmButton>
								</span>
							</div>
						))}
					</div>
				</section>
			)}

			<div className="sp-footer-hint">
				数据随剧情自动归卷；点铅笔可随时勘校，改动随当前世界线分支留存与回退。
			</div>
		</div>
	);
}
