/**
 * 悬浮窗：梨园自有面板的第三种形态（另两种是左栏 / 右栏）。
 *
 * 存在理由不是「更好看」，而是侧栏宽度被布局写死——`.side` 的宽度是
 * `max(300px, (100% - 聊天列宽) / 2 - 26px)`，1920 的屏上算出来 434px，一个又高又窄的条。
 * 世界线那张分叉图每多一层存档就宽 112px 且不缩放，名录四张表在窄栏里只能纵向排队。
 * 这类「要横向铺开」的面板需要一块自己的画布，于是有了这个壳。
 *
 * ## 它只管壳，不管内容
 * 标题栏 + 拖动 + 缩放 + 位置记忆，仅此而已。里面渲染什么由调用方给 children，
 * 与左右栏共用同一批面板组件——所以这里没有任何一个面板的名字。
 *
 * ## z-index 60 是算出来的，不是随手填的
 * 现有分层：顶栏 50 < **本窗 60** < tooltip 80 < 世界线节点菜单 90 < 居中弹窗 200 < 登录闸 1000。
 * 落在 60 才能同时满足两件事：盖住顶栏（否则窗口拖到上面会被顶栏切掉），
 * 又让窗口内面板自己弹出的菜单/弹窗照常盖在它上面（世界线的回档菜单就是 90）。
 * 作者卡的悬浮球用到 9999/2147483647，在本窗之上——那是作者的地盘，不去覆盖它。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { IconClose, IconRefresh } from "./icons.tsx";
import { readUiJson, writeUiJson } from "../uiStore.ts";

export interface FloatRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** 最小尺寸：再小就没有「铺开」的意义了，且标题栏会挤成一团 */
const MIN_W = 420;
const MIN_H = 280;
/** 窗口至少留这么多在视口内，保证标题栏永远抓得到（拖出屏幕外就再也拖不回来了） */
const KEEP_VISIBLE = 120;

const storeKey = (id: string) => `liyuan.float.${id}`;

function readRect(id: string): FloatRect | null {
	const v = readUiJson<Partial<FloatRect>>(storeKey(id));
	if (!v) return null;
	if (typeof v.x !== "number" || typeof v.y !== "number") return null;
	if (typeof v.w !== "number" || typeof v.h !== "number") return null;
	return { x: v.x, y: v.y, w: v.w, h: v.h };
}

const writeRect = (id: string, r: FloatRect): void => writeUiJson(storeKey(id), r);

/** 默认铺开一块够宽的画布；小屏按视口收 */
function defaultRect(): FloatRect {
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const w = Math.max(MIN_W, Math.min(1040, vw - 48));
	const h = Math.max(MIN_H, Math.min(660, vh - 120));
	return { x: Math.round((vw - w) / 2), y: Math.round((vh - h) / 2), w, h };
}

/** 把窗口按当前视口夹回可见范围（开窗时、以及浏览器窗口变小时） */
function clamp(r: FloatRect): FloatRect {
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const w = Math.max(MIN_W, Math.min(r.w, vw - 16));
	const h = Math.max(MIN_H, Math.min(r.h, vh - 16));
	return {
		w,
		h,
		x: Math.min(Math.max(r.x, KEEP_VISIBLE - w), vw - KEEP_VISIBLE),
		y: Math.min(Math.max(r.y, 0), vh - 44),
	};
}

/** 本窗的层级；与 app.css 的 `.floatwin { z-index }` 是同一个数，改一处要改两处 */
const Z_INDEX = 60;

/**
 * 当前是否有比本窗更高的层开着（面板自己弹的菜单、裁图、灯箱、登录闸……）。
 * 有的话 Esc 归它，不该越过它把整个窗口关掉。
 * 判据是**层级**不是名字——窗内渲染什么面板本组件并不知道，也不该知道。
 */
function hasHigherLayer(): boolean {
	for (const el of document.querySelectorAll("body *")) {
		const cs = getComputedStyle(el);
		if (cs.position !== "fixed" && cs.position !== "absolute") continue;
		if (cs.visibility === "hidden" || cs.display === "none") continue;
		const z = Number(cs.zIndex);
		if (Number.isFinite(z) && z > Z_INDEX) return true;
	}
	return false;
}

export function FloatWindow({
	id,
	title,
	icon,
	onRefresh,
	onClose,
	children,
}: {
	/** 位置记忆的键；同一个面板重开回到上次的位置 */
	id: string;
	title: string;
	icon?: React.ReactNode;
	onRefresh?: () => void;
	onClose: () => void;
	children: React.ReactNode;
}) {
	const [rect, setRect] = useState<FloatRect>(() => clamp(readRect(id) ?? defaultRect()));
	const rectRef = useRef(rect);
	rectRef.current = rect;
	/** 一次拖动/缩放的起点；null = 空闲 */
	const dragRef = useRef<{ mode: "move" | "size"; px: number; py: number; base: FloatRect } | null>(null);

	// 换面板 = 换记忆键，读它自己的位置
	useEffect(() => {
		setRect(clamp(readRect(id) ?? defaultRect()));
	}, [id]);

	// 浏览器窗口变小可能把本窗挤出视口，夹回来
	useEffect(() => {
		const onResize = () => setRect((r) => clamp(r));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			if (hasHigherLayer()) return;
			onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const startDrag = useCallback((mode: "move" | "size") => (e: React.PointerEvent) => {
		// 只接左键/触摸；标题栏上的按钮自己 stopPropagation，不会走到这里
		if (e.button !== 0) return;
		e.preventDefault();
		dragRef.current = { mode, px: e.clientX, py: e.clientY, base: rectRef.current };
		(e.currentTarget as Element).setPointerCapture(e.pointerId);
	}, []);

	const onMove = useCallback((e: React.PointerEvent) => {
		const d = dragRef.current;
		if (!d) return;
		const dx = e.clientX - d.px;
		const dy = e.clientY - d.py;
		setRect(
			clamp(
				d.mode === "move"
					? { ...d.base, x: d.base.x + dx, y: d.base.y + dy }
					: { ...d.base, w: d.base.w + dx, h: d.base.h + dy },
			),
		);
	}, []);

	const endDrag = useCallback(
		(e: React.PointerEvent) => {
			if (!dragRef.current) return;
			dragRef.current = null;
			try {
				(e.currentTarget as Element).releasePointerCapture(e.pointerId);
			} catch {
				/* 指针已释放 */
			}
			// 落笔时才写盘：拖动过程每帧都写会把 localStorage 打满
			writeRect(id, rectRef.current);
		},
		[id],
	);

	return (
		<div
			className="floatwin"
			role="dialog"
			aria-label={title}
			style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
		>
			<div
				className="floatwin-head"
				onPointerDown={startDrag("move")}
				onPointerMove={onMove}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
			>
				<span className="floatwin-title">
					{icon}
					{title}
				</span>
				<span className="floatwin-actions" onPointerDown={(e) => e.stopPropagation()}>
					{onRefresh && (
						<button className="icon-btn" onClick={onRefresh} title="刷新" aria-label="刷新面板">
							<IconRefresh size={15} />
						</button>
					)}
					<button className="icon-btn" onClick={onClose} title="关闭" aria-label="关闭悬浮窗">
						<IconClose size={16} />
					</button>
				</span>
			</div>
			<div className="floatwin-body">{children}</div>
			<div
				className="floatwin-grip"
				role="presentation"
				title="拖动缩放"
				onPointerDown={startDrag("size")}
				onPointerMove={onMove}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
			/>
		</div>
	);
}
