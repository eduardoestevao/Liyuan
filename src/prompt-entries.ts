/**
 * 提示词条目（2026-09-08 用户定形）：文件是真源，条目是投影——补回酒馆
 * 「开关条目」的易用性，而不放弃 agent 的文件形态。
 *
 * 约定（零新语法，全部是 markdown 通用概念）：
 * - `## 小节` ＝ 一个条目（名字＝小节标题，内容＝节正文；`#` 大标题同法）
 * - **整段包在 HTML 注释里 ＝ 关闭**：`<!--` 独占一行开始、`-->` 独占一行结束，
 *   内部首行是标题。GitHub 渲染时隐藏，源码里一眼可见——注释掉＝关闭
 * - 其余注释块 ＝ 给人看的备注：引擎送模时剥掉，条目视图不管它
 *
 * 两半：
 * - **引擎** `renderForModel`：解析后丢掉关闭条目与全部注释，产出送模文本
 *   （materials 对两级 APPEND 与卡 AGENTS.md 都走它）
 * - **手术** toggle/rename/setContent/append/delete：条目视图对**原文**的定点修改，
 *   不重排不丢备注（往返无损——文件永远是从源码视图看到的那份）
 *
 * 纯函数 + 零模块级可变状态（jiti 二相性红线），可单测；web 直接 import。
 */

export interface PromptEntry {
	/** 小节标题（不含 # 号） */
	name: string;
	/** 节正文（不含标题行），原样保留 */
	content: string;
	/** false ＝ 整段被注释包裹（关闭） */
	enabled: boolean;
	/** 标题层级（1~6）——渲染时原样还原，### 子节不压平 */
	level: number;
}

const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** 行是否是独占一行的注释定界 */
const isCommentLine = (line: string, token: string): boolean => line.trim() === token;

/**
 * 解析成条目列表。文件里第一个标题之前的正文（若有）作为一个无标题条目
 * （name=""）置顶；备注注释不进条目（它们活在原文里，由源码视图照看）。
 */
export function parsePromptEntries(md: string): PromptEntry[] {
	const lines = md.split("\n");
	const entries: PromptEntry[] = [];
	let current: PromptEntry | null = null;
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (isCommentLine(line, COMMENT_OPEN)) {
			// 收整段注释
			const close = (() => {
				for (let j = i + 1; j < lines.length; j++) if (isCommentLine(lines[j], COMMENT_CLOSE)) return j;
				return -1;
			})();
			const end = close >= 0 ? close : lines.length - 1;
			const inner = lines.slice(i + 1, close >= 0 ? close : lines.length);
			const first = inner.find((l) => l.trim() !== "");
			const m = first ? HEADING_RE.exec(first.trim()) : null;
			if (m) {
				// 注释掉的标题节 ＝ 关闭的条目（正文取标题后的所有行）
				const body = inner.slice(inner.indexOf(first!) + 1);
				flush(entries, current);
				current = { name: m[2].trim(), content: body.join("\n").trim(), enabled: false, level: m[1].length };
			}
			// 非标题注释 ＝ 备注：跳过（留在原文，不进条目）
			i = end + 1;
			continue;
		}
		const m = HEADING_RE.exec(line);
		if (m) {
			flush(entries, current);
			current = { name: m[2].trim(), content: "", enabled: true, level: m[1].length };
		} else if (current) {
			current.content = current.content ? `${current.content}\n${line}` : line;
		} else {
			// 标题前的正文：无标题条目（一次性吸收，之后有标题就正常分段）
			current = { name: "", content: line, enabled: true, level: 0 };
		}
		i++;
	}
	flush(entries, current);
	return entries.map((e) => ({ ...e, content: e.content.trim() }));
}

const flush = (entries: PromptEntry[], current: PromptEntry | null): void => {
	if (current && (current.name || current.content.trim())) {
		// 同名去重：解析层面以首次出现为准（编辑器层面禁止重名）
		if (!entries.some((e) => e.name === current.name)) entries.push(current);
	}
};

/**
 * 引擎：解析 → 丢关闭条目、丢全部注释块 → 送模文本。
 * 空文件/全关 ⇒ 空串（用户的选择，装配层照实呈现）。
 */
export function renderForModel(md: string): string {
	const entries = parsePromptEntries(md);
	const out: string[] = [];
	for (const e of entries) {
		if (!e.enabled) continue;
		const heading = e.name ? `${"#".repeat(e.level)} ${e.name}` : "";
		out.push([heading, e.content].filter((s) => s.trim()).join("\n"));
	}
	return out.join("\n\n").trim();
}

// ---------------- 条目视图的定点手术（对原文，不重排） ----------------

/** 找条目的原文行区间 [start, end)（含注释包裹行）；找不到返回 null */
function entrySpan(lines: string[], name: string): [number, number] | null {
	let i = 0;
	while (i < lines.length) {
		if (isCommentLine(lines[i], COMMENT_OPEN)) {
			const close = findClose(lines, i);
			const first = lines.slice(i + 1, close).find((l) => l.trim() !== "");
			const m = first ? HEADING_RE.exec(first.trim()) : null;
			if (m && m[2].trim() === name) return [i, close + 1];
			i = close + 1;
			continue;
		}
		const m = HEADING_RE.exec(lines[i]);
		if (m && m[2].trim() === name) {
			// 到下一个条目边界（下一个标题或注释标题）为止
			let j = i + 1;
			while (j < lines.length) {
				if (isCommentLine(lines[j], COMMENT_OPEN)) {
					const c = findClose(lines, j);
					const f = lines.slice(j + 1, c).find((l) => l.trim() !== "");
					if (f && HEADING_RE.test(f.trim())) break;
					j = c + 1;
					continue;
				}
				if (HEADING_RE.test(lines[j])) break;
				j++;
			}
			// 吃掉节尾空行（留给段间分隔）
			while (j - 1 > i && lines[j - 1].trim() === "") j--;
			return [i, j];
		}
		i++;
	}
	return null;
}

const findClose = (lines: string[], open: number): number => {
	for (let j = open + 1; j < lines.length; j++) if (isCommentLine(lines[j], COMMENT_CLOSE)) return j;
	return lines.length; // 未闭合：按到文件尾处理
};

const withSpan = (md: string, name: string, fn: (lines: string[], start: number, end: number) => string[]): string | null => {
	const lines = md.split("\n");
	const span = entrySpan(lines, name);
	if (!span) return null;
	return fn(lines, span[0], span[1]).join("\n");
};

/** 开关条目：关＝包注释，开＝去注释 */
export function toggleEntry(md: string, name: string, enabled: boolean): string | null {
	return withSpan(md, name, (lines, start, end) => {
		const section = lines.slice(start, end);
		if (enabled) {
			// 去掉包裹（首行 <!-- 尾行 -->）
			if (isCommentLine(section[0], COMMENT_OPEN) && isCommentLine(section[section.length - 1], COMMENT_CLOSE)) {
				return [...lines.slice(0, start), ...section.slice(1, -1), ...lines.slice(end)];
			}
			return lines;
		}
		// 包上
		if (isCommentLine(section[0], COMMENT_OPEN)) return lines;
		return [...lines.slice(0, start), COMMENT_OPEN, ...section, COMMENT_CLOSE, ...lines.slice(end)];
	});
}

/** 改条目正文（保留标题行/注释包裹不动） */
export function setEntryContent(md: string, name: string, content: string): string | null {
	return withSpan(md, name, (lines, start, end) => {
		const section = lines.slice(start, end);
		const wrapped = isCommentLine(section[0], COMMENT_OPEN);
		const bodyStart = start + (wrapped ? 2 : 1);
		const bodyEnd = end - (wrapped ? 1 : 0);
		const body = content.split("\n");
		return [...lines.slice(0, bodyStart), ...body, ...lines.slice(bodyEnd)];
	});
}

/** 添加条目（追加到文件尾；重名返回 null） */
export function appendEntry(md: string, name: string, content: string): string | null {
	if (parsePromptEntries(md).some((e) => e.name === name)) return null;
	const base = md.replace(/\s+$/, "");
	const section = `## ${name}\n${content.trim()}`;
	return base ? `${base}\n\n${section}\n` : `${section}\n`;
}

/** 删除条目（连同注释包裹） */
export function deleteEntry(md: string, name: string): string | null {
	return withSpan(md, name, (lines, start, end) => {
		const out = [...lines.slice(0, start), ...lines.slice(end)];
		// 段间双空行收一
		return out.join("\n").replace(/\n{3,}/g, "\n\n").split("\n");
	});
}
