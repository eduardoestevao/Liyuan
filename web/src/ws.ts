/**
 * WS 客户端：同源 /ws，断线自动重连（300ms 起指数退避，封顶 10s）。
 * 只负责连接与帧收发，状态归 App。
 *
 * 手机运营商 / 反向代理会掐空闲 TCP。开着后每 20s 发一帧应用层 ping，
 * 页面重新可见或网络恢复时立刻补连。短闪断不立刻把 UI 打成「连接中」。
 */

import { useEffect, useRef } from "react";
import type { ClientFrame, ServerFrame } from "./wire.ts";

export type ConnState = "connecting" | "open" | "closed";

export interface WsHandle {
	send: (frame: ClientFrame) => boolean;
}

const PING_MS = 20_000;
/**
 * 断线静默窗口：窗口内连回来 = 什么都没发生，标签不闪。
 * 超过它才如实显示——真断线不该被无声吞掉。
 */
const UI_GRACE_MS = 3_000;
/** 第一次重连的等待：断线多为瞬时抖动，立刻试比等 1.5 秒好（失败后照旧指数退避） */
const RETRY_FIRST_MS = 300;

export function useWire(onFrame: (frame: ServerFrame) => void, onState: (s: ConnState) => void): WsHandle {
	const wsRef = useRef<WebSocket | null>(null);
	const onFrameRef = useRef(onFrame);
	const onStateRef = useRef(onState);
	onFrameRef.current = onFrame;
	onStateRef.current = onState;

	useEffect(() => {
		let closed = false;
		let retryMs = RETRY_FIRST_MS;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let uiTimer: ReturnType<typeof setTimeout> | undefined;
		let pingTimer: ReturnType<typeof setInterval> | undefined;
		let everOpen = false;
		/** 静默窗口已过、标签已经亮过：之后如实跟手显示 */
		let downShown = false;
		/** 最近一次「非 open」状态（窗口到期时按它显示） */
		let downState: ConnState = "closed";
		let generation = 0;

		const clearRetry = () => {
			if (retryTimer) clearTimeout(retryTimer);
			retryTimer = undefined;
		};
		const clearPing = () => {
			if (pingTimer) clearInterval(pingTimer);
			pingTimer = undefined;
		};
		const showState = (s: ConnState) => {
			if (s === "open") {
				if (uiTimer) clearTimeout(uiTimer);
				uiTimer = undefined;
				downShown = false;
				onStateRef.current("open");
				return;
			}
			downState = s;
			// 首屏第一次连接照旧立即显示；已亮过标签的真断线，之后如实跟手切换
			if (!everOpen || downShown) {
				downShown = true; // 已经告诉过用户「没连上」——重连尝试不再逐次翻标签
				onStateRef.current(s);
				return;
			}
			// 静默期：一个窗口只排一次，到期统一按当时的真实状态显示
			if (uiTimer) return;
			uiTimer = setTimeout(() => {
				uiTimer = undefined;
				downShown = true;
				onStateRef.current(downState);
			}, UI_GRACE_MS);
		};

		const startPing = (ws: WebSocket) => {
			clearPing();
			pingTimer = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" } satisfies ClientFrame));
			}, PING_MS);
		};

		const connect = () => {
			if (closed) return;
			const prev = wsRef.current;
			if (prev && (prev.readyState === WebSocket.OPEN || prev.readyState === WebSocket.CONNECTING)) return;
			if (prev) {
				try {
					prev.close();
				} catch {
					/* ignore */
				}
			}
			const gen = ++generation;
			clearRetry();
			// 真断线期间（标签已亮）不再逐次翻「连接中」——重连尝试都算「已断开」的一部分，
			// 否则每次退避重试都在标签上来回跳一次。
			if (!downShown) showState("connecting");
			const proto = location.protocol === "https:" ? "wss:" : "ws:";
			const ws = new WebSocket(`${proto}//${location.host}/ws`);
			wsRef.current = ws;

			ws.onopen = () => {
				if (gen !== generation) return;
				everOpen = true;
				retryMs = RETRY_FIRST_MS;
				startPing(ws);
				showState("open");
			};
			ws.onmessage = (ev) => {
				try {
					onFrameRef.current(JSON.parse(String(ev.data)) as ServerFrame);
				} catch {
					// 非 JSON 帧忽略
				}
			};
			ws.onclose = (ev) => {
				if (closed || gen !== generation) return;
				if (ev.code === 4401) {
					location.reload();
					return;
				}
				clearPing();
				showState("closed");
				retryTimer = setTimeout(connect, retryMs);
				retryMs = Math.min(retryMs * 2, 10_000);
			};
			ws.onerror = () => {
				if (gen !== generation) return;
				ws.close();
			};
		};

		const onWake = () => {
			if (closed) return;
			if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
			const ws = wsRef.current;
			if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
			retryMs = RETRY_FIRST_MS;
			connect();
		};

		connect();
		document.addEventListener("visibilitychange", onWake);
		window.addEventListener("online", onWake);
		return () => {
			closed = true;
			generation++;
			clearRetry();
			clearPing();
			if (uiTimer) clearTimeout(uiTimer);
			document.removeEventListener("visibilitychange", onWake);
			window.removeEventListener("online", onWake);
			wsRef.current?.close();
		};
	}, []);

	return {
		send: (frame) => {
			const ws = wsRef.current;
			if (ws && ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify(frame));
				return true;
			}
			return false;
		},
	};
}
