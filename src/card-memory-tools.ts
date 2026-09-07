/** Exact Markdown memory access. Manual sources win over asynchronous recap/consolidation. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadManifest, memoryPaths, saveManifest, type MemoryManifest } from "./card-memory.ts";
import type { MemoryDocument, MemoryHitLike } from "./tools/memory.ts";

export const memoryTextVersion = (text: string): string => createHash("sha256").update(text).digest("hex");
const raw = (file: string) => {
	try { return readFileSync(file, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
};
function documents(cardDir: string): Array<{ ref: string; path: string; chatId?: string }> {
	const p = memoryPaths(cardDir);
	const recaps = existsSync(p.recapsDir) ? readdirSync(p.recapsDir).filter((n) => /^[a-zA-Z0-9_-]+\.md$/.test(n)) : [];
	return [{ ref: "card:handbook", path: p.handbook }, { ref: "card:resident", path: p.resident },
		...recaps.map((n) => ({ ref: `card:recap:${n.slice(0, -3)}`, path: join(p.recapsDir, n), chatId: n.slice(0, -3) }))];
}

export function listCardMemory(cardDir: string): MemoryDocument[] {
	const manifest = loadManifest(cardDir);
	return documents(cardDir).flatMap((doc) => {
		const text = raw(doc.path);
		if (text === undefined) return [];
		const version = memoryTextVersion(text);
		if (doc.chatId && (manifest.manual?.forgottenChats.includes(doc.chatId) || manifest.manual?.supersededRecaps[doc.chatId] === version)) return [];
		return [{ ref: doc.ref, version, text, meta: { title: basename(doc.path), fileName: basename(doc.path), source: "card-markdown", scope: doc.chatId ? "card-chat-recap" : "card", ...(doc.chatId ? { chatId: doc.chatId } : {}) },
			...(manifest.manual?.protectedRefs.includes(doc.ref) ? { note: "手工记忆，自动同步不会覆盖。" } : {}) }];
	});
}

export function readCardMemory(cardDir: string, ref: string): MemoryDocument | undefined {
	const docs = listCardMemory(cardDir);
	const doc = docs.find((d) => d.ref === ref);
	return doc ? { ...doc, relatedRefs: docs.filter((d) => d.ref !== ref).map((d) => d.ref) } : undefined;
}

export function searchCardMemory(cardDir: string, query: string, limit = 6): MemoryHitLike[] {
	const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [];
	return listCardMemory(cardDir).flatMap((doc) => {
		const lower = doc.text.toLocaleLowerCase();
		const matches = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0);
		if (!matches.length) return [];
		const from = Math.max(0, Math.min(...matches) - 160);
		return [{ ...doc, text: doc.text.slice(from, Math.min(doc.text.length, from + 1200)), score: matches.length / words.length }];
	}).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
}

function manual(manifest: MemoryManifest): NonNullable<MemoryManifest["manual"]> {
	return manifest.manual ??= { protectedRefs: [], forgottenChats: [], supersededRecaps: {}, aggregatePinned: false, epoch: 0 };
}
function backup(cardDir: string, file: string): void {
	const text = raw(file);
	if (text === undefined) return;
	const root = join(memoryPaths(cardDir).root, ".history");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, `${Date.now()}-${randomUUID()}-${basename(file)}`), text, "utf8");
}

/** One synchronous source transaction. Manifest is written first so a crash fails closed for regeneration. */
export function changeCardMemory(cardDir: string, ref: string, version: string, content?: string): MemoryDocument | undefined {
	const doc = readCardMemory(cardDir, ref);
	if (!doc || !version || doc.version !== version) throw new Error("记忆版本冲突或引用已失效；请重新 memory_read。");
	const target = documents(cardDir).find((d) => d.ref === ref)!;
	const p = memoryPaths(cardDir), manifest = loadManifest(cardDir), control = manual(manifest);
	const protect = (key: string) => { if (!control.protectedRefs.includes(key)) control.protectedRefs.push(key); };
	protect(ref); control.epoch++;
	if (target.chatId) {
		if (content === undefined && !control.forgottenChats.includes(target.chatId)) control.forgottenChats.push(target.chatId);
	} else {
		control.aggregatePinned = true;
		for (const d of listCardMemory(cardDir)) if (d.meta?.chatId) control.supersededRecaps[d.meta.chatId] = d.version;
	}
	// Invalid derived summaries must not continue feeding the next beat. Preserve user-owned documents.
	const invalidate = ["card:handbook", "card:resident"].filter((key) => key !== ref && !control.protectedRefs.includes(key));
	for (const record of Object.values(manifest.recaps)) delete record.mergedHash;
	backup(cardDir, target.path);
	for (const key of invalidate) backup(cardDir, key === "card:handbook" ? p.handbook : p.resident);
	saveManifest(cardDir, manifest);
	if (content === undefined) unlinkSync(target.path);
	else {
		const temp = `${target.path}.${randomUUID()}.tmp`;
		writeFileSync(temp, content, "utf8"); renameSync(temp, target.path);
	}
	for (const key of invalidate) {
		const path = key === "card:handbook" ? p.handbook : p.resident;
		if (existsSync(path)) unlinkSync(path);
	}
	const updated = readCardMemory(cardDir, ref);
	if (updated) updated.note = target.chatId
		? "源复盘已固定为手工稿；旧自动汇总已失效，下一次同步从现存复盘重建。"
		: "手工汇总已保存；自动合并暂停，已参与旧汇总的复盘不再被检索。其他局的新复盘仍可独立读取。";
	return updated;
}
