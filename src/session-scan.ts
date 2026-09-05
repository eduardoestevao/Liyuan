/**
 * 会话文件的浅扫描：不整份 load，只从头尾各取一段找 `rp-card` 自描述条目。
 *
 * 为什么单独一个模块：这段扫描原先只活在 `server/main.ts`（`readSessionCard`，带 mtime 缓存），
 * 而解析活在 `server/wire.ts`。迁移器（`src/migrate-cards.ts`）要按卡给会话分组，也需要同一份
 * 判据——与其在 src/ 里再抄一遍（铁律三：不新增平行实现），不如把「怎么认一个会话属于哪张卡」
 * 收进一处。`server/wire.ts` 同名再导出，既有调用方不动。
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

/** 会话头尾各扫这么多字节（换卡后新的 rp-card 标记 append 在文件末尾） */
export const SESSION_SCAN_WINDOW = 65536;

export interface SessionCardInfo {
	/** 角色卡路径（写入时的原文，可能是相对/绝对、正反斜杠） */
	card: string;
	/** 卡显示名（写入时的快照，可能为空） */
	name: string;
	/** 绑定的剧情会话 id（助手会话对齐用） */
	storyId?: string;
}

/**
 * 从会话 JSONL 文本解析 `rp-card` 自描述条目（PLAN-PHASE3 §2.1）。
 * 取**最后一条**（换卡后会补写新标记；旧标记可能仍留在文件前部）。
 */
export function parseCardFromSessionHead(headText: string): SessionCardInfo | null {
	let found: SessionCardInfo | null = null;
	for (const line of headText.split(/\r?\n/)) {
		if (!line.includes('"rp-card"')) continue; // 快速跳过
		try {
			const e = JSON.parse(line) as {
				type?: unknown;
				customType?: unknown;
				data?: { card?: unknown; name?: unknown; storyId?: unknown };
			};
			if (e.type === "custom" && e.customType === "rp-card" && e.data && typeof e.data.card === "string") {
				found = {
					card: e.data.card,
					name: typeof e.data.name === "string" ? e.data.name : "",
					...(typeof e.data.storyId === "string" && e.data.storyId.trim()
						? { storyId: e.data.storyId.trim() }
						: {}),
				};
			}
		} catch {
			// 半行/损坏行跳过
		}
	}
	return found;
}

/** 读一个会话文件的头尾窗口（大文件不整份读；读不到返回空串） */
export function readSessionHeadTail(path: string, window = SESSION_SCAN_WINDOW): string {
	try {
		const size = statSync(path).size;
		const fd = openSync(path, "r");
		try {
			const headLen = Math.min(size, window);
			const headBuf = Buffer.alloc(headLen);
			readSync(fd, headBuf, 0, headLen, 0);
			let text = headBuf.toString("utf8");
			if (size > window) {
				const tailLen = Math.min(size - headLen, window);
				const tailBuf = Buffer.alloc(tailLen);
				readSync(fd, tailBuf, 0, tailLen, size - tailLen);
				text += `\n${tailBuf.toString("utf8")}`;
			}
			return text;
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

/** 这个会话文件属于哪张卡（认不出返回 null） */
export function readSessionCardInfo(path: string, window = SESSION_SCAN_WINDOW): SessionCardInfo | null {
	const text = readSessionHeadTail(path, window);
	return text ? parseCardFromSessionHead(text) : null;
}
