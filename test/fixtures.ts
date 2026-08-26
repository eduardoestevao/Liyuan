/**
 * 测试夹具：**按属性发现**本地实卡与实书，不点名任何一张。
 *
 * 为什么不写死文件名（2026-08-26）：具体角色卡的名字不许出现在源码里——卡是用户私有内容，
 * 名字本身也不该进公开仓库。而实卡回归测试的价值从来不在「这一张卡」，而在「带某种形状的卡」，
 * 所以判据本就该是形状：`findLocalCard(卡的显示规则里有成对开闭状态栏标签)` 比
 * `readCardRawJson("assets/cards/某某.png")` 既更脱敏、也更准确地表达了测试意图。
 *
 * 本地卡与实书全部 gitignore（只有 `assets/cards/default_*` 与一本样本世界书入库），
 * 故在 clean clone / CI 里这些发现函数一律返回 null / 空数组——调用方据此**跳过而非红**。
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readCardRawJson } from "../src/card.ts";
import { loadLorebookFile, type LorebookEntry } from "../src/lorebook.ts";

const CARD_DIR = "assets/cards";
const LOREBOOK_DIR = "assets/lorebooks";

export interface LocalCard {
	/** 卡文件路径（调用方要传给生产函数时用；不要断言它的内容） */
	path: string;
	/** 卡原文 JSON（PNG 卡已解码） */
	raw: Record<string, unknown>;
	/** v2/v3 的 data 层，没有 data 就是顶层 */
	data: Record<string, unknown>;
}

/** 本地全部可解的卡：`assets/cards/` 下的 png/json + 仓库根的 `_card-*.json` 脚手架 */
export function localCards(): LocalCard[] {
	const files: string[] = [];
	if (existsSync(CARD_DIR)) {
		for (const f of readdirSync(CARD_DIR)) {
			if (/\.(png|json)$/i.test(f)) files.push(join(CARD_DIR, f));
		}
	}
	for (const f of readdirSync(".")) {
		if (/^_card-.*\.json$/i.test(f)) files.push(f);
	}
	const out: LocalCard[] = [];
	for (const path of files) {
		try {
			const { raw } = readCardRawJson(path);
			const data = (raw.data && typeof raw.data === "object" ? raw.data : raw) as Record<string, unknown>;
			out.push({ path, raw, data });
		} catch {
			// 坏卡 / 非卡 PNG：跳过，别让一个坏文件拖红整条测试
		}
	}
	return out;
}

/** 第一张满足形状判据的本地卡；一张都没有返回 null（调用方跳过） */
export function findLocalCard(pred: (c: LocalCard) => boolean): LocalCard | null {
	for (const c of localCards()) {
		try {
			if (pred(c)) return c;
		} catch {
			// 判据在某张卡上抛（字段缺失等）→ 当作不匹配
		}
	}
	return null;
}

export interface LocalLorebook {
	path: string;
	entries: LorebookEntry[];
}

/** 本地全部可解的世界书（`assets/lorebooks/*.json`） */
export function localLorebooks(): LocalLorebook[] {
	if (!existsSync(LOREBOOK_DIR)) return [];
	const out: LocalLorebook[] = [];
	for (const f of readdirSync(LOREBOOK_DIR)) {
		if (!f.endsWith(".json")) continue;
		const path = join(LOREBOOK_DIR, f);
		try {
			out.push({ path, entries: loadLorebookFile(path) });
		} catch {
			// 坏书跳过
		}
	}
	return out;
}

/** 第一本满足形状判据的本地世界书；一本都没有返回 null（调用方跳过） */
export function findLocalLorebook(pred: (b: LocalLorebook) => boolean): LocalLorebook | null {
	for (const b of localLorebooks()) {
		try {
			if (pred(b)) return b;
		} catch {
			// 同上
		}
	}
	return null;
}
