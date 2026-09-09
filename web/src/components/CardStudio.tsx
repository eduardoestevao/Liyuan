import { useEffect, useRef, useState } from "react";
import type {
	CardOutline,
	CardProjectBuild,
	CardProjectPreview,
	CardProjectStatus,
	CardResource,
	CardSectionId,
} from "../../../src/card-authoring-types.ts";
import { apiGet, apiGetCacheClear, apiPost, type CardResponse } from "../api.ts";
import { buildCardAuthoringPreview, CARD_PREVIEW_SANDBOX, cardPreviewUrl } from "../cardAuthoringPreview.ts";
import { BrandLogo } from "./BrandLogo.tsx";
import { IconChevronLeft, IconClose } from "./icons.tsx";
import "./CardStudio.css";

type SectionCode = "00" | "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09";

interface SectionMeta {
	code: SectionCode;
	id: CardSectionId | "export";
	num: string;
	title: string;
	desc: string;
}

const SECTIONS: SectionMeta[] = [
	{ code: "00", id: "settings", num: "00", title: "作品设置", desc: "这里只保留整张角色卡共用的信息。具体内容从创作目录进入对应部分完成。" },
	{ code: "01", id: "settings", num: "01", title: "角色设定", desc: "设定主角的性格生境、外貌特征、处境场景与对话示范。" },
	{ code: "02", id: "lore-knowledge", num: "02", title: "世界书与设定集", desc: "管理角色卡自带的世界书设定条目，支持常驻规则与关键词触发设定。" },
	{ code: "03", id: "rules", num: "03", title: "创作与系统规则", desc: "直接约束模型输出的系统级提示词与末端指令。" },
	{ code: "04", id: "greetings", num: "04", title: "第一条消息与开场分支", desc: "第一条消息是故事的起点。可配置默认开场白与多个备选分支。" },
	{ code: "05", id: "mvu", num: "05", title: "MVU 变量系统", desc: "定义状态追踪、数值好感、背包与世界变量及更新规则。" },
	{ code: "06", id: "ui", num: "06", title: "状态栏与卡面组件", desc: "运行在消息楼层或页面上的状态栏 HTML / CSS 模板与挂载点。" },
	{ code: "07", id: "prompt-regex", num: "07", title: "消息前端与显示正则", desc: "控制消息美化、标签清洗与客户端渲染正则。" },
	{ code: "08", id: "ejs", num: "08", title: "EJS 动态模板", desc: "SillyTavern ST-Prompt-Template 动态条件分支与阶段人设。" },
	{ code: "09", id: "export", num: "09", title: "检查与导出", desc: "全面检查角色卡语法、资源完整性、外部依赖并保存或导出。" },
];

interface RawCardData {
	name?: string;
	description?: string;
	personality?: string;
	scenario?: string;
	mes_example?: string;
	creator_notes?: string;
	system_prompt?: string;
	post_history_instructions?: string;
	creator?: string;
	character_version?: string;
	tags?: string[];
	first_mes?: string;
	alternate_greetings?: string[];
	character_book?: {
		name?: string;
		description?: string;
		entries?: Array<{
			id?: number | string;
			comment?: string;
			content?: string;
			constant?: boolean;
			enabled?: boolean;
			position?: string;
			keys?: string[];
			secondary_keys?: string[];
			selective?: boolean;
			insertion_order?: number;
			extensions?: {
				position?: number;
				depth?: number;
				role?: number;
				probability?: number;
			};
		}>;
	};
	extensions?: {
		regex_scripts?: Array<{
			id?: string;
			scriptName?: string;
			findRegex?: string;
			replaceString?: string;
			placement?: number[];
			disabled?: boolean;
			markdownOnly?: boolean;
			promptOnly?: boolean;
		}>;
		tavern_helper?: {
			scripts?: Array<{
				id?: string;
				name?: string;
				type?: string;
				content?: string;
				enabled?: boolean;
			}>;
			variables?: Record<string, unknown>;
		};
	};
}

export function CardStudio({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
	const [cardInfo, setCardInfo] = useState<CardResponse | null>(null);
	const [status, setStatus] = useState<CardProjectStatus | null>(null);
	const [outline, setOutline] = useState<CardOutline | null>(null);
	const [rawCard, setRawCard] = useState<RawCardData | null>(null);
	const [activeSec, setActiveSec] = useState<SectionCode>("00");

	// 加载与通知
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");
	const [error, setError] = useState("");
	const [build, setBuild] = useState<CardProjectBuild | null>(null);

	// 局部编辑缓冲（资源 ID -> 当前编辑文本）
	const [drafts, setDrafts] = useState<Record<string, string>>({});

	// 世界书检索与选择
	const [loreSearch, setLoreSearch] = useState("");
	const [loreFilter, setLoreFilter] = useState<"all" | "constant" | "keyed" | "disabled">("all");
	const [selectedLoreIdx, setSelectedLoreIdx] = useState<number>(0);

	// 开场白选择 (0=first_mes, 1..=alternate)
	const [selectedGreetingIdx, setSelectedGreetingIdx] = useState<number>(0);

	// 状态栏与正则选择
	const [selectedUiIdx, setSelectedUiIdx] = useState<number>(0);
	const [selectedRegexIdx, setSelectedRegexIdx] = useState<number>(0);

	// 本地封面文件预览 URL
	const [customCoverUrl, setCustomCoverUrl] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// 测试预览弹层
	const [preview, setPreview] = useState<{ url: string; token: string } | null>(null);
	const frame = useRef<HTMLIFrameElement>(null);
	const active = useRef(true);

	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);

	const cardPath = cardInfo?.path ?? "";
	const coverUrl = customCoverUrl || (cardPath ? `/api/cards/image?path=${encodeURIComponent(cardPath)}` : null);

	const operation = <T,>(args: Record<string, unknown>) =>
		apiPost<T>("/api/card/authoring", { ...args, card: cardPath });

	// 初始化与自动准备创作工程
	const refreshAll = async () => {
		if (!cardPath) return;
		try {
			let curStatus = await apiGet<CardProjectStatus>(
				`/api/card/authoring?card=${encodeURIComponent(cardPath)}`,
				{ bypassCache: true }
			);
			if (!curStatus.prepared) {
				curStatus = await operation<CardProjectStatus>({ action: "prepare" });
			}
			const curOutline = await operation<CardOutline>({ action: "outline", full: true });
			const rawRes = await operation<{ text: string }>({ action: "read", resource: "raw" });
			let parsed: RawCardData = {};
			try {
				const full = JSON.parse(rawRes.text);
				parsed = (full.data && typeof full.data === "object" ? full.data : full) as RawCardData;
			} catch {}

			if (active.current) {
				setStatus(curStatus);
				setOutline(curOutline);
				setRawCard(parsed);
			}
		} catch (e) {
			if (active.current) setError(e instanceof Error ? e.message : String(e));
		}
	};

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const info = await apiGet<CardResponse>("/api/card");
				if (!cancelled) setCardInfo(info);
				let curStatus = await apiGet<CardProjectStatus>(
					`/api/card/authoring?card=${encodeURIComponent(info.path)}`,
					{ bypassCache: true }
				);
				if (!curStatus.prepared) {
					curStatus = await apiPost<CardProjectStatus>("/api/card/authoring", {
						card: info.path,
						action: "prepare",
					});
				}
				const curOutline = await apiPost<CardOutline>("/api/card/authoring", {
					card: info.path,
					action: "outline",
					full: true,
				});
				const rawRes = await apiPost<{ text: string }>("/api/card/authoring", {
					card: info.path,
					action: "read",
					resource: "raw",
				});
				let parsed: RawCardData = {};
				try {
					const full = JSON.parse(rawRes.text);
					parsed = (full.data && typeof full.data === "object" ? full.data : full) as RawCardData;
				} catch {}

				if (!cancelled) {
					setStatus(curStatus);
					setOutline(curOutline);
					setRawCard(parsed);
				}
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// 查找某个字段路径对应的 resource
	const findResource = (pathKey: string): CardResource | undefined => {
		if (!status) return undefined;
		return status.resources.find((r) => r.path.join(".") === pathKey || r.path.slice(-1)[0] === pathKey);
	};

	// 获取当前字段的值（优先本地草稿，其次原数据）
	const getFieldValue = (resId: string, fallback: string = ""): string => {
		if (drafts[resId] !== undefined) return drafts[resId];
		return fallback;
	};

	// 异步读取某个资源原文并放入草稿
	const ensureDraft = async (resource: CardResource) => {
		if (drafts[resource.id] !== undefined) return;
		try {
			const res = await operation<{ text: string }>({ action: "read", resource: resource.id });
			setDrafts((prev) => ({ ...prev, [resource.id]: res.text }));
		} catch (e) {
			console.error("读取资源失败", resource.id, e);
		}
	};

	// 保存某个资源
	const saveResource = async (resource: CardResource, newText: string) => {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			const readRes = await operation<{ hash: string }>({ action: "read", resource: resource.id });
			await operation({
				action: "write",
				resource: resource.id,
				text: newText,
				version: readRes.hash,
			});
			setNotice(`已保存：${resource.name}`);
			await refreshAll();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	// 检查
	const handleCheck = async () => {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			const result = await operation<CardProjectBuild>({ action: "check" });
			setBuild(result);
			if (result.errors.length) {
				setError(`检查发现 ${result.errors.length} 处错误`);
			} else {
				setNotice(`检查通过！共 ${result.changed.length} 项变更待应用`);
			}
			await refreshAll();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	// 应用到角色卡
	const handleApply = async () => {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			let currentBuild = build;
			if (!currentBuild || !currentBuild.hash) {
				currentBuild = await operation<CardProjectBuild>({ action: "check" });
				setBuild(currentBuild);
			}
			if (currentBuild.errors.length) {
				throw new Error("请先修复检查错误再应用");
			}
			await operation({ action: "apply", buildHash: currentBuild.hash });
			apiGetCacheClear("/api/card");
			setNotice("已成功应用到当前角色卡！");
			onApplied();
			await refreshAll();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	// 撤回应用
	const handleUndo = async () => {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await operation({ action: "undo" });
			apiGetCacheClear("/api/card");
			setNotice("已撤回上次应用，草稿仍保留在本地。");
			onApplied();
			await refreshAll();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	// 触发测试预览
	const handlePreview = async () => {
		setBusy(true);
		setError("");
		try {
			const data = await apiPost<CardProjectPreview>("/api/card/authoring/preview", { card: cardPath });
			const sample = data.greetings[0] || "";
			const values = data.variables || {};
			const token = String(Date.now()) + "-" + Math.random().toString(36).slice(2);
			setPreview({ token, url: cardPreviewUrl(buildCardAuthoringPreview(data, sample, values, token)) });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const changedCount = status?.resources.filter((r) => r.changed).length ?? 0;
	const curSectionMeta = SECTIONS.find((s) => s.code === activeSec)!;

	// --------------------------------------------------------------------------
	// 渲染不同板块的真实编辑表单
	// --------------------------------------------------------------------------

	// 00 作品设置
	const renderSection00 = () => {
		const nameRes = findResource("name");
		const descRes = findResource("description");
		const creatorRes = findResource("creator");
		const verRes = findResource("character_version");

		const curName = getFieldValue(nameRes?.id ?? "", rawCard?.name ?? cardInfo?.name ?? "");
		const curDesc = getFieldValue(descRes?.id ?? "", rawCard?.description ?? cardInfo?.description ?? "");
		const curCreator = getFieldValue(creatorRes?.id ?? "", rawCard?.creator ?? "");
		const curVer = getFieldValue(verRes?.id ?? "", rawCard?.character_version ?? "1.0.0");

		return (
			<div className="cs-grid-2col">
				<div className="cs-card">
					<div className="cs-card-title">
						<span className="cs-arrow-gold">&gt;</span> 封面
					</div>
					<div className="cs-cover-placeholder">
						{coverUrl ? (
							<img src={coverUrl} alt="封面" className="cs-cover-img" />
						) : (
							<>
								<span style={{ fontSize: 24 }}>🖼️</span>
								<span>尚未设置封面</span>
							</>
						)}
					</div>
					<div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>角色卡图片</div>
					<div className="cs-cover-desc">
						选择 PNG 图像后可即时预览，在「09 检查与导出」中可直接打包导出带封面的角色卡。
					</div>
					<input
						ref={fileInputRef}
						type="file"
						accept="image/png,image/jpeg,image/webp"
						style={{ display: "none" }}
						onChange={(e) => {
							const file = e.target.files?.[0];
							if (!file) return;
							const reader = new FileReader();
							reader.onload = () => {
								if (typeof reader.result === "string") {
									setCustomCoverUrl(reader.result);
									setNotice("已加载新封面预览（导出时可打包）");
								}
							};
							reader.readAsDataURL(file);
						}}
					/>
					<button
						type="button"
						className="cs-btn-ghost"
						style={{ width: "100%", justifyContent: "center" }}
						onClick={() => fileInputRef.current?.click()}
					>
						更换封面图片
					</button>
				</div>

				<div>
					<div className="cs-card">
						<div className="cs-field">
							<label className="cs-label">卡名</label>
							<input
								type="text"
								className="cs-input"
								value={curName}
								onChange={(e) => {
									if (nameRes) setDrafts((d) => ({ ...d, [nameRes.id]: e.target.value }));
								}}
								placeholder="给角色卡起一个名字"
							/>
						</div>
						<div className="cs-field">
							<label className="cs-label">简短介绍</label>
							<textarea
								className="cs-textarea"
								value={curDesc}
								onChange={(e) => {
									if (descRes) setDrafts((d) => ({ ...d, [descRes.id]: e.target.value }));
								}}
								placeholder="用一两句话说明这张角色卡是什么。"
								rows={4}
							/>
						</div>
						<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
							<div className="cs-field">
								<label className="cs-label">作者</label>
								<input
									type="text"
									className="cs-input"
									value={curCreator}
									onChange={(e) => {
										if (creatorRes) setDrafts((d) => ({ ...d, [creatorRes.id]: e.target.value }));
									}}
									placeholder="作者名"
								/>
							</div>
							<div className="cs-field">
								<label className="cs-label">版本</label>
								<input
									type="text"
									className="cs-input"
									value={curVer}
									onChange={(e) => {
										if (verRes) setDrafts((d) => ({ ...d, [verRes.id]: e.target.value }));
									}}
									placeholder="1.0.0"
								/>
							</div>
						</div>
						<div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
							<button
								type="button"
								className="cs-btn-primary"
								disabled={busy}
								onClick={async () => {
									if (nameRes && drafts[nameRes.id] !== undefined) await saveResource(nameRes, drafts[nameRes.id]);
									if (descRes && drafts[descRes.id] !== undefined) await saveResource(descRes, drafts[descRes.id]);
									if (creatorRes && drafts[creatorRes.id] !== undefined) await saveResource(creatorRes, drafts[creatorRes.id]);
									if (verRes && drafts[verRes.id] !== undefined) await saveResource(verRes, drafts[verRes.id]);
									setNotice("基本设置已保存到草稿！");
								}}
							>
								保存基本设置
							</button>
						</div>
					</div>

					<div className="cs-infobox">
						<div className="cs-infobox-title">保存在当前设备</div>
						<p className="cs-infobox-text">
							名称、封面和后续创作内容都会自动保存；所有数据保存在本地工作区。
						</p>
					</div>
				</div>
			</div>
		);
	};

	// 01 角色设定 (Personality / Scenario / Mes Example)
	const renderSection01 = () => {
		const persRes = findResource("personality");
		const scenRes = findResource("scenario");
		const mesRes = findResource("mes_example");
		const noteRes = findResource("creator_notes");

		const curPers = getFieldValue(persRes?.id ?? "", rawCard?.personality ?? "");
		const curScen = getFieldValue(scenRes?.id ?? "", rawCard?.scenario ?? "");
		const curMes = getFieldValue(mesRes?.id ?? "", rawCard?.mes_example ?? "");
		const curNote = getFieldValue(noteRes?.id ?? "", rawCard?.creator_notes ?? "");

		return (
			<div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
				<div className="cs-card">
					<div className="cs-field">
						<label className="cs-label">性格与特征 (Personality)</label>
						<textarea
							className="cs-textarea"
							rows={5}
							value={curPers}
							onChange={(e) => {
								if (persRes) setDrafts((d) => ({ ...d, [persRes.id]: e.target.value }));
							}}
							placeholder="描述角色的性情、行为风格、语气口吻与价值观..."
						/>
					</div>
					<div className="cs-field">
						<label className="cs-label">场景与处境 (Scenario)</label>
						<textarea
							className="cs-textarea"
							rows={4}
							value={curScen}
							onChange={(e) => {
								if (scenRes) setDrafts((d) => ({ ...d, [scenRes.id]: e.target.value }));
							}}
							placeholder="描述故事的初始处境、当前背景与互动条件..."
						/>
					</div>
					<div className="cs-field">
						<label className="cs-label">对话示范 (Dialogue Examples)</label>
						<textarea
							className="cs-textarea cs-textarea-code"
							rows={6}
							value={curMes}
							onChange={(e) => {
								if (mesRes) setDrafts((d) => ({ ...d, [mesRes.id]: e.target.value }));
							}}
							placeholder="<START>&#10;{{user}}: 你好&#10;{{char}}: 很高兴见到你。"
						/>
					</div>
					<div className="cs-field">
						<label className="cs-label">作者附注 (Creator Notes)</label>
						<textarea
							className="cs-textarea"
							rows={3}
							value={curNote}
							onChange={(e) => {
								if (noteRes) setDrafts((d) => ({ ...d, [noteRes.id]: e.target.value }));
							}}
							placeholder="写给玩家或作者自己的创作备忘..."
						/>
					</div>
					<div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
						<button
							type="button"
							className="cs-btn-primary"
							disabled={busy}
							onClick={async () => {
								if (persRes && drafts[persRes.id] !== undefined) await saveResource(persRes, drafts[persRes.id]);
								if (scenRes && drafts[scenRes.id] !== undefined) await saveResource(scenRes, drafts[scenRes.id]);
								if (mesRes && drafts[mesRes.id] !== undefined) await saveResource(mesRes, drafts[mesRes.id]);
								if (noteRes && drafts[noteRes.id] !== undefined) await saveResource(noteRes, drafts[noteRes.id]);
								setNotice("角色设定已保存！");
							}}
						>
							保存角色设定
						</button>
					</div>
				</div>
			</div>
		);
	};

	// 02 世界书与设定集（带搜索检索、分类过滤、条目属性编辑与正文编辑）
	const renderSection02 = () => {
		const rawEntries = rawCard?.character_book?.entries || [];
		const loreResources = status?.resources.filter((r) => r.kind === "lore") || [];

		// 过滤条目
		const filteredIndices = rawEntries
			.map((e, idx) => ({ e, idx }))
			.filter(({ e }) => {
				if (loreFilter === "constant" && !e.constant) return false;
				if (loreFilter === "keyed" && (!e.keys || e.keys.length === 0)) return false;
				if (loreFilter === "disabled" && e.enabled !== false) return false;
				if (!loreSearch.trim()) return true;
				const q = loreSearch.toLowerCase();
				return (
					(e.comment || "").toLowerCase().includes(q) ||
					(e.content || "").toLowerCase().includes(q) ||
					(e.keys || []).some((k) => k.toLowerCase().includes(q))
				);
			})
			.map(({ idx }) => idx);

		const activeIdx = filteredIndices.includes(selectedLoreIdx)
			? selectedLoreIdx
			: (filteredIndices[0] ?? 0);
		const currentEntry = rawEntries[activeIdx];
		const currentRes = loreResources[activeIdx];
		const curContent = currentRes ? getFieldValue(currentRes.id, currentEntry?.content || "") : "";

		return (
			<div className="cs-split-pane">
				<div className="cs-split-list">
					<div className="cs-split-list-header">
						<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
							<span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-strong)" }}>
								设定条目 ({rawEntries.length})
							</span>
							<span className="cs-badge cs-badge-gray">匹配 {filteredIndices.length} 项</span>
						</div>
						<input
							type="text"
							className="cs-search-input"
							placeholder="搜索条目名 / 关键词 / 正文..."
							value={loreSearch}
							onChange={(e) => setLoreSearch(e.target.value)}
						/>
						<div className="cs-filter-row">
							<button
								type="button"
								className={`cs-pill-btn ${loreFilter === "all" ? "is-active" : ""}`}
								onClick={() => setLoreFilter("all")}
							>
								全部 ({rawEntries.length})
							</button>
							<button
								type="button"
								className={`cs-pill-btn ${loreFilter === "constant" ? "is-active" : ""}`}
								onClick={() => setLoreFilter("constant")}
							>
								常驻
							</button>
							<button
								type="button"
								className={`cs-pill-btn ${loreFilter === "keyed" ? "is-active" : ""}`}
								onClick={() => setLoreFilter("keyed")}
							>
								关键词
							</button>
							<button
								type="button"
								className={`cs-pill-btn ${loreFilter === "disabled" ? "is-active" : ""}`}
								onClick={() => setLoreFilter("disabled")}
							>
								已停用
							</button>
						</div>
					</div>

					<div className="cs-split-list-items">
						{filteredIndices.map((idx) => {
							const e = rawEntries[idx];
							const isAct = idx === activeIdx;
							const res = loreResources[idx];
							const isChanged = res?.changed;
							return (
								<div
									key={idx}
									className={`cs-split-item ${isAct ? "is-active" : ""}`}
									onClick={() => {
										setSelectedLoreIdx(idx);
										if (res) ensureDraft(res);
									}}
								>
									<div className="cs-split-item-row">
										<span className="cs-split-item-title">{e.comment || `条目 #${idx + 1}`}</span>
										{isChanged && <span className="cs-badge cs-badge-gold">已改</span>}
									</div>
									<div className="cs-split-item-meta">
										<span>{(e.content || "").length} 字</span>
										{e.constant && <span className="cs-badge cs-badge-green">常驻</span>}
										{e.keys && e.keys.length > 0 && <span>{e.keys.length} 词</span>}
										{e.enabled === false && <span style={{ color: "var(--text-faint)" }}>停用</span>}
									</div>
								</div>
							);
						})}
					</div>
				</div>

				<div className="cs-split-detail">
					{currentEntry ? (
						<>
							<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
								<div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-strong)" }}>
									{currentEntry.comment || `条目 #${activeIdx + 1}`}
								</div>
								<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
									<button
										type="button"
										className={`cs-toggle-btn ${currentEntry.constant ? "is-on" : ""}`}
										onClick={() => {
											currentEntry.constant = !currentEntry.constant;
											setNotice(currentEntry.constant ? "已切换为常驻注入（蓝灯）" : "已切换为按需触发");
										}}
									>
										{currentEntry.constant ? "常驻注入 (开)" : "关键词触发"}
									</button>
									<button
										type="button"
										className={`cs-toggle-btn ${currentEntry.enabled !== false ? "is-on" : ""}`}
										onClick={() => {
											currentEntry.enabled = currentEntry.enabled === false;
											setNotice(currentEntry.enabled ? "条目已启用" : "条目已停用");
										}}
									>
										{currentEntry.enabled !== false ? "已启用" : "已停用"}
									</button>
								</div>
							</div>

							<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
								<div className="cs-field">
									<label className="cs-label">条目备注 / 名称</label>
									<input
										type="text"
										className="cs-input"
										value={currentEntry.comment || ""}
										onChange={(e) => {
											currentEntry.comment = e.target.value;
											setNotice("条目名称已更新");
										}}
										placeholder="例如：世界观、境界划分、角色关系"
									/>
								</div>
								<div className="cs-field">
									<label className="cs-label">触发关键词 (逗号分隔)</label>
									<input
										type="text"
										className="cs-input"
										value={(currentEntry.keys || []).join(", ")}
										onChange={(e) => {
											currentEntry.keys = e.target.value
												.split(/[,，]/)
												.map((k) => k.trim())
												.filter(Boolean);
										}}
										placeholder="常驻条目无需填写"
									/>
								</div>
							</div>

							<div className="cs-field" style={{ flex: 1, display: "flex", flexDirection: "column" }}>
								<div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
									<label className="cs-label">设定正文</label>
									<span style={{ fontSize: 11, color: "var(--text-faint)" }}>
										{curContent.length} 字 · {curContent.split("\n").length} 行
									</span>
								</div>
								<textarea
									className="cs-textarea cs-textarea-code"
									style={{ flex: 1, minHeight: 340 }}
									value={curContent}
									onChange={(e) => {
										if (currentRes) setDrafts((d) => ({ ...d, [currentRes.id]: e.target.value }));
									}}
									placeholder="在此编写详细设定正文..."
								/>
							</div>

							<div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
								<button
									type="button"
									className="cs-btn-primary"
									disabled={busy || !currentRes}
									onClick={async () => {
										if (currentRes && drafts[currentRes.id] !== undefined) {
											await saveResource(currentRes, drafts[currentRes.id]);
										}
									}}
								>
									保存此条目
								</button>
							</div>
						</>
					) : (
						<div style={{ color: "var(--text-faint)", padding: 40, textAlign: "center" }}>
							没有匹配的条目，请调整筛选条件。
						</div>
					)}
				</div>
			</div>
		);
	};

	// 03 创作与系统规则
	const renderSection03 = () => {
		const sysRes = findResource("system_prompt");
		const postRes = findResource("post_history_instructions");
		const curSys = getFieldValue(sysRes?.id ?? "", rawCard?.system_prompt ?? "");
		const curPost = getFieldValue(postRes?.id ?? "", rawCard?.post_history_instructions ?? "");

		return (
			<div className="cs-card" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
				<div className="cs-field">
					<label className="cs-label">卡内系统提示 (System Prompt)</label>
					<div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 4 }}>
						注入在模型上下文最顶层的系统角色提示词。
					</div>
					<textarea
						className="cs-textarea cs-textarea-code"
						rows={8}
						value={curSys}
						onChange={(e) => {
							if (sysRes) setDrafts((d) => ({ ...d, [sysRes.id]: e.target.value }));
						}}
						placeholder="设定世界规则、演出准则与格式限制..."
					/>
				</div>

				<div className="cs-field">
					<label className="cs-label">卡内末端提示 (Post History Instructions)</label>
					<div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 4 }}>
						注入在历史聊天记录最末尾的强化指示（常用于输出格式约束）。
					</div>
					<textarea
						className="cs-textarea cs-textarea-code"
						rows={5}
						value={curPost}
						onChange={(e) => {
							if (postRes) setDrafts((d) => ({ ...d, [postRes.id]: e.target.value }));
						}}
						placeholder="在生成前最后提醒模型的关键要点..."
					/>
				</div>

				<div style={{ display: "flex", justifyContent: "flex-end" }}>
					<button
						type="button"
						className="cs-btn-primary"
						disabled={busy}
						onClick={async () => {
							if (sysRes && drafts[sysRes.id] !== undefined) await saveResource(sysRes, drafts[sysRes.id]);
							if (postRes && drafts[postRes.id] !== undefined) await saveResource(postRes, drafts[postRes.id]);
							setNotice("创作规则已保存！");
						}}
					>
						保存规则配置
					</button>
				</div>
			</div>
		);
	};

	// 04 开场白与分支故事
	const renderSection04 = () => {
		const greetings = [rawCard?.first_mes || "", ...(rawCard?.alternate_greetings || [])];
		const greetingResources = status?.resources.filter((r) => r.kind === "greeting") || [];
		const curGreetingRes = greetingResources[selectedGreetingIdx];
		const curGreetingText = curGreetingRes
			? getFieldValue(curGreetingRes.id, greetings[selectedGreetingIdx] || "")
			: "";

		return (
			<div className="cs-card">
				<div className="cs-tabs">
					{greetings.map((_, idx) => (
						<button
							key={idx}
							type="button"
							className={`cs-tab ${selectedGreetingIdx === idx ? "is-active" : ""}`}
							onClick={() => {
								setSelectedGreetingIdx(idx);
								if (greetingResources[idx]) ensureDraft(greetingResources[idx]);
							}}
						>
							{idx === 0 ? "默认开场 (first_mes)" : `备选开场 ${idx}`}
						</button>
					))}
				</div>

				<div className="cs-field">
					<div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
						<label className="cs-label">
							{selectedGreetingIdx === 0 ? "默认第一条消息内容" : `备选开场 #${selectedGreetingIdx} 正文`}
						</label>
						<span style={{ fontSize: 11, color: "var(--text-faint)" }}>
							{curGreetingText.length} 字
						</span>
					</div>
					<textarea
						className="cs-textarea cs-textarea-code"
						rows={14}
						value={curGreetingText}
						onChange={(e) => {
							if (curGreetingRes) setDrafts((d) => ({ ...d, [curGreetingRes.id]: e.target.value }));
						}}
						placeholder="输入故事开篇第一条发言..."
					/>
				</div>

				<div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
					<button
						type="button"
						className="cs-btn-primary"
						disabled={busy || !curGreetingRes}
						onClick={async () => {
							if (curGreetingRes && drafts[curGreetingRes.id] !== undefined) {
								await saveResource(curGreetingRes, drafts[curGreetingRes.id]);
								setNotice("开场白已保存！");
							}
						}}
					>
						保存当前开场白
					</button>
				</div>
			</div>
		);
	};

	// 05 MVU 变量系统
	const renderSection05 = () => {
		const mvuItems = outline?.sections.find((s) => s.id === "mvu")?.items || [];
		return (
			<div className="cs-card">
				<div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-strong)", marginBottom: 12 }}>
					MVU 变量资产清单 ({mvuItems.length})
				</div>
				{mvuItems.length === 0 ? (
					<div style={{ color: "var(--text-faint)", padding: 24, textAlign: "center" }}>
						当前角色卡未检测到独立的 MVU 变量声明。
					</div>
				) : (
					<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
						{mvuItems.map((item) => {
							const res = status?.resources.find((r) => item.resources.includes(r.id));
							const text = res ? getFieldValue(res.id, "") : "";
							return (
								<div
									key={item.key}
									style={{
										padding: 14,
										background: "var(--surface-dim)",
										border: "1px solid var(--hairline-strong)",
										borderRadius: "var(--radius-s)",
									}}
								>
									<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
										<div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>
											{item.label}
										</div>
										<span className="cs-badge cs-badge-green">已挂载</span>
									</div>
									{res ? (
										<div>
											<textarea
												className="cs-textarea cs-textarea-code"
												rows={6}
												value={text}
												onFocus={() => ensureDraft(res)}
												onChange={(e) => setDrafts((d) => ({ ...d, [res.id]: e.target.value }))}
											/>
											<div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
												<button
													type="button"
													className="cs-btn-primary"
													disabled={busy}
													onClick={() => saveResource(res, drafts[res.id] ?? "")}
												>
													保存规则内容
												</button>
											</div>
										</div>
									) : (
										<div style={{ fontSize: 11, color: "var(--text-faint)" }}>
											键数：{String(item.facts.keys || 0)} · 命名空间：{String(item.facts.namespace || "tavern_helper")}
										</div>
									)}
								</div>
							);
						})}
					</div>
				)}
			</div>
		);
	};

	// 06 状态栏与卡面组件（带真实 HTML/CSS 模板编辑与预览）
	const renderSection06 = () => {
		const uiItems = outline?.sections.find((s) => s.id === "ui")?.items || [];
		const curUiItem = uiItems[selectedUiIdx];
		// ui item 的 resources 通常是 [patternResId, templateResId]
		const templateResId = curUiItem?.resources[1] || curUiItem?.resources[0];
		const templateRes = status?.resources.find((r) => r.id === templateResId);
		const curTemplateCode = templateRes ? getFieldValue(templateRes.id, "") : "";

		return (
			<div className="cs-split-pane">
				<div className="cs-split-list">
					<div className="cs-split-list-header">
						<span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-strong)" }}>
							状态栏与界面组件 ({uiItems.length})
						</span>
					</div>
					<div className="cs-split-list-items">
						{uiItems.map((item, idx) => {
							const isAct = idx === selectedUiIdx;
							return (
								<div
									key={item.key}
									className={`cs-split-item ${isAct ? "is-active" : ""}`}
									onClick={() => {
										setSelectedUiIdx(idx);
										const res = status?.resources.find((r) => (item.resources[1] || item.resources[0]) === r.id);
										if (res) ensureDraft(res);
									}}
								>
									<span className="cs-split-item-title">{item.label}</span>
									<div className="cs-split-item-meta">
										<span>{item.size} 字节</span>
										{item.facts.placeholder && <span className="cs-badge cs-badge-gold">状态栏</span>}
									</div>
								</div>
							);
						})}
						{uiItems.length === 0 && (
							<div style={{ color: "var(--text-faint)", padding: 16, fontSize: 12 }}>
								无独立状态栏组件
							</div>
						)}
					</div>
				</div>

				<div className="cs-split-detail">
					{curUiItem && templateRes ? (
						<>
							<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
								<div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)" }}>
									{curUiItem.label}
								</div>
								<div style={{ display: "flex", gap: 8 }}>
									<button type="button" className="cs-btn-ghost" onClick={handlePreview} disabled={busy}>
										实时运行预览
									</button>
								</div>
							</div>

							<div className="cs-field">
								<div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
									<label className="cs-label">HTML / CSS 渲染模板源码</label>
									<span style={{ fontSize: 11, color: "var(--text-faint)" }}>
										{curTemplateCode.length} 字节 · {curTemplateCode.split("\n").length} 行
									</span>
								</div>
								<textarea
									className="cs-textarea cs-textarea-code"
									style={{ flex: 1, minHeight: 360 }}
									value={curTemplateCode}
									onFocus={() => ensureDraft(templateRes)}
									onChange={(e) => setDrafts((d) => ({ ...d, [templateRes.id]: e.target.value }))}
									placeholder="<div>状态栏 HTML 模板</div>"
								/>
							</div>

							<div style={{ display: "flex", justifyContent: "flex-end" }}>
								<button
									type="button"
									className="cs-btn-primary"
									disabled={busy}
									onClick={() => saveResource(templateRes, drafts[templateRes.id] ?? "")}
								>
									保存模板代码
								</button>
							</div>
						</>
					) : (
						<div style={{ color: "var(--text-faint)", padding: 40, textAlign: "center" }}>
							请从左侧选择状态栏或界面组件。
						</div>
					)}
				</div>
			</div>
		);
	};

	// 07 消息前端与显示正则（可查看并修改 find 与 replace 模板）
	const renderSection07 = () => {
		const regexList = rawCard?.extensions?.regex_scripts || [];
		const regexItems = outline?.sections.find((s) => s.id === "prompt-regex")?.items || [];
		const curItem = regexItems[selectedRegexIdx];
		const patternRes = status?.resources.find((r) => curItem?.resources[0] === r.id);
		const templateRes = status?.resources.find((r) => curItem?.resources[1] === r.id);

		const curFind = patternRes ? getFieldValue(patternRes.id, "") : (regexList[selectedRegexIdx]?.findRegex || "");
		const curReplace = templateRes ? getFieldValue(templateRes.id, "") : (regexList[selectedRegexIdx]?.replaceString || "");

		return (
			<div className="cs-split-pane">
				<div className="cs-split-list">
					<div className="cs-split-list-header">
						<span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-strong)" }}>
							正则规则清单 ({regexList.length})
						</span>
					</div>
					<div className="cs-split-list-items">
						{regexList.map((r, idx) => {
							const isAct = idx === selectedRegexIdx;
							return (
								<div
									key={idx}
									className={`cs-split-item ${isAct ? "is-active" : ""}`}
									onClick={() => {
										setSelectedRegexIdx(idx);
										const item = regexItems[idx];
										if (item) {
											const p = status?.resources.find((res) => item.resources[0] === res.id);
											const t = status?.resources.find((res) => item.resources[1] === res.id);
											if (p) ensureDraft(p);
											if (t) ensureDraft(t);
										}
									}}
								>
									<span className="cs-split-item-title">{r.scriptName || `正则 #${idx + 1}`}</span>
									<div className="cs-split-item-meta">
										<span>{r.disabled ? "停用" : "生效"}</span>
										<span>{r.markdownOnly ? "仅显示" : "送模"}</span>
									</div>
								</div>
							);
						})}
					</div>
				</div>

				<div className="cs-split-detail">
					{regexList[selectedRegexIdx] ? (
						<>
							<div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)" }}>
								{regexList[selectedRegexIdx].scriptName || `正则 #${selectedRegexIdx + 1}`}
							</div>
							<div className="cs-field">
								<label className="cs-label">匹配表达式 (Find Regex)</label>
								<textarea
									className="cs-textarea cs-textarea-code"
									rows={3}
									value={curFind}
									onChange={(e) => {
										if (patternRes) setDrafts((d) => ({ ...d, [patternRes.id]: e.target.value }));
									}}
								/>
							</div>
							<div className="cs-field" style={{ flex: 1 }}>
								<label className="cs-label">替换内容 / 模板 (Replace String)</label>
								<textarea
									className="cs-textarea cs-textarea-code"
									style={{ minHeight: 220 }}
									value={curReplace}
									onChange={(e) => {
										if (templateRes) setDrafts((d) => ({ ...d, [templateRes.id]: e.target.value }));
									}}
								/>
							</div>
							<div style={{ display: "flex", justifyContent: "flex-end" }}>
								<button
									type="button"
									className="cs-btn-primary"
									disabled={busy}
									onClick={async () => {
										if (patternRes && drafts[patternRes.id] !== undefined) await saveResource(patternRes, drafts[patternRes.id]);
										if (templateRes && drafts[templateRes.id] !== undefined) await saveResource(templateRes, drafts[templateRes.id]);
										setNotice("正则规则已保存！");
									}}
								>
									保存此正则规则
								</button>
							</div>
						</>
					) : (
						<div style={{ color: "var(--text-faint)", padding: 40, textAlign: "center" }}>
							请选择要编辑的正则表达式。
						</div>
					)}
				</div>
			</div>
		);
	};

	// 08 EJS 动态模板
	const renderSection08 = () => {
		const ejsItems = outline?.sections.find((s) => s.id === "ejs")?.items || [];
		return (
			<div className="cs-card">
				<div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-strong)", marginBottom: 12 }}>
					EJS 动态分支条目 ({ejsItems.length})
				</div>
				{ejsItems.length === 0 ? (
					<div style={{ color: "var(--text-faint)", padding: 24, textAlign: "center" }}>
						当前角色卡未使用 EJS 条件分支模板。
					</div>
				) : (
					<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
						{ejsItems.map((item) => {
							const res = status?.resources.find((r) => item.resources.includes(r.id));
							const text = res ? getFieldValue(res.id, "") : "";
							return (
								<div
									key={item.key}
									style={{
										padding: 14,
										background: "var(--surface-dim)",
										border: "1px solid var(--hairline-strong)",
										borderRadius: "var(--radius-s)",
									}}
								>
									<div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)", marginBottom: 6 }}>
										{item.label}
									</div>
									{res && (
										<div>
											<textarea
												className="cs-textarea cs-textarea-code"
												rows={6}
												value={text}
												onFocus={() => ensureDraft(res)}
												onChange={(e) => setDrafts((d) => ({ ...d, [res.id]: e.target.value }))}
											/>
											<div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
												<button
													type="button"
													className="cs-btn-primary"
													disabled={busy}
													onClick={() => saveResource(res, drafts[res.id] ?? "")}
												>
													保存 EJS 模板
												</button>
											</div>
										</div>
									)}
								</div>
							);
						})}
					</div>
				)}
			</div>
		);
	};

	// 09 检查与导出
	const renderSection09 = () => {
		const changedList = status?.resources.filter((r) => r.changed) || [];
		const depItems = outline?.sections.find((s) => s.id === "deps")?.items || [];

		return (
			<div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
				<div className="cs-card">
					<div className="cs-card-title">
						<span className="cs-arrow-gold">&gt;</span> 完整性与语法检查
					</div>
					<p style={{ fontSize: 12, color: "var(--text-soft)", margin: "0 0 14px" }}>
						检查全部待更新的资源语法、正则表达式以及 JavaScript 代码规范。
					</p>
					<div style={{ display: "flex", alignItems: "center", gap: 12 }}>
						<button type="button" className="cs-btn-ghost" disabled={busy} onClick={handleCheck}>
							立即开始检查
						</button>
						{build && (
							<span
								className={`cs-badge ${build.errors.length ? "cs-badge-gold" : "cs-badge-green"}`}
								style={{ padding: "4px 10px", fontSize: 12 }}
							>
								{build.errors.length ? `发现 ${build.errors.length} 处错误` : "语法检查全部通过"}
							</span>
						)}
					</div>
					{build?.errors && build.errors.length > 0 && (
						<div style={{ marginTop: 14 }}>
							{build.errors.map((e, idx) => (
								<pre key={idx} style={{ color: "var(--accent-strong)", fontSize: 12, margin: "4px 0" }}>
									{e.resource}：{e.message}
								</pre>
							))}
						</div>
					)}
				</div>

				<div className="cs-card">
					<div className="cs-card-title">
						<span className="cs-arrow-gold">&gt;</span> 待应用变更 ({changedList.length})
					</div>
					{changedList.length === 0 ? (
						<div style={{ fontSize: 12, color: "var(--text-faint)" }}>
							当前无待应用的草稿改动。
						</div>
					) : (
						<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
							{changedList.map((r) => (
								<div
									key={r.id}
									style={{
										display: "flex",
										justifyContent: "space-between",
										padding: "8px 12px",
										background: "var(--surface-dim)",
										border: "1px solid var(--hairline)",
										borderRadius: "var(--radius-s)",
										fontSize: 12.5,
									}}
								>
									<span style={{ fontWeight: 500 }}>{r.name}</span>
									<span className="cs-badge cs-badge-gold">{r.length} 字节</span>
								</div>
							))}
						</div>
					)}
				</div>

				<div className="cs-card">
					<div className="cs-card-title">
						<span className="cs-arrow-gold">&gt;</span> 外部依赖与引用 ({depItems.length})
					</div>
					{depItems.length === 0 ? (
						<div style={{ fontSize: 12, color: "var(--text-faint)" }}>
							本角色卡未引用任何外部 CDN、脚本或字体库，完全本地离线运行。
						</div>
					) : (
						<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
							{depItems.map((d) => (
								<span key={d.key} className="cs-badge cs-badge-gray" style={{ padding: "4px 8px" }}>
									{d.label}
								</span>
							))}
						</div>
					)}
				</div>

				<div className="cs-card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
					<div className="cs-card-title">
						<span className="cs-arrow-gold">&gt;</span> 写入与导出
					</div>
					<div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
						<button
							type="button"
							className="cs-btn-primary"
							disabled={busy || changedList.length === 0}
							onClick={handleApply}
						>
							应用到当前角色卡 ({changedList.length} 项变更)
						</button>
						{status?.canUndo && (
							<button type="button" className="cs-btn-ghost" disabled={busy} onClick={handleUndo}>
								撤回上次应用
							</button>
						)}
						<a
							href={`/api/card/export?format=png&lore=active`}
							download
							className="cs-btn-ghost"
							style={{ textDecoration: "none" }}
						>
							导出带封面 PNG
						</a>
						<a
							href={`/api/card/export?format=json&lore=active`}
							download
							className="cs-btn-ghost"
							style={{ textDecoration: "none" }}
						>
							导出 JSON 格式
						</a>
					</div>
				</div>
			</div>
		);
	};

	return (
		<div className="cs-root" role="dialog" aria-label="角色卡工坊">
			{/* 顶栏 */}
			<header className="cs-header">
				<div className="cs-header-left">
					<button type="button" className="cs-back-btn" onClick={onClose}>
						<IconChevronLeft size={14} />
						返回作品
					</button>
					<div className="cs-brand-box">
						<BrandLogo size={20} />
						<span className="cs-brand-title">梨园工坊</span>
						<span className="cs-brand-sub">ROLEPLAY STUDIO</span>
					</div>
					<span className="cs-header-divider">·</span>
					<div className="cs-header-card-badge">
						<span className="cs-header-card-name">{cardInfo?.name || "未命名卡片"}</span>
						<span className={changedCount > 0 ? "cs-dot-unsaved" : "cs-dot-saved"} />
						<span style={{ fontSize: 11 }}>{changedCount > 0 ? `${changedCount} 项未应用` : "已保存"}</span>
					</div>
				</div>

				<div className="cs-header-right">
					<button type="button" className="cs-btn-ghost" onClick={refreshAll} disabled={busy}>
						刷新
					</button>
					<button type="button" className="cs-btn-ghost" onClick={handleCheck} disabled={busy}>
						检查
					</button>
					<button type="button" className="cs-btn-ghost" onClick={handlePreview} disabled={busy}>
						预览
					</button>
					<button
						type="button"
						className="cs-btn-primary"
						onClick={handleApply}
						disabled={busy || changedCount === 0}
					>
						应用到角色卡
					</button>
				</div>
			</header>

			{/* 全局通告栏 */}
			{(error || notice) && (
				<div
					style={{
						padding: "8px 16px",
						fontSize: 12,
						background: error ? "var(--accent-wash-strong)" : "var(--accent-wash)",
						color: error ? "var(--accent-strong)" : "var(--accent)",
						borderBottom: "1px solid var(--hairline)",
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
					}}
				>
					<span>{error || notice}</span>
					<button
						type="button"
						style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}
						onClick={() => {
							setError("");
							setNotice("");
						}}
					>
						<IconClose size={12} />
					</button>
				</div>
			)}

			{/* 主容器：左目录 + 中工作区（宽度彻底舒展） */}
			<div className="cs-container">
				{/* 左栏：创作目录 */}
				<aside className="cs-sidebar-left">
					<div className="cs-nav-header">
						<div className="cs-nav-title">
							<span className="cs-arrow-gold">&gt;</span> 创作目录
						</div>
						<div className="cs-nav-sub">只进入这次需要的部分</div>
					</div>

					<div className="cs-nav-list">
						{SECTIONS.map((sec) => {
							const isAct = sec.code === activeSec;
							let badgeLabel = "未开始";
							let badgeClass = "cs-badge-gray";

							if (sec.code === "00") {
								badgeLabel = "已设置";
								badgeClass = "cs-badge-green";
							} else if (sec.code === "01") {
								badgeLabel = rawCard?.personality ? "已设置" : "未开始";
								badgeClass = rawCard?.personality ? "cs-badge-green" : "cs-badge-gray";
							} else if (sec.code === "02") {
								const cnt = rawCard?.character_book?.entries?.length || 0;
								badgeLabel = cnt > 0 ? `${cnt} 条` : "未启用";
								badgeClass = cnt > 0 ? "cs-badge-green" : "cs-badge-gray";
							} else if (sec.code === "03") {
								badgeLabel = rawCard?.system_prompt ? "已设置" : "未开始";
								badgeClass = rawCard?.system_prompt ? "cs-badge-green" : "cs-badge-gray";
							} else if (sec.code === "04") {
								const cnt = 1 + (rawCard?.alternate_greetings?.length || 0);
								badgeLabel = `${cnt} 项`;
								badgeClass = "cs-badge-green";
							} else if (sec.code === "05") {
								const hasMvu = Boolean(rawCard?.extensions?.tavern_helper?.variables);
								badgeLabel = hasMvu ? "已启用" : "未启用";
								badgeClass = hasMvu ? "cs-badge-green" : "cs-badge-gray";
							} else if (sec.code === "06") {
								const hasUi = (outline?.sections.find((s) => s.id === "ui")?.items.length || 0) > 0;
								badgeLabel = hasUi ? "已启用" : "未启用";
								badgeClass = hasUi ? "cs-badge-green" : "cs-badge-gray";
							} else if (sec.code === "07") {
								const cnt = rawCard?.extensions?.regex_scripts?.length || 0;
								badgeLabel = cnt > 0 ? `${cnt} 条` : "未启用";
								badgeClass = cnt > 0 ? "cs-badge-green" : "cs-badge-gray";
							} else if (sec.code === "08") {
								const hasEjs = (outline?.sections.find((s) => s.id === "ejs")?.items.length || 0) > 0;
								badgeLabel = hasEjs ? "已启用" : "未启用";
								badgeClass = hasEjs ? "cs-badge-green" : "cs-badge-gray";
							} else if (sec.code === "09") {
								badgeLabel = changedCount > 0 ? `${changedCount} 项改动` : "未开始";
								badgeClass = changedCount > 0 ? "cs-badge-gold" : "cs-badge-gray";
							}

							return (
								<button
									key={sec.code}
									type="button"
									className={`cs-nav-item ${isAct ? "is-active" : ""}`}
									onClick={() => setActiveSec(sec.code)}
								>
									<span className="cs-nav-item-name">
										{sec.num} {sec.title}
									</span>
									<span className={`cs-badge ${badgeClass}`}>{badgeLabel}</span>
								</button>
							);
						})}
					</div>

					<div className="cs-sidebar-footer">
						<div className="cs-footer-hint">完成内容后再检查</div>
						<button
							type="button"
							className="cs-btn-export-full"
							onClick={() => setActiveSec("09")}
						>
							检查并导出
						</button>
					</div>
				</aside>

				{/* 中间栏：主工作区 */}
				<main className="cs-main">
					<div className="cs-content-wrap">
						<div className="cs-sec-breadcrumb">
							<span className="cs-arrow-gold">&gt;</span> {curSectionMeta.title}
						</div>
						<div className="cs-sec-header">
							<span className="cs-big-num">{curSectionMeta.num}</span>
							<h1 className="cs-sec-title">{curSectionMeta.title}</h1>
						</div>
						<p className="cs-sec-desc">{curSectionMeta.desc}</p>
						<div className="cs-divider" />

						{activeSec === "00" && renderSection00()}
						{activeSec === "01" && renderSection01()}
						{activeSec === "02" && renderSection02()}
						{activeSec === "03" && renderSection03()}
						{activeSec === "04" && renderSection04()}
						{activeSec === "05" && renderSection05()}
						{activeSec === "06" && renderSection06()}
						{activeSec === "07" && renderSection07()}
						{activeSec === "08" && renderSection08()}
						{activeSec === "09" && renderSection09()}
					</div>
				</main>
			</div>

			{/* 测试预览弹层 */}
			{preview && (
				<div
					style={{
						position: "fixed",
						bottom: 24,
						right: 24,
						width: 520,
						height: 580,
						background: "var(--surface)",
						border: "1px solid var(--hairline-strong)",
						borderRadius: "var(--radius-s)",
						display: "flex",
						flexDirection: "column",
						boxShadow: "var(--shadow-3)",
						zIndex: 600,
						overflow: "hidden",
					}}
				>
					<div
						style={{
							padding: "10px 14px",
							background: "var(--surface-dim)",
							borderBottom: "1px solid var(--hairline)",
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center",
							fontSize: 13,
							fontWeight: 600,
							color: "var(--text-strong)",
						}}
					>
						<span>组件与状态栏实时运行预览</span>
						<button
							type="button"
							className="cs-btn-ghost"
							style={{ padding: "3px 8px" }}
							onClick={() => setPreview(null)}
						>
							关闭
						</button>
					</div>
					<iframe
						key={preview.token}
						ref={frame}
						title="角色卡预览"
						sandbox={CARD_PREVIEW_SANDBOX}
						src={preview.url}
						style={{ flex: 1, width: "100%", border: "none", background: "#fff" }}
					/>
				</div>
			)}
		</div>
	);
}
