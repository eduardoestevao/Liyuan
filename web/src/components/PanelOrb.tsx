/**
 * 梨园自己的悬浮球：常驻屏幕的面板启动器。
 *
 * 与 v1.5.2 补上的**作者**悬浮球是两回事——那个是卡/预设自带脚本挂上来的（见
 * components/ScriptHost.tsx），这个是梨园自有 UI，不走脚本通道。两者会同屏，所以：
 * - **默认贴左边**：作者球几乎都按 `pwin.innerWidth - 76` 算初始位，即贴右边；躲开它。
 * - **z-index 55**，在悬浮窗(60)之下：球是启动器，窗开着时不该压在内容上；
 *   作者球用到 9999/2147483647，本球一律在它之下，不去抢作者的地盘。
 *
 * 球只管「点开→选一个面板」，面板本身由 FloatWindow 装——所以这里没有任何面板的渲染逻辑。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { IconClose, IconDock } from "./icons.tsx";
import { readUiJson, writeUiJson } from "../uiStore.ts";

export interface OrbEntry {
	/** 传回给调用方的面板 id */
	id: string;
	label: string;
	icon?: React.ReactNode;
	/** 当前是否正显示在悬浮窗里 */
	active?: boolean;
}

interface Pos {
	x: number;
	y: number;
}

const STORE_KEY = "liyuan.orb.pos";
const SIZE = 44;
/** 至少留在视口内的像素：拖出屏幕就再也点不到了 */
const KEEP = 8;

/** 默认贴左边、竖直居中偏下——作者球默认贴右边，这样两者不叠 */
function defaultPos(): Pos {
	return { x: 16, y: Math.max(80, Math.round(window.innerHeight * 0.62)) };
}

function clamp(p: Pos): Pos {
	return {
		x: Math.min(Math.max(p.x, KEEP), Math.max(KEEP, window.innerWidth - SIZE - KEEP)),
		y: Math.min(Math.max(p.y, KEEP), Math.max(KEEP, window.innerHeight - SIZE - KEEP)),
	};
}

export function PanelOrb({ entries, onPick }: { entries: OrbEntry[]; onPick: (id: string) => void }) {
	const [pos, setPos] = useState<Pos>(() => {
		const saved = readUiJson<Pos>(STORE_KEY);
		return clamp(saved && typeof saved.x === "number" && typeof saved.y === "number" ? saved : defaultPos());
	});
	const [open, setOpen] = useState(false);
	const posRef = useRef(pos);
	posRef.current = pos;
	/** 一次拖动的起点；null = 空闲。dragged 用来区分「点击」与「拖完松手」 */
	const dragRef = useRef<{ px: number; py: number; base: Pos; dragged: boolean } | null>(null);

	useEffect(() => {
		const onResize = () => setPos((p) => clamp(p));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	const onPointerDown = useCallback((e: React.PointerEvent) => {
		if (e.button !== 0) return;
		e.preventDefault();
		dragRef.current = { px: e.clientX, py: e.clientY, base: posRef.current, dragged: false };
		(e.currentTarget as Element).setPointerCapture(e.pointerId);
	}, []);

	const onPointerMove = useCallback((e: React.PointerEvent) => {
		const d = dragRef.current;
		if (!d) return;
		const dx = e.clientX - d.px;
		const dy = e.clientY - d.py;
		// 3px 死区：真正的点击也会带一两像素抖动，不设死区的话球点不开
		if (!d.dragged && Math.abs(dx) + Math.abs(dy) < 3) return;
		d.dragged = true;
		setPos(clamp({ x: d.base.x + dx, y: d.base.y + dy }));
	}, []);

	const onPointerUp = useCallback((e: React.PointerEvent) => {
		const d = dragRef.current;
		if (!d) return;
		dragRef.current = null;
		try {
			(e.currentTarget as Element).releasePointerCapture(e.pointerId);
		} catch {
			/* 指针已释放 */
		}
		if (d.dragged) writeUiJson(STORE_KEY, posRef.current);
		else setOpen((v) => !v); // 没拖动 = 点击
	}, []);

	if (entries.length === 0) return null;

	// 菜单朝屏幕内侧展开：球在左半屏就往右开，在右半屏就往左开
	const openRight = pos.x < window.innerWidth / 2;
	const anyActive = entries.some((e) => e.active);

	return (
		<>
			{open && (
				// 点空白关菜单。透明层不吃滚动（只在菜单开着时存在）
				<div className="orb-backdrop" onPointerDown={() => setOpen(false)} />
			)}
			<div className="orb-root" style={{ left: pos.x, top: pos.y }}>
				<button
					type="button"
					className={`orb-ball ${open ? "open" : ""} ${anyActive ? "has-active" : ""}`}
					title="梨园面板"
					aria-label="梨园面板"
					aria-expanded={open}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerUp}
				>
					{open ? <IconClose size={18} /> : <IconDock size={18} />}
				</button>
				{open && (
					<div className={`orb-menu ${openRight ? "to-right" : "to-left"}`} role="menu">
						{entries.map((it) => (
							<button
								key={it.id}
								type="button"
								role="menuitem"
								className={`orb-item ${it.active ? "current" : ""}`}
								onClick={() => {
									onPick(it.id);
									setOpen(false);
								}}
							>
								{it.icon}
								<span className="orb-item-label">{it.label}</span>
							</button>
						))}
					</div>
				)}
			</div>
		</>
	);
}
