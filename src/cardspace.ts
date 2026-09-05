/**
 * 卡＝工作空间：卡文件夹（`cards/<卡文件夹>/`）与**子项目**（`对话/<对话id>/`）的
 * 发现、创建、元数据与卡级配置。
 *
 * 用户定的两层形状（2026-09-06，原话大意）：
 * **最外面一层是卡**；卡下面每一个**独立的对话是一个子项目**；一个子项目里**能包含很多会话**
 * ——「能在第二个会话窗口继续聊」的是同一个子项目里的另一个会话，「完全新开对话」才是新子项目。
 *
 * 这一层落到 pi 上正好有现成机制，不用新造：
 * - **同一子项目里再开一个会话** ＝ `runtime.newSession()`：它复用当前 `sessionDir`
 *   （`agent-session-runtime.ts:235`），本子项目的会话自然待在一起。
 * - **切到别的子项目** ＝ `switchSession(该子项目里的某个会话文件)`：`SessionManager.open`
 *   在没给 sessionDir 时**按文件父目录推导**（`session-manager.ts:1429`），sessionDir 随之换过去。
 * - **新开子项目** ＝ 建目录后 `SessionManager.create(cwd, 该子项目的会话目录)`。
 *
 * 目录名的唯一主人是 `src/paths.ts`；本模块只做「找 / 建 / 读写元数据」。
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { readJsonFile } from "./jsonio.ts";
import {
	CARD_CONFIG_FILE,
	CARDS_ROOT,
	CHAT_META_FILE,
	cardDirOf,
	cardsRoot,
	chatDirOf,
	chatSessionsDirOf,
	chatsRoot,
	folderSafe,
} from "./paths.ts";
import type { RpConfig } from "./types.ts";

/** 卡本体可能的扩展名（与 `loadCardFile` 认的一致） */
const CARD_EXTS = [".png", ".json"];

export interface CardSpace {
	/** `cards/` 下的一级目录名 ＝ 这张卡的身份 */
	folder: string;
	/** 卡文件夹绝对路径 */
	dir: string;
	/** 卡本体文件绝对路径 */
	cardFile: string;
}

/** 子项目元数据（`对话/<id>/对话.json`） */
export interface ChatMeta {
	/** 显示名：用户可改；缺省由建立时间生成 */
	name?: string;
	/** ISO 时间 */
	createdAt: string;
}

export interface ChatInfo {
	id: string;
	/** 子项目目录绝对路径 */
	dir: string;
	/** 本子项目的会话目录（＝ 传给 SessionManager 的 sessionDir） */
	sessionsDir: string;
	meta: ChatMeta;
	/** 本子项目下的会话文件数 */
	sessionCount: number;
	/** 最近活动时间（取会话文件里最新的 mtime，无会话则取目录 mtime） */
	modified: number;
}

// ---------- 卡文件夹 ----------

/** 卡文件夹里的卡本体：排除 `卡.json` 这类固定成员，取字典序第一个 .png/.json */
export function cardFileIn(dirAbs: string): string | null {
	let names: string[];
	try {
		names = readdirSync(dirAbs);
	} catch {
		return null;
	}
	const hit = names
		.filter((n) => n !== CARD_CONFIG_FILE && CARD_EXTS.some((e) => n.toLowerCase().endsWith(e)))
		.filter((n) => {
			try {
				return statSync(join(dirAbs, n)).isFile();
			} catch {
				return false;
			}
		})
		.sort();
	return hit.length > 0 ? join(dirAbs, hit[0]) : null;
}

/** `cards/<folder>` 形态的引用 → CardSpace；不是卡文件夹（或里面没有卡本体）返回 null */
export function resolveCardSpace(cwd: string, ref: string): CardSpace | null {
	if (!ref) return null;
	const rel = ref.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
	const prefix = `${CARDS_ROOT}/`;
	if (!rel.startsWith(prefix)) return null;
	const folder = rel.slice(prefix.length);
	if (!folder || folder.includes("/")) return null; // 只认一级目录
	const dirAbs = cardDirOf(cwd, folder);
	if (!existsSync(dirAbs)) return null;
	const cardFile = cardFileIn(dirAbs);
	if (!cardFile) return null;
	return { folder, dir: dirAbs, cardFile };
}

/** 卡库：`cards/` 下每个含卡本体的一级目录 */
export function listCardSpaces(cwd: string): CardSpace[] {
	const root = cardsRoot(cwd);
	if (!existsSync(root)) return [];
	const out: CardSpace[] = [];
	for (const folder of readdirSync(root).sort()) {
		const dirAbs = join(root, folder);
		try {
			if (!statSync(dirAbs).isDirectory()) continue;
		} catch {
			continue;
		}
		const cardFile = cardFileIn(dirAbs);
		if (cardFile) out.push({ folder, dir: dirAbs, cardFile });
	}
	return out;
}

/** 取一个没被占用的文件夹名（同名卡加 `-2`、`-3`…） */
export function freeCardFolder(cwd: string, preferred: string): string {
	const base = folderSafe(preferred) || "card";
	let name = base;
	let n = 2;
	while (existsSync(cardDirOf(cwd, name))) {
		name = `${base}-${n}`;
		n += 1;
	}
	return name;
}

/**
 * 建一张卡的工作空间：`cards/<folder>/` + 把卡本体放进去。
 * `move=true` 时搬（迁移用），否则拷（导入用）。
 */
export function createCardSpace(
	cwd: string,
	cardFileAbs: string,
	preferredName: string,
	opts?: { move?: boolean; copy?: (from: string, to: string) => void },
): CardSpace {
	const folder = freeCardFolder(cwd, preferredName);
	const dirAbs = cardDirOf(cwd, folder);
	mkdirSync(dirAbs, { recursive: true });
	const dest = join(dirAbs, basename(cardFileAbs));
	if (opts?.move) renameSync(cardFileAbs, dest);
	else if (opts?.copy) opts.copy(cardFileAbs, dest);
	else throw new Error("createCardSpace：要么 move，要么给 copy");
	return { folder, dir: dirAbs, cardFile: dest };
}

// ---------- 子项目（一个独立的对话） ----------

/** 可排序、可读、Windows 合法（无冒号）的对话 id */
export function newChatId(now = new Date()): string {
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
	return `${stamp}-${randomBytes(2).toString("hex")}`;
}

export function readChatMeta(cardDir: string, chatId: string): ChatMeta | null {
	const file = join(chatDirOf(cardDir, chatId), CHAT_META_FILE);
	if (!existsSync(file)) return null;
	try {
		const raw = readJsonFile(file) as Partial<ChatMeta>;
		return { createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "", ...(raw.name ? { name: raw.name } : {}) };
	} catch {
		return null;
	}
}

export function writeChatMeta(cardDir: string, chatId: string, meta: ChatMeta): void {
	const dirAbs = chatDirOf(cardDir, chatId);
	mkdirSync(dirAbs, { recursive: true });
	writeFileSync(join(dirAbs, CHAT_META_FILE), `${JSON.stringify(meta, null, "\t")}\n`, "utf8");
}

/** 一个子项目的现状（会话数与最近活动时间取自会话目录，元数据缺失也照样列出） */
export function chatInfo(cardDir: string, chatId: string): ChatInfo {
	const dirAbs = chatDirOf(cardDir, chatId);
	const sessionsDir = chatSessionsDirOf(cardDir, chatId);
	let sessionCount = 0;
	let modified = 0;
	try {
		for (const f of readdirSync(sessionsDir)) {
			if (!f.endsWith(".jsonl")) continue;
			sessionCount += 1;
			const m = statSync(join(sessionsDir, f)).mtimeMs;
			if (m > modified) modified = m;
		}
	} catch {
		/* 还没有会话目录：算 0 条 */
	}
	if (modified === 0) {
		try {
			modified = statSync(dirAbs).mtimeMs;
		} catch {
			modified = 0;
		}
	}
	const meta = readChatMeta(cardDir, chatId) ?? { createdAt: "" };
	return { id: chatId, dir: dirAbs, sessionsDir, meta, sessionCount, modified };
}

/** 本卡的全部子项目，按最近活动倒序 */
export function listChats(cardDir: string): ChatInfo[] {
	const root = chatsRoot(cardDir);
	if (!existsSync(root)) return [];
	const out: ChatInfo[] = [];
	for (const id of readdirSync(root)) {
		try {
			if (!statSync(join(root, id)).isDirectory()) continue;
		} catch {
			continue;
		}
		out.push(chatInfo(cardDir, id));
	}
	// 最近活动倒序；时间戳并列（同一毫秒写入）时按 id 倒序兜底——id 本身就是可排序的时间戳，
	// 不给兜底的话顺序由 readdir 决定，同一份磁盘上两次调用可能不一样。
	return out.sort((a, b) => b.modified - a.modified || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** 建一个新的子项目（＝「完全新开对话」）：目录 + 会话目录 + 元数据 */
export function createChat(cardDir: string, opts?: { id?: string; name?: string; now?: Date }): ChatInfo {
	const now = opts?.now ?? new Date();
	const id = opts?.id ?? newChatId(now);
	mkdirSync(chatSessionsDirOf(cardDir, id), { recursive: true });
	writeChatMeta(cardDir, id, { createdAt: now.toISOString(), ...(opts?.name ? { name: opts.name } : {}) });
	return chatInfo(cardDir, id);
}

/** 最近活动的子项目（没有则 null——调用方决定是建一个还是报错） */
export function latestChat(cardDir: string): ChatInfo | null {
	return listChats(cardDir)[0] ?? null;
}

// ---------- 卡级配置 ----------

/**
 * 跟卡走的字段（2026-09-05 用户定案的 10 项里去掉 `card` 自己——
 * 「当前打开哪张卡」是全局单值，不是某张卡的属性）。
 * 其余 9 项留在产品根的 `liyuan.config.json`。
 */
export const CARD_LEVEL_KEYS = [
	"lorebooks",
	"userName",
	"userPersona",
	"displayName",
	"greeting",
	"greetingIndex",
	"disabledLore",
	"cardSkinOff",
	"preset",
] as const satisfies ReadonlyArray<keyof RpConfig>;

export type CardLevelKey = (typeof CARD_LEVEL_KEYS)[number];
export type CardConfig = Partial<Pick<RpConfig, CardLevelKey>>;

const CARD_LEVEL_SET = new Set<string>(CARD_LEVEL_KEYS);

export function cardConfigPath(cardDir: string): string {
	return join(cardDir, CARD_CONFIG_FILE);
}

/** 读卡级配置；文件不存在/坏了都当「这张卡没有自己的意见」（全部继承全局） */
export function loadCardConfig(cardDir: string): CardConfig {
	const file = cardConfigPath(cardDir);
	if (!existsSync(file)) return {};
	let raw: Record<string, unknown>;
	try {
		raw = readJsonFile(file) as Record<string, unknown>;
	} catch {
		return {};
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(raw ?? {})) {
		if (CARD_LEVEL_SET.has(k) && v !== undefined) out[k] = v;
	}
	return out as CardConfig;
}

/** 写卡级配置（只落跟卡走的字段；`undefined`/`null` ＝ 删掉这条意见、回到继承全局） */
export function saveCardConfig(cardDir: string, patch: Record<string, unknown>): CardConfig {
	const next: Record<string, unknown> = { ...loadCardConfig(cardDir) };
	for (const [k, v] of Object.entries(patch)) {
		if (!CARD_LEVEL_SET.has(k)) continue;
		if (v === undefined || v === null) delete next[k];
		else next[k] = v;
	}
	mkdirSync(cardDir, { recursive: true });
	writeFileSync(cardConfigPath(cardDir), `${JSON.stringify(next, null, "\t")}\n`, "utf8");
	return next as CardConfig;
}

/**
 * 合并语义（2026-09-06 定案）：**逐字段赢者独占，卡级盖全局**。
 * 卡级没写这条 ⇒ 继承全局；写了 ⇒ 这条对本卡切断继承。
 *
 * 为什么不是叠加：pi 那边只有 `AGENTS.md` 是真叠加，而它叠的是**文本**；
 * `SYSTEM.md`/`APPEND_SYSTEM.md` 都是赢者独占。配置这一格是标量与清单，
 * 逐字段覆盖既最可预测，也天然给出「这张卡不继承那条全局偏好」的表达方式。
 */
export function mergeCardConfig(global: RpConfig, card: CardConfig): RpConfig {
	const out = { ...global } as Record<string, unknown>;
	for (const k of CARD_LEVEL_KEYS) {
		const v = (card as Record<string, unknown>)[k];
		if (v !== undefined) out[k] = v;
	}
	return out as RpConfig;
}
