import { useEffect, useRef, useState } from "react";
import type {
	CardOutline,
	CardOutlineItem,
	CardProjectBuild,
	CardProjectPreview,
	CardProjectStatus,
	CardResource,
	CardSectionId,
} from "../../../src/card-authoring-types.ts";
import { apiGet, apiGetCacheClear, apiPost, type CardResponse } from "../api.ts";
import { buildCardAuthoringPreview, CARD_PREVIEW_SANDBOX, cardPreviewUrl } from "../cardAuthoringPreview.ts";
import { IconClose, IconEdit, IconList } from "./icons.tsx";
import { PreviewEventList, type PreviewEvent } from "./PreviewRunner.tsx";
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
	{ code: "01", id: "settings", num: "01", title: "世界与角色设定", desc: "这张卡是一个角色还是一个世界，都从这里写：世界观与规则系统、核心角色的性格处境与对话示范。" },
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

type LoreEntry = NonNullable<NonNullable<RawCardData["character_book"]>["entries"]>[number];

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
	const [mobileNavOpen, setMobileNavOpen] = useState(false);

	// 本地封面文件预览 URL
	const [customCoverUrl, setCustomCoverUrl] = useState<string | null>(null);
	/** 卡图 URL 加载失败（JSON 卡还没侧挂封面）→ 显示占位而不是碎图 */
	const [coverBroken, setCoverBroken] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// 测试预览弹层与预览壳上报的事件
	const [preview, setPreview] = useState<{ url: string; token: string } | null>(null);
	const [previewEvents, setPreviewEvents] = useState<PreviewEvent[]>([]);
	useEffect(() => {
		if (!preview) return;
		setPreviewEvents([]);
		const onMessage = (e: MessageEvent) => {
			const p = (e.data as { liyuanCardPreview?: PreviewEvent } | null)?.liyuanCardPreview;
			if (!p || p.token !== preview.token || typeof p.message !== "string") return;
			setPreviewEvents((old) => [...old.slice(-49), { ...p, message: p.message.slice(0, 4000) }]);
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [preview]);
	const frame = useRef<HTMLIFrameElement>(null);
	const active = useRef(true);

	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);

	const cardPath = cardInfo?.path ?? "";
	const coverUrl = customCoverUrl || (status?.changes.cover ? `/api/card/authoring/cover?v=${status.version}` : cardPath ? `/api/cards/image?path=${encodeURIComponent(cardPath)}` : null);
	useEffect(() => { setCoverBroken(false); }, [coverUrl]);

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
			const rawRes = await operation<{ text: string }>({ action: "read", resource: "draft" });
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
					resource: "draft",
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

	// 一次工程操作：忙态、错误、完成后整体刷新
	const runOp = async (fn: () => Promise<void>) => {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await fn();
			setBuild(null);
			await refreshAll();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const setMeta = (key: string, fields: Record<string, unknown>, note = "已更新") =>
		runOp(async () => { await operation({ action: "meta", key, fields }); setNotice(note); });
	const removeItem = (key: string, restore: boolean) =>
		runOp(async () => { await operation({ action: restore ? "restore" : "remove", key }); setNotice(restore ? "已撤销删除" : "已标记删除，随「应用」生效"); });
	const assignItem = (key: string, section: string) =>
		runOp(async () => { await operation({ action: "assign", key, section: section || undefined }); setNotice("板块归属已更新"); });
	const addItem = (kind: "lore" | "greeting" | "regex" | "script", fields: Record<string, unknown>, after?: (item: CardOutlineItem) => void) =>
		runOp(async () => {
			const result = await operation<{ item: CardOutlineItem }>({ action: "add", kind, fields });
			setNotice(`已新增：${result.item.label || "未命名"}`);
			after?.(result.item);
		});
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
				setNotice(`检查通过！正文 ${result.changed.length} 项，新增 ${result.added.length}，删除 ${result.removed.length}，元数据 ${result.meta.length}${result.cover ? "，封面" : ""}`);
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
			// 应用后资源 ID 可能随下标重排：本地草稿缓冲整体作废，按需重新读取
			setDrafts({});
			setBuild(null);
			setCustomCoverUrl(null);
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
			setDrafts({});
			setBuild(null);
			setNotice("已撤回上次应用，应用前的稿件已恢复为待修改稿。");
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
						封面立绘
					</div>
					<div className="cs-cover-placeholder">
						{coverUrl && !coverBroken ? (
							<img src={coverUrl} alt="封面" className="cs-cover-img" onError={() => setCoverBroken(true)} />
						) : (
							<>
								<span style={{ fontSize: 24 }}>🖼️</span>
								<span>尚未设置封面</span>
							</>
						)}
					</div>
					<div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>角色卡图片</div>
					<div className="cs-cover-desc">
						{status?.changes.cover ? "已选新封面，随「应用」写入角色卡；只换图像，卡数据不动。" : "选择 PNG 图像后进入创作稿，随「应用」写入（PNG 卡换内嵌图，JSON 卡落侧挂文件）。"}
					</div>
					<input
						ref={fileInputRef}
						type="file"
						accept="image/png"
						style={{ display: "none" }}
						onChange={(e) => {
							const file = e.target.files?.[0];
							e.target.value = "";
							if (!file) return;
							const reader = new FileReader();
							reader.onload = () => {
								if (typeof reader.result !== "string") return;
								const base64 = reader.result.split(",")[1] ?? "";
								void runOp(async () => {
									await operation({ action: "cover", data: base64 });
									setCustomCoverUrl(reader.result as string);
									setNotice("新封面已进入创作稿");
								});
							};
							reader.readAsDataURL(file);
						}}
					/>
					<div style={{ display: "flex", gap: 8 }}>
						<button
							type="button"
							className="cs-btn-ghost"
							style={{ flex: 1, justifyContent: "center" }}
							disabled={busy}
							onClick={() => fileInputRef.current?.click()}
						>
							更换封面图片
						</button>
						{status?.changes.cover && (
							<button
								type="button"
								className="cs-btn-ghost"
								disabled={busy}
								onClick={() => void runOp(async () => { await operation({ action: "cover", data: null }); setCustomCoverUrl(null); setNotice("已放弃新封面"); })}
							>
								撤销
							</button>
						)}
					</div>
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

					</div>
				</div>
			);
		};

		// 01 世界与角色设定 (Personality / Scenario / Mes Example / Creator Notes)
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
						<label className="cs-label">核心设定 (Personality)</label>
						<textarea
							className="cs-textarea"
							rows={5}
							value={curPers}
							onChange={(e) => {
								if (persRes) setDrafts((d) => ({ ...d, [persRes.id]: e.target.value }));
							}}
							placeholder="角色的性情作风，或这张卡的核心设定：世界观、规则系统、力量体系..."
						/>
					</div>
					<div className="cs-field">
						<label className="cs-label">世界与处境 (Scenario)</label>
						<textarea
							className="cs-textarea"
							rows={4}
							value={curScen}
							onChange={(e) => {
								if (scenRes) setDrafts((d) => ({ ...d, [scenRes.id]: e.target.value }));
							}}
							placeholder="故事发生的舞台：世界格局、初始处境、互动条件..."
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
								setNotice("设定已保存！");
							}}
						>
							保存设定
						</button>
					</div>
				</div>
			</div>
		);
	};

	// 02 世界书与设定集（带搜索检索、分类过滤、条目属性编辑与正文编辑）
	const renderSection02 = () => {
		// 条目按草稿视图列出；每条对应一个目录项（元数据、删除、归属都按它寻址）与一个正文资源
		const rawEntries = rawCard?.character_book?.entries as LoreEntry[] | Record<string, LoreEntry> | undefined;
		const entryPairs: Array<[string, LoreEntry]> = Array.isArray(rawEntries)
			? rawEntries.map((e, i): [string, LoreEntry] => [String(i), e])
			: rawEntries && typeof rawEntries === "object" ? Object.entries(rawEntries) : [];
		const loreItems = new Map<string, CardOutlineItem>();
		for (const item of outline?.sections.flatMap((s) => s.items) || []) {
			const p = item.path;
			if (p && p.length >= 3 && p[p.length - 3] === "character_book" && p[p.length - 2] === "entries") loreItems.set(p[p.length - 1], item);
		}
		const rows = entryPairs.map(([key, e], idx) => {
			const item = loreItems.get(key);
			const res = item?.resources[0] ? status?.resources.find((r) => r.id === item.resources[0]) : undefined;
			return { key, e, idx, item, res };
		});

		const filtered = rows.filter(({ e, item }) => {
			if (loreFilter === "constant" && !e.constant) return false;
			if (loreFilter === "keyed" && (!e.keys || e.keys.length === 0)) return false;
			if (loreFilter === "disabled" && e.enabled !== false && !item?.removed) return false;
			if (!loreSearch.trim()) return true;
			const q = loreSearch.toLowerCase();
			return (
				(e.comment || "").toLowerCase().includes(q) ||
				(e.content || "").toLowerCase().includes(q) ||
				(e.keys || []).some((k) => k.toLowerCase().includes(q))
			);
		});

		const activeIdx = filtered.some((r) => r.idx === selectedLoreIdx) ? selectedLoreIdx : (filtered[0]?.idx ?? -1);
		const current = rows[activeIdx];
		const curContent = current?.res ? getFieldValue(current.res.id, current.e.content || "") : "";
		const positionOptions = ["before_char", "after_char", "an_top", "an_bottom", "at_depth", "em_top", "em_bottom"];
		const curPosition = typeof current?.e.extensions?.position === "number" ? positionOptions[current.e.extensions.position] ?? "after_char" : current?.e.position || "after_char";
		const sectionOptions: Array<[string, string]> = [["", "默认（按结构判据）"], ["settings", "作品设置"], ["lore-knowledge", "世界书·知识"], ["lore-constant", "世界书·常驻块"], ["rules", "创作规则"], ["mvu", "MVU 变量"], ["ejs", "EJS"], ["other", "其他"]];

		return (
			<div className="cs-split-pane">
				<div className="cs-split-list">
					<div className="cs-split-list-header">
						<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
							<span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-strong)" }}>
								设定条目 ({rows.length})
							</span>
							<button
								type="button"
								className="cs-btn-ghost"
								style={{ padding: "3px 10px" }}
								disabled={busy}
								onClick={() => void addItem("lore", { comment: "新条目" }, () => { setLoreFilter("all"); setLoreSearch(""); setSelectedLoreIdx(rows.length); })}
							>
								＋ 新增条目
							</button>
						</div>
						<input
							type="text"
							className="cs-search-input"
							placeholder="搜索条目名 / 关键词 / 正文..."
							value={loreSearch}
							onChange={(e) => setLoreSearch(e.target.value)}
						/>
						<div className="cs-filter-row">
							{([["all", `全部 (${rows.length})`], ["constant", "常驻"], ["keyed", "关键词"], ["disabled", "停用/待删"]] as const).map(([id, label]) => (
								<button key={id} type="button" className={`cs-pill-btn ${loreFilter === id ? "is-active" : ""}`} onClick={() => setLoreFilter(id)}>
									{label}
								</button>
							))}
						</div>
					</div>

					<div className="cs-split-list-items">
						{filtered.map(({ e, idx, item, res }) => (
							<div
								key={idx}
								className={`cs-split-item ${idx === activeIdx ? "is-active" : ""}`}
								style={item?.removed ? { opacity: 0.5, textDecoration: "line-through" } : undefined}
								onClick={() => {
									setSelectedLoreIdx(idx);
									if (res) ensureDraft(res);
								}}
							>
								<div className="cs-split-item-row">
									<span className="cs-split-item-title">{e.comment || `条目 #${idx + 1}`}</span>
									{item?.addition && <span className="cs-badge cs-badge-green">新增</span>}
									{item?.removed && <span className="cs-badge cs-badge-gray">待删</span>}
									{res?.changed && !item?.addition && <span className="cs-badge cs-badge-gold">已改</span>}
								</div>
								<div className="cs-split-item-meta">
									<span>{(e.content || "").length} 字</span>
									{e.constant && <span className="cs-badge cs-badge-green">常驻</span>}
									{e.keys && e.keys.length > 0 && <span>{e.keys.length} 词</span>}
									{e.enabled === false && <span style={{ color: "var(--text-faint)" }}>停用</span>}
									{item?.declared && <span style={{ color: "var(--text-faint)" }}>已归位</span>}
								</div>
							</div>
						))}
					</div>
				</div>

				<div className="cs-split-detail">
					{current && current.item ? (
						<>
							<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
								<div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-strong)" }}>
									{current.e.comment || `条目 #${activeIdx + 1}`}
								</div>
								<div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
									<button
										type="button"
										className={`cs-toggle-btn ${current.e.constant ? "is-on" : ""}`}
										disabled={busy}
										onClick={() => void setMeta(current.item!.key, { constant: !current.e.constant }, current.e.constant ? "已切换为关键词触发" : "已切换为常驻注入（蓝灯）")}
									>
										{current.e.constant ? "常驻注入 (开)" : "关键词触发"}
									</button>
									<button
										type="button"
										className={`cs-toggle-btn ${current.e.enabled !== false ? "is-on" : ""}`}
										disabled={busy}
										onClick={() => void setMeta(current.item!.key, { enabled: current.e.enabled === false }, current.e.enabled === false ? "条目已启用" : "条目已停用")}
									>
										{current.e.enabled !== false ? "已启用" : "已停用"}
									</button>
									<button
										type="button"
										className="cs-btn-ghost"
										disabled={busy}
										onClick={() => void removeItem(current.item!.key, Boolean(current.item!.removed))}
									>
										{current.item.removed ? "撤销删除" : "删除条目"}
									</button>
								</div>
							</div>

							<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
								<div className="cs-field">
									<label className="cs-label">条目备注 / 名称</label>
									<input
										type="text"
										className="cs-input"
										defaultValue={current.e.comment || ""}
										key={`comment-${current.key}-${current.e.comment}`}
										onBlur={(e) => { if (e.target.value !== (current.e.comment || "")) void setMeta(current.item!.key, { comment: e.target.value }, "条目名称已更新"); }}
										placeholder="例如：世界观、境界划分、角色关系"
									/>
								</div>
								<div className="cs-field">
									<label className="cs-label">触发关键词 (逗号分隔)</label>
									<input
										type="text"
										className="cs-input"
										defaultValue={(current.e.keys || []).join(", ")}
										key={`keys-${current.key}-${(current.e.keys || []).join(",")}`}
										onBlur={(e) => {
											const keys = e.target.value.split(/[,，]/).map((k) => k.trim()).filter(Boolean);
											if (keys.join("") !== (current.e.keys || []).join("")) void setMeta(current.item!.key, { keys }, "关键词已更新");
										}}
										placeholder="常驻条目无需填写"
									/>
								</div>
							</div>
							<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
								<div className="cs-field">
									<label className="cs-label">插入位置</label>
									<select
										className="cs-input"
										value={curPosition}
										disabled={busy}
										onChange={(e) => void setMeta(current.item!.key, { position: e.target.value }, "插入位置已更新")}
									>
										{positionOptions.map((p) => <option key={p} value={p}>{p}</option>)}
									</select>
								</div>
								<div className="cs-field">
									<label className="cs-label">深度 / 顺序</label>
									<div style={{ display: "flex", gap: 6 }}>
										<input
											type="number"
											className="cs-input"
											key={`depth-${current.key}-${current.e.extensions?.depth}`}
											defaultValue={current.e.extensions?.depth ?? 4}
											disabled={curPosition !== "at_depth"}
											onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== (current.e.extensions?.depth ?? 4)) void setMeta(current.item!.key, { depth: v }, "深度已更新"); }}
										/>
										<input
											type="number"
											className="cs-input"
											key={`order-${current.key}-${current.e.insertion_order}`}
											defaultValue={current.e.insertion_order ?? 100}
											onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== (current.e.insertion_order ?? 100)) void setMeta(current.item!.key, { insertion_order: v }, "顺序已更新"); }}
										/>
									</div>
								</div>
								<div className="cs-field">
									<label className="cs-label">板块归属{current.item.declared ? "（已声明）" : ""}</label>
									<select
										className="cs-input"
										value={current.item.declared ? current.item.section : ""}
										disabled={busy}
										onChange={(e) => void assignItem(current.item!.key, e.target.value)}
									>
										{sectionOptions.map(([id, label]) => <option key={id} value={id}>{label}{id === "" ? `：${current.item!.defaultSection}` : ""}</option>)}
									</select>
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
										if (current.res) setDrafts((d) => ({ ...d, [current.res!.id]: e.target.value }));
									}}
									placeholder="在此编写详细设定正文..."
								/>
							</div>

							<div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
								<button
									type="button"
									className="cs-btn-primary"
									disabled={busy || !current.res || drafts[current.res.id] === undefined}
									onClick={async () => {
										if (current.res && drafts[current.res.id] !== undefined) await saveResource(current.res, drafts[current.res.id]);
									}}
								>
									保存正文
								</button>
							</div>
						</>
					) : (
						<div style={{ color: "var(--text-faint)", padding: 40, textAlign: "center" }}>
							{rows.length ? "没有匹配的条目，请调整筛选条件。" : "这张卡还没有世界书条目，点「新增条目」开始。"}
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
		// 默认开场 ＋ 备选 ＋ 群聊开场：全部来自资源清单，顺序与卡内一致；备选/群聊可增删
		const greetingResources = status?.resources.filter((r) => r.kind === "greeting") || [];
		const greetingItems = new Map<string, CardOutlineItem>();
		for (const item of outline?.sections.find((s) => s.id === "greetings")?.items || []) if (item.resources[0]) greetingItems.set(item.resources[0], item);
		const idx = Math.min(selectedGreetingIdx, Math.max(0, greetingResources.length - 1));
		const curGreetingRes = greetingResources[idx];
		const curItem = curGreetingRes ? greetingItems.get(curGreetingRes.id) : undefined;
		const fallback = (r: CardResource | undefined) => {
			if (!r) return "";
			const last = r.path[r.path.length - 1];
			if (last === "first_mes") return rawCard?.first_mes || "";
			const list = r.path[r.path.length - 2] === "group_only_greetings" ? (rawCard as { group_only_greetings?: string[] }).group_only_greetings : rawCard?.alternate_greetings;
			return list?.[Number(last)] || "";
		};
		const curGreetingText = curGreetingRes ? getFieldValue(curGreetingRes.id, fallback(curGreetingRes)) : "";

		return (
			<div className="cs-card">
				<div className="cs-tabs" style={{ flexWrap: "wrap", alignItems: "center" }}>
					{greetingResources.map((r, i) => {
						const item = greetingItems.get(r.id);
						return (
							<button
								key={r.id}
								type="button"
								className={`cs-tab ${idx === i ? "is-active" : ""}`}
								style={item?.removed ? { textDecoration: "line-through", opacity: 0.6 } : undefined}
								onClick={() => {
									setSelectedGreetingIdx(i);
									ensureDraft(r);
								}}
							>
								{r.name}{item?.addition ? " ·新" : ""}{r.changed && !item?.addition ? " ·改" : ""}
							</button>
						);
					})}
					<button type="button" className="cs-btn-ghost" style={{ padding: "3px 10px" }} disabled={busy}
						onClick={() => void addItem("greeting", {}, () => setSelectedGreetingIdx(greetingResources.length))}>
						＋ 备选开场
					</button>
					<button type="button" className="cs-btn-ghost" style={{ padding: "3px 10px" }} disabled={busy}
						onClick={() => void addItem("greeting", { group: true }, () => setSelectedGreetingIdx(greetingResources.length))}>
						＋ 群聊开场
					</button>
				</div>

				<div className="cs-field">
					<div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6, gap: 8 }}>
						<label className="cs-label">{curGreetingRes?.name ?? "开场白"} 正文</label>
						<span style={{ fontSize: 11, color: "var(--text-faint)" }}>{curGreetingText.length} 字</span>
					</div>
					<textarea
						className="cs-textarea cs-textarea-code"
						rows={14}
						value={curGreetingText}
						disabled={!curGreetingRes || Boolean(curItem?.removed)}
						onChange={(e) => {
							if (curGreetingRes) setDrafts((d) => ({ ...d, [curGreetingRes.id]: e.target.value }));
						}}
						placeholder="输入故事开篇第一条发言..."
					/>
				</div>

				<div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 14 }}>
					{curItem?.path && (
						<button type="button" className="cs-btn-ghost" disabled={busy} onClick={() => void removeItem(curItem.key, Boolean(curItem.removed))}>
							{curItem.removed ? "撤销删除" : "删除这条开场"}
						</button>
					)}
					<button
						type="button"
						className="cs-btn-primary"
						disabled={busy || !curGreetingRes || drafts[curGreetingRes.id] === undefined}
						onClick={async () => {
							if (curGreetingRes && drafts[curGreetingRes.id] !== undefined) {
								await saveResource(curGreetingRes, drafts[curGreetingRes.id]);
								setNotice("开场白已保存");
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
		// 界面 ＝ 显示正则里带 HTML 的模板；页面脚本 ＝ tavern_helper.scripts。两种都可增删、改元数据、编辑源码
		const uiItems = outline?.sections.find((s) => s.id === "ui")?.items || [];
		const scriptItems = outline?.sections.find((s) => s.id === "scripts")?.items || [];
		const list: Array<{ item: CardOutlineItem; kind: "ui" | "script" }> = [
			...uiItems.map((item) => ({ item, kind: "ui" as const })),
			...scriptItems.map((item) => ({ item, kind: "script" as const })),
		];
		const cur = list[selectedUiIdx];
		const codeResId = cur?.kind === "ui" ? cur.item.resources[1] || cur.item.resources[0] : cur?.item.resources[0];
		const codeRes = status?.resources.find((r) => r.id === codeResId);
		const curCode = codeRes ? getFieldValue(codeRes.id, "") : "";
		const patternRes = cur?.kind === "ui" && cur.item.resources.length > 1 ? status?.resources.find((r) => r.id === cur.item.resources[0]) : undefined;
		const curPattern = patternRes ? getFieldValue(patternRes.id, "") : "";

		return (
			<div className="cs-split-pane">
				<div className="cs-split-list">
					<div className="cs-split-list-header">
						<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
							<span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-strong)" }}>
								界面组件 ({uiItems.length}) · 页面脚本 ({scriptItems.length})
							</span>
							<div style={{ display: "flex", gap: 6 }}>
								<button type="button" className="cs-btn-ghost" style={{ padding: "3px 8px" }} disabled={busy}
									onClick={() => void addItem("regex", { scriptName: "新界面", placement: [2], markdownOnly: true }, () => setSelectedUiIdx(uiItems.length))}>
									＋ 界面
								</button>
								<button type="button" className="cs-btn-ghost" style={{ padding: "3px 8px" }} disabled={busy}
									onClick={() => void addItem("script", { name: "新脚本" }, () => setSelectedUiIdx(list.length))}>
									＋ 脚本
								</button>
							</div>
						</div>
					</div>
					<div className="cs-split-list-items">
						{list.map(({ item, kind }, idx) => (
							<div
								key={item.key}
								className={`cs-split-item ${idx === selectedUiIdx ? "is-active" : ""}`}
								style={item.removed ? { opacity: 0.5, textDecoration: "line-through" } : undefined}
								onClick={() => {
									setSelectedUiIdx(idx);
									const id = kind === "ui" ? item.resources[1] || item.resources[0] : item.resources[0];
									const res = status?.resources.find((r) => r.id === id);
									if (res) ensureDraft(res);
									const pat = kind === "ui" && item.resources.length > 1 ? status?.resources.find((r) => r.id === item.resources[0]) : undefined;
									if (pat) ensureDraft(pat);
								}}
							>
								<div className="cs-split-item-row">
									<span className="cs-split-item-title">{item.label || (kind === "ui" ? "未命名界面" : "未命名脚本")}</span>
									{item.addition && <span className="cs-badge cs-badge-green">新增</span>}
									{item.removed && <span className="cs-badge cs-badge-gray">待删</span>}
								</div>
								<div className="cs-split-item-meta">
									<span>{kind === "ui" ? "界面" : "脚本"}</span>
									<span>{item.size} 字节</span>
									{item.facts.placeholder && <span className="cs-badge cs-badge-gold">状态栏挂载点</span>}
									{item.facts.importOnly && <span>仅远程 import</span>}
									{!item.enabled && <span style={{ color: "var(--text-faint)" }}>停用</span>}
								</div>
							</div>
						))}
						{list.length === 0 && (
							<div style={{ color: "var(--text-faint)", padding: 16, fontSize: 12 }}>
								这张卡没有界面组件或页面脚本。
							</div>
						)}
					</div>
				</div>

				<div className="cs-split-detail">
					{cur && codeRes ? (
						<>
							<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
								<div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)" }}>
									{cur.item.label || "未命名"}
								</div>
								<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
									<button
										type="button"
										className={`cs-toggle-btn ${cur.item.enabled ? "is-on" : ""}`}
										disabled={busy}
										onClick={() => void setMeta(cur.item.key, cur.kind === "ui" ? { disabled: cur.item.enabled } : { enabled: !cur.item.enabled }, cur.item.enabled ? "已停用" : "已启用")}
									>
										{cur.item.enabled ? "已启用" : "已停用"}
									</button>
									<button type="button" className="cs-btn-ghost" disabled={busy} onClick={() => void removeItem(cur.item.key, Boolean(cur.item.removed))}>
										{cur.item.removed ? "撤销删除" : "删除"}
									</button>
									<button type="button" className="cs-btn-ghost" onClick={handlePreview} disabled={busy}>
										实时运行预览
									</button>
								</div>
							</div>

							<div style={{ display: "grid", gridTemplateColumns: cur.kind === "ui" ? "1fr 1fr" : "1fr", gap: 12 }}>
								<div className="cs-field">
									<label className="cs-label">名称</label>
									<input
										type="text"
										className="cs-input"
										key={`name-${cur.item.key}-${cur.item.label}`}
										defaultValue={cur.item.label}
										onBlur={(e) => { if (e.target.value !== cur.item.label) void setMeta(cur.item.key, cur.kind === "ui" ? { scriptName: e.target.value } : { name: e.target.value }, "名称已更新"); }}
									/>
								</div>
								{cur.kind === "ui" && patternRes && (
									<div className="cs-field">
										<label className="cs-label">挂载标签 / 匹配正则</label>
										<input
											type="text"
											className="cs-input"
											value={curPattern}
											onFocus={() => ensureDraft(patternRes)}
											onChange={(e) => setDrafts((d) => ({ ...d, [patternRes.id]: e.target.value }))}
											placeholder="<StatusBar/>"
										/>
									</div>
								)}
							</div>

							<div className="cs-field">
								<div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
									<label className="cs-label">{cur.kind === "ui" ? "HTML / CSS 渲染模板源码" : "页面脚本源码"}</label>
									<span style={{ fontSize: 11, color: "var(--text-faint)" }}>
										{curCode.length} 字节 · {curCode.split("\n").length} 行
									</span>
								</div>
								<textarea
									className="cs-textarea cs-textarea-code"
									style={{ flex: 1, minHeight: 360 }}
									value={curCode}
									onFocus={() => ensureDraft(codeRes)}
									onChange={(e) => setDrafts((d) => ({ ...d, [codeRes.id]: e.target.value }))}
									placeholder={cur.kind === "ui" ? "<div>状态栏 HTML 模板</div>" : "// 页面脚本"}
								/>
							</div>

							<div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
								<button
									type="button"
									className="cs-btn-primary"
									disabled={busy || (drafts[codeRes.id] === undefined && (!patternRes || drafts[patternRes.id] === undefined))}
									onClick={async () => {
										if (patternRes && drafts[patternRes.id] !== undefined) await saveResource(patternRes, drafts[patternRes.id]);
										if (drafts[codeRes.id] !== undefined) await saveResource(codeRes, drafts[codeRes.id]);
									}}
								>
									保存源码
								</button>
							</div>
						</>
					) : (
						<div style={{ color: "var(--text-faint)", padding: 40, textAlign: "center" }}>
							请从左侧选择界面组件或页面脚本。
						</div>
					)}
				</div>
			</div>
		);
	};

	// 07 消息前端与显示正则（可查看并修改 find 与 replace 模板）
	const renderSection07 = () => {
		// 文本正则 ＝ 送模侧/裁剪/纯文本替换（prompt-regex）＋ 梨园不消费的其他 placement（other）。界面正则在 06。
		const all = outline?.sections.flatMap((s) => s.items) || [];
		const regexItems = all.filter((i) => i.path && i.path[i.path.length - 2] === "regex_scripts" && i.section !== "ui");
		const curItem = regexItems[selectedRegexIdx];
		const patternRes = status?.resources.find((r) => curItem?.resources[0] === r.id);
		const templateRes = status?.resources.find((r) => curItem?.resources[1] === r.id);
		const curFind = patternRes ? getFieldValue(patternRes.id, "") : "";
		const curReplace = templateRes ? getFieldValue(templateRes.id, "") : "";
		const placement = String(curItem?.facts.placement ?? "");

		return (
			<div className="cs-split-pane">
				<div className="cs-split-list">
					<div className="cs-split-list-header">
						<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
							<span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-strong)" }}>
								文本正则 ({regexItems.length})
							</span>
							<button type="button" className="cs-btn-ghost" style={{ padding: "3px 10px" }} disabled={busy}
								onClick={() => void addItem("regex", { scriptName: "新正则", placement: [2], markdownOnly: false, promptOnly: true }, () => setSelectedRegexIdx(regexItems.length))}>
								＋ 新增正则
							</button>
						</div>
					</div>
					<div className="cs-split-list-items">
						{regexItems.map((item, idx) => (
							<div
								key={item.key}
								className={`cs-split-item ${idx === selectedRegexIdx ? "is-active" : ""}`}
								style={item.removed ? { opacity: 0.5, textDecoration: "line-through" } : undefined}
								onClick={() => {
									setSelectedRegexIdx(idx);
									for (const id of item.resources) {
										const res = status?.resources.find((r) => r.id === id);
										if (res) ensureDraft(res);
									}
								}}
							>
								<div className="cs-split-item-row">
									<span className="cs-split-item-title">{item.label || "未命名正则"}</span>
									{item.addition && <span className="cs-badge cs-badge-green">新增</span>}
									{item.removed && <span className="cs-badge cs-badge-gray">待删</span>}
								</div>
								<div className="cs-split-item-meta">
									<span>{item.enabled ? "生效" : "停用"}</span>
									<span>{item.facts.promptOnly ? "送模" : item.facts.markdownOnly ? "仅显示" : "两侧"}</span>
									{item.section === "other" && <span style={{ color: "var(--text-faint)" }}>placement {String(item.facts.placement)} · 梨园未消费</span>}
								</div>
							</div>
						))}
						{regexItems.length === 0 && (
							<div style={{ color: "var(--text-faint)", padding: 16, fontSize: 12 }}>这张卡没有文本正则。</div>
						)}
					</div>
				</div>

				<div className="cs-split-detail">
					{curItem ? (
						<>
							<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
								<div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)" }}>{curItem.label || "未命名正则"}</div>
								<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
									<button type="button" className={`cs-toggle-btn ${curItem.enabled ? "is-on" : ""}`} disabled={busy}
										onClick={() => void setMeta(curItem.key, { disabled: curItem.enabled }, curItem.enabled ? "已停用" : "已启用")}>
										{curItem.enabled ? "已启用" : "已停用"}
									</button>
									<button type="button" className={`cs-toggle-btn ${curItem.facts.promptOnly ? "is-on" : ""}`} disabled={busy}
										onClick={() => void setMeta(curItem.key, { promptOnly: !curItem.facts.promptOnly }, "送模侧开关已更新")}>
										送模侧
									</button>
									<button type="button" className={`cs-toggle-btn ${curItem.facts.markdownOnly ? "is-on" : ""}`} disabled={busy}
										onClick={() => void setMeta(curItem.key, { markdownOnly: !curItem.facts.markdownOnly }, "显示侧开关已更新")}>
										显示侧
									</button>
									<button type="button" className="cs-btn-ghost" disabled={busy} onClick={() => void removeItem(curItem.key, Boolean(curItem.removed))}>
										{curItem.removed ? "撤销删除" : "删除"}
									</button>
								</div>
							</div>
							<div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
								<div className="cs-field">
									<label className="cs-label">名称</label>
									<input type="text" className="cs-input" key={`rname-${curItem.key}-${curItem.label}`} defaultValue={curItem.label}
										onBlur={(e) => { if (e.target.value !== curItem.label) void setMeta(curItem.key, { scriptName: e.target.value }, "名称已更新"); }} />
								</div>
								<div className="cs-field">
									<label className="cs-label">placement（酒馆枚举，逗号分隔）</label>
									<input type="text" className="cs-input" key={`pl-${curItem.key}-${placement}`} defaultValue={placement}
										onBlur={(e) => {
											const next = e.target.value.split(/[,，\s]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n));
											if (next.join(",") !== placement) void setMeta(curItem.key, { placement: next }, "placement 已更新");
										}} />
								</div>
							</div>
							<div className="cs-field">
								<label className="cs-label">匹配表达式 (Find Regex)</label>
								<textarea className="cs-textarea cs-textarea-code" rows={3} value={curFind}
									onChange={(e) => { if (patternRes) setDrafts((d) => ({ ...d, [patternRes.id]: e.target.value })); }} />
							</div>
							<div className="cs-field" style={{ flex: 1 }}>
								<label className="cs-label">替换内容 / 模板 (Replace String)</label>
								<textarea className="cs-textarea cs-textarea-code" style={{ minHeight: 220 }} value={curReplace}
									onChange={(e) => { if (templateRes) setDrafts((d) => ({ ...d, [templateRes.id]: e.target.value })); }} />
							</div>
							<div style={{ display: "flex", justifyContent: "flex-end" }}>
								<button
									type="button"
									className="cs-btn-primary"
									disabled={busy || ((!patternRes || drafts[patternRes.id] === undefined) && (!templateRes || drafts[templateRes.id] === undefined))}
									onClick={async () => {
										if (patternRes && drafts[patternRes.id] !== undefined) await saveResource(patternRes, drafts[patternRes.id]);
										if (templateRes && drafts[templateRes.id] !== undefined) await saveResource(templateRes, drafts[templateRes.id]);
										setNotice("正则规则已保存");
									}}
								>
									保存此正则规则
								</button>
							</div>
						</>
					) : (
						<div style={{ color: "var(--text-faint)", padding: 40, textAlign: "center" }}>请选择要编辑的正则表达式。</div>
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
		const changedList = status?.resources.filter((r) => r.changed && !r.removed) || [];
		const ch = status?.changes;
		const structural = ch ? [ch.added ? `新增 ${ch.added}` : "", ch.removed ? `删除 ${ch.removed}` : "", ch.meta ? `元数据 ${ch.meta}` : "", ch.cover ? "封面" : ""].filter(Boolean) : [];
		const pendingTotal = changedList.length + (ch ? ch.added + ch.removed + ch.meta + (ch.cover ? 1 : 0) : 0);
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
						<span className="cs-arrow-gold">&gt;</span> 待应用变更 ({pendingTotal})
					</div>
					{status?.conflict && (
						<div className="cs-badge cs-badge-gold" style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", marginBottom: 8 }}>
							<span>原卡已被其他入口改动，创作稿基于旧版本。</span>
							<button type="button" className="cs-btn-ghost" disabled={busy} onClick={() => void runOp(async () => {
								const r = await operation<{ conflicts?: string[]; dropped: string[] }>({ action: "rebase" });
								setNotice(r.conflicts?.length ? `已重新同步，${r.conflicts.length} 项需人工核对` : "已重新同步到当前原卡");
							})}>重新同步</button>
						</div>
					)}
					{status?.conflicts?.length ? (
						<div style={{ fontSize: 12, color: "var(--accent-strong)", marginBottom: 8 }}>
							需人工核对（两边都改过）：{status.conflicts.map((id) => status.resources.find((r) => r.id === id)?.name ?? id).join("、")}
						</div>
					) : null}
					{structural.length > 0 && (
						<div style={{ fontSize: 12, color: "var(--text-soft)", marginBottom: 8 }}>结构改动：{structural.join(" · ")}</div>
					)}
					{ch?.stale ? <div style={{ fontSize: 12, color: "var(--accent-strong)", marginBottom: 8 }}>{ch.stale} 项结构改动与当前基线对不上，请重新同步或放弃。</div> : null}
					{changedList.length === 0 ? (
						<div style={{ fontSize: 12, color: "var(--text-faint)" }}>
							{pendingTotal ? "没有正文改动。" : "当前无待应用的草稿改动。"}
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
							disabled={busy || pendingTotal === 0 || Boolean(status?.conflict)}
							onClick={handleApply}
						>
							应用到当前角色卡 ({pendingTotal} 项变更)
						</button>
						{pendingTotal > 0 && (
							<button type="button" className="cs-btn-ghost" disabled={busy} onClick={() => void runOp(async () => { await operation({ action: "discard" }); setDrafts({}); setNotice("已放弃全部未应用改动"); })}>
								放弃全部改动
							</button>
						)}
						{status?.canUndo && pendingTotal === 0 && (
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
						<button
							type="button"
							className="cs-nav-toggle-btn"
							onClick={() => setMobileNavOpen((v) => !v)}
							aria-label={mobileNavOpen ? "收起创作大纲" : "展开创作大纲"}
							title="创作大纲"
						>
							<IconList size={13} />
							<span>大纲</span>
							<span className="cs-nav-toggle-sec">{curSectionMeta.num}</span>
						</button>
						<span className="cs-header-title">
							<IconEdit size={14} />
							<span>角色卡工坊</span>
						</span>
						<span className="cs-header-sep" aria-hidden="true">·</span>
						<span className="cs-header-card-name" title={cardInfo?.name}>{cardInfo?.name || "未命名卡片"}</span>
						<span className={changedCount > 0 ? "cs-dot-unsaved" : "cs-dot-saved"} title={changedCount > 0 ? `${changedCount} 项未应用` : "已保存"} />
						{changedCount > 0 && <span className="cs-header-badge-count">{changedCount} 项未应用</span>}
					</div>

					<div className="cs-header-right">
						<button type="button" className="cs-btn-micro" onClick={refreshAll} disabled={busy} title="刷新卡片数据">
							刷新
						</button>
						<button type="button" className="cs-btn-micro" onClick={handleCheck} disabled={busy} title="检查语法与规范">
							检查
						</button>
						<button type="button" className="cs-btn-micro" onClick={handlePreview} disabled={busy} title="沙箱预览">
							预览
						</button>
						<button
							type="button"
							className={`cs-btn-micro ${changedCount > 0 ? "cs-btn-micro-primary" : ""}`}
							onClick={handleApply}
							disabled={busy || changedCount === 0}
							title="应用到当前角色卡"
						>
							应用{changedCount > 0 ? ` (${changedCount})` : ""}
						</button>
						<button
							type="button"
							className="icon-btn cs-close-btn"
							onClick={onClose}
							title="收起工坊"
							aria-label="收起工坊"
						>
							<IconClose size={15} />
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
				{mobileNavOpen && (
					<div
						className="cs-sidebar-backdrop"
						onClick={() => setMobileNavOpen(false)}
						aria-hidden="true"
					/>
				)}
				{/* 左栏：创作目录 */}
				<aside className={`cs-sidebar-left ${mobileNavOpen ? "is-open-mobile" : ""}`}>
					<div className="cs-nav-header">
						<span className="cs-nav-title">创作大纲</span>
						<span className="cs-nav-count">10 板块</span>
						<button
							type="button"
							className="icon-btn cs-nav-close-btn"
							onClick={() => setMobileNavOpen(false)}
							aria-label="关闭大纲"
							title="关闭大纲"
						>
							<IconClose size={14} />
						</button>
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
									onClick={() => {
											setActiveSec(sec.code);
											setMobileNavOpen(false);
										}}
								>
									<span className="cs-nav-item-name">
										{sec.num} {sec.title}
									</span>
									<span className={`cs-badge ${badgeClass}`}>{badgeLabel}</span>
								</button>
							);
						})}
					</div>

					</aside>

				{/* 中间栏：主工作区 */}
				<main className={`cs-main ${["02", "06", "07"].includes(activeSec) ? "cs-main-split" : ""}`}>
					<div className="cs-content-wrap">
						<div className="cs-sec-header-compact">
							<div className="cs-sec-title-row">
								<span className="cs-sec-num-badge">{curSectionMeta.num}</span>
								<h1 className="cs-sec-title">{curSectionMeta.title}</h1>
								<span className="cs-sec-desc-inline">{curSectionMeta.desc}</span>
							</div>
						</div>

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
					<PreviewEventList events={previewEvents} />
				</div>
			)}
		</div>
	);
}
