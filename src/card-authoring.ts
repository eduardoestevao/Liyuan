/**
 * 卡创作工程：原包快照 + 按原始位置展开的文本资源。
 * 只回写声明的字符串槽位；未知 JSON、插件元数据、条目 ID 与 PNG 图像留在原包。
 * 所有入口共用这一层。没有模型循环，也不读取卡 AGENTS.md 作为开发指令。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Script } from "node:vm";
import { normalizeCard, readCardRawBuffer, readCardRawJson, writeCardJsonToPng } from "./card.ts";
import { resolveCardSpace } from "./cardspace.ts";
import { CARD_AUTHORING_DIR, dir } from "./paths.ts";
import { buildCardFrontSnapshot } from "./cardfront.ts";
import { findInitVar, findSchemaDefaults } from "./mvu.ts";
import { buildCardOutline, isCardSectionId, type CardSectionDeclarations } from "./card-outline.ts";

import type { CardResourceKind, CardResource, CardProjectStatus, CardProjectBuild, CardProjectPreview, CardOutline } from "./card-authoring-types.ts";
export type { CardResourceKind, CardResource, CardProjectStatus, CardProjectBuild, CardProjectPreview, CardOutline } from "./card-authoring-types.ts";
interface Manifest {
	version: 1;
	original: string;
	base: string;
	previous?: string;
	/** 复制产生的新增资源：完整载荷插入到 path（base 快照里没有） */
	additions?: Array<{ path: string[]; payload: unknown }>;
	/** 上一次应用前的 additions，供撤回恢复 */
	previousAdditions?: Array<{ path: string[]; payload: unknown }>;
}

const record = (v: unknown): Record<string, unknown> | null =>
	v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
export const cardSourceHash = (v: string | Buffer): string => createHash("sha256").update(v).digest("hex");
const manifestFile = (root: string) => join(root, "manifest.json");

function inside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/")));
}

/** 也校验实际路径：工程目录、资源文件中的符号链接不能把写入带出作品目录。 */
function guardedPath(root: string, rel: string): string {
	const target = resolve(root, rel);
	if (!inside(resolve(root), target)) throw new Error("资源路径超出创作目录");
	let existing = target;
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) throw new Error("找不到创作目录");
		existing = parent;
	}
	if (!inside(realpathSync(root), realpathSync(existing))) throw new Error("资源链接超出创作目录");
	return target;
}

export function cardAuthoringDirectory(cwd: string, cardPath: string): string {
	const abs = resolve(cardPath);
	const space = resolveCardSpace(cwd, relative(cwd, abs));
	const root = space
		? join(space.dir, CARD_AUTHORING_DIR)
		: join(dir(cwd, "artifacts"), "card-authoring", cardSourceHash(abs).slice(0, 20));
	// 只在产品工作区建立工程；项目外原卡仍通过本地工程快照编辑。
	let existing = root;
	while (!existsSync(existing)) existing = dirname(existing);
	if (!inside(realpathSync(cwd), realpathSync(existing))) throw new Error("创作目录链接超出工作区");
	return root;
}

function atomicWrite(file: string, value: string | Buffer): void {
	const tmp = file + "." + randomUUID() + ".tmp";
	try {
		writeFileSync(tmp, value, { flag: "wx" });
		renameSync(tmp, file);
	} finally {
		if (existsSync(tmp)) unlinkSync(tmp);
	}
}

function snapshotFile(root: string, hash: string): string {
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("无效的原包版本");
	return guardedPath(root, "snapshots/" + hash + ".card");
}
function saveSnapshot(root: string, bytes: Buffer): string {
	const hash = cardSourceHash(bytes);
	const file = snapshotFile(root, hash);
	if (!existsSync(file)) writeFileSync(file, bytes, { flag: "wx" });
	else if (cardSourceHash(readFileSync(file)) !== hash) throw new Error("原包快照已被修改");
	return hash;
}
function loadManifest(root: string): Manifest {
	const m = JSON.parse(readFileSync(guardedPath(root, "manifest.json"), "utf8")) as Manifest;
	if (m.version !== 1) throw new Error("不支持的创作工程版本");
	return m;
}
function loadSnapshot(root: string, hash: string) {
	const file = snapshotFile(root, hash);
	const bytes = readFileSync(file);
	if (cardSourceHash(bytes) !== hash) throw new Error("原包快照已被修改");
	return { ...readCardRawBuffer(bytes), bytes };
}
function valueAt(raw: Record<string, unknown>, path: string[]): unknown {
	let value: unknown = raw;
	for (const key of path) {
		if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error("原包资源位置已变化");
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

/** 只识别公开卡格式的槽位；不按标题、角色名或正文词语推测资源类型。 */
export function cardResources(raw: Record<string, unknown>): CardResource[] {
	const resources: CardResource[] = [];
	const data = record(raw.data) ?? raw;
	const prefix = data === raw ? [] : ["data"];
	const add = (kind: CardResourceKind, name: string, path: string[], value: unknown) => {
		if (typeof value !== "string") return;
		const id = kind + "-" + cardSourceHash(JSON.stringify(path)).slice(0, 16);
		const ext = kind === "script" ? ".js" : kind === "regex-template" ? ".html" : ".txt";
		resources.push({ id, kind, name, path, file: "sources/" + id + ext, length: value.length, hash: cardSourceHash(value), changed: false });
	};
	const fields = {
		name: "卡名", description: "描述", personality: "性格", scenario: "场景",
		mes_example: "对话示例", system_prompt: "卡内系统提示", post_history_instructions: "卡内末端提示",
		creator_notes: "作者注", first_mes: "默认开场", creator: "作者", character_version: "版本",
	};
	for (const [field, label] of Object.entries(fields)) {
		const owner = Object.hasOwn(data, field) ? data : raw;
		add(field === "first_mes" ? "greeting" : "field", label, [...(owner === raw ? [] : prefix), field], owner[field]);
	}
	const greetingsOwner = Object.hasOwn(data, "alternate_greetings") ? data : raw;
	if (Array.isArray(greetingsOwner.alternate_greetings)) greetingsOwner.alternate_greetings.forEach((g, i) =>
		add("greeting", "备选开场 " + (i + 1), [...(greetingsOwner === raw ? [] : prefix), "alternate_greetings", String(i)], g));
	const bookOwner = Object.hasOwn(data, "character_book") ? data : raw;
	const book = record(bookOwner.character_book);
	if (book?.entries && typeof book.entries === "object") {
		for (const [key, value] of Object.entries(book.entries)) {
			const e = record(value);
			if (e) add("lore", String(e.comment || e.name || "条目 " + key),
				[...(bookOwner === raw ? [] : prefix), "character_book", "entries", key, "content"], e.content);
		}
	}
	const extensions = record(data.extensions);
	if (Array.isArray(extensions?.regex_scripts)) extensions.regex_scripts.forEach((r, i) => {
		const item = record(r);
		if (!item) return;
		const path = [...prefix, "extensions", "regex_scripts", String(i)];
		const label = String(item.scriptName || "正则 " + (i + 1));
		add("regex-pattern", label + " · 匹配", [...path, "findRegex"], item.findRegex);
		add("regex-template", label + " · 替换", [...path, "replaceString"], item.replaceString);
	});
	for (const ns of ["TavernHelper", "tavern_helper"]) {
		const helper = record(extensions?.[ns]);
		if (Array.isArray(helper?.scripts)) helper.scripts.forEach((s, i) => {
			const item = record(s);
			if (item) add("script", String(item.name || "脚本 " + (i + 1)),
				[...prefix, "extensions", ns, "scripts", String(i), "content"], item.content);
		});
	}
	return resources;
}

export function inspectCardProject(cwd: string, cardPath: string): CardProjectStatus {
	const directory = cardAuthoringDirectory(cwd, cardPath);
	const current = cardSourceHash(readFileSync(cardPath));
	const prepared = existsSync(manifestFile(directory));
	const m = prepared ? loadManifest(directory) : null;
	const { raw } = m ? loadSnapshot(directory, m.base) : readCardRawJson(cardPath);
	const resources = cardResources(raw).map(r => {
		if (!prepared) return r;
		const file = guardedPath(directory, r.file);
		if (!existsSync(file)) writeFileSync(file, String(valueAt(raw, r.path) ?? ""), { flag: "w" });
		const text = readFileSync(file, "utf8");
		return { ...r, length: text.length, hash: cardSourceHash(text), changed: text !== valueAt(raw, r.path) };
	});
	return { prepared, directory, cardName: normalizeCard(raw).name, version: m?.base ?? current,
		conflict: m !== null && m.base !== current, canUndo: Boolean(m?.previous), resources };
}

export function prepareCardProject(cwd: string, cardPath: string): CardProjectStatus {
	const root = cardAuthoringDirectory(cwd, cardPath);
	if (existsSync(manifestFile(root))) return inspectCardProject(cwd, cardPath);
	const bytes = readFileSync(cardPath);
	const { raw } = readCardRawBuffer(bytes);
	normalizeCard(raw);
	mkdirSync(root, { recursive: true });
	mkdirSync(guardedPath(root, "sources"), { recursive: true });
	mkdirSync(guardedPath(root, "snapshots"), { recursive: true });
	for (const r of cardResources(raw)) {
		const file = guardedPath(root, r.file);
		// 未完成的初始化不覆盖已经写过的源文件。
		if (!existsSync(file)) writeFileSync(file, String(valueAt(raw, r.path)), { flag: "wx" });
	}
	const base = saveSnapshot(root, bytes);
	atomicWrite(manifestFile(root), JSON.stringify({ version: 1, original: base, base } satisfies Manifest, null, "\t"));
	return inspectCardProject(cwd, cardPath);
}

export function readCardResource(cwd: string, cardPath: string, id: string) {
	const root = cardAuthoringDirectory(cwd, cardPath);
	const m = loadManifest(root);
	const { raw } = loadSnapshot(root, m.base);
	if (id === "raw") {
		const text = JSON.stringify(raw, null, "\t");
		return { id, text, hash: cardSourceHash(text), file: snapshotFile(root, m.base) };
	}
	const resource = cardResources(raw).find(r => r.id === id);
	if (!resource) throw new Error("找不到资源：" + id);
	const file = guardedPath(root, resource.file);
	const text = readFileSync(file, "utf8");
	return { ...resource, file, text, hash: cardSourceHash(text) };
}

export function writeCardResource(cwd: string, cardPath: string, id: string, text: string, expectedHash: string) {
	if (id === "raw") throw new Error("原包快照只读，请修改展开的资源");
	const resource = readCardResource(cwd, cardPath, id);
	if (!expectedHash || resource.hash !== expectedHash) throw new Error("资源已变化，请重新读取后修改");
	atomicWrite(resource.file, text);
	return { id, hash: cardSourceHash(text), length: text.length };
}

/** 语法检查不执行作者代码。HTML 内脚本的实际错误由预览报告。 */
function scriptSyntaxError(code: string, file: string): string | null {
	try { new Script(code, { filename: file }); return null; } catch { /* 再按 ES module 语法检查 */ }
	const result = spawnSync(process.execPath, ["--check", "--input-type=module"], {
		input: code, encoding: "utf8", timeout: 10_000, maxBuffer: 128_000, windowsHide: true,
	});
	return result.status === 0 ? null : (result.error?.message || result.stderr || "JavaScript 语法检查失败").trim();
}

export function buildCardProject(cwd: string, cardPath: string): CardProjectBuild & { raw: Record<string, unknown> } {
	const root = cardAuthoringDirectory(cwd, cardPath);
	const m = loadManifest(root);
	const { raw } = loadSnapshot(root, m.base);
	const report: CardProjectBuild = { base: m.base, hash: "", changed: [], errors: [], checkedScripts: [], checkedPatterns: [] };
	for (const r of cardResources(raw)) {
		const text = readFileSync(guardedPath(root, r.file), "utf8");
		if (text === valueAt(raw, r.path)) continue;
		report.changed.push(r.id);
		if (r.kind === "script") {
			report.checkedScripts.push(r.id);
			const error = scriptSyntaxError(text, r.file);
			if (error) report.errors.push({ resource: r.id, message: error });
		}
		if (r.kind === "regex-pattern") {
			report.checkedPatterns.push(r.id);
			try {
				const literal = text.match(/^\/([\s\S]*)\/([dgimsuvy]*)$/);
				new RegExp(literal ? literal[1] : text, literal ? literal[2] : "");
			} catch (error) {
				report.errors.push({ resource: r.id, message: String(error) });
			}
		}
		const parent = valueAt(raw, r.path.slice(0, -1)) as Record<string, unknown>;
		parent[r.path[r.path.length - 1]] = text;
	}
	try { normalizeCard(raw); } catch (error) { report.errors.push({ resource: "card", message: String(error) }); }
	report.hash = cardSourceHash(m.base + "\n" + JSON.stringify(raw));
	return { ...report, raw };
}

/** 回写与快照均使用原格式；外部变更、过期构建和语法错误均不会覆盖原卡。 */
export function applyCardProject(cwd: string, cardPath: string, expectedBuild: string): CardProjectStatus {
	const build = buildCardProject(cwd, cardPath);
	if (!expectedBuild || expectedBuild !== build.hash) throw new Error("创作稿已变化，请重新检查或预览");
	if (build.errors.length) throw new Error("创作稿有错误：" + build.errors.map(e => e.message).join("\n"));
	const root = cardAuthoringDirectory(cwd, cardPath);
	const m = loadManifest(root);
	const previous = readFileSync(cardPath);
	if (cardSourceHash(previous) !== m.base) throw new Error("原卡已被其他操作修改，未覆盖；请保留创作稿并重新同步");
	if (!build.changed.length) return inspectCardProject(cwd, cardPath);
	const { isPng } = loadSnapshot(root, m.base);
	const next = isPng ? writeCardJsonToPng(previous, build.raw) : Buffer.from(JSON.stringify(build.raw, null, "\t") + "\n");
	const hash = saveSnapshot(root, next);
	atomicWrite(cardPath, next);
	try {
		atomicWrite(manifestFile(root), JSON.stringify({ ...m, base: hash, previous: m.base }, null, "\t"));
	} catch (error) {
		atomicWrite(cardPath, previous);
		throw error;
	}
	return inspectCardProject(cwd, cardPath);
}

/** 撤回最后一次应用；源文件继续保留为创作稿，便于修正后重新应用。 */
export function undoCardProject(cwd: string, cardPath: string): CardProjectStatus {
	const root = cardAuthoringDirectory(cwd, cardPath);
	const m = loadManifest(root);
	if (!m.previous) throw new Error("没有可撤回的应用");
	const current = readFileSync(cardPath);
	if (cardSourceHash(current) !== m.base) throw new Error("原卡已变化，不能撤回覆盖");
	const previous = loadSnapshot(root, m.previous);
	atomicWrite(cardPath, previous.bytes);
	try {
		atomicWrite(manifestFile(root), JSON.stringify({ version: 1, original: m.original, base: m.previous } satisfies Manifest, null, "\t"));
	} catch (error) {
		atomicWrite(cardPath, current);
		throw error;
	}
	return inspectCardProject(cwd, cardPath);
}

/** 板块声明：资源键 → 板块。是数据，不是判据；投影时覆盖结构默认值。 */
const sectionsFile = (root: string) => join(root, "sections.json");
function loadSections(root: string): CardSectionDeclarations {
	const file = sectionsFile(root);
	if (!existsSync(file)) return {};
	const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: number; items?: Record<string, unknown> };
	const out: CardSectionDeclarations = {};
	for (const [key, value] of Object.entries(parsed.items ?? {})) if (isCardSectionId(value)) out[key] = value;
	return out;
}

/** 目录：按板块投影当前基线（已展开用快照，否则读原卡）。不改资源身份，不需要先建立工程。 */
export function outlineCardProject(cwd: string, cardPath: string): CardOutline {
	const root = cardAuthoringDirectory(cwd, cardPath);
	const prepared = existsSync(manifestFile(root));
	const { raw } = prepared ? loadSnapshot(root, loadManifest(root).base) : readCardRawJson(cardPath);
	return buildCardOutline(raw, cardResources(raw), prepared ? loadSections(root) : {});
}

/** 把一项归入板块；传空板块＝撤销声明回到默认。声明落在工程目录，需要先展开。 */
export function assignCardSection(cwd: string, cardPath: string, key: string, section: string | null): CardOutline {
	const root = cardAuthoringDirectory(cwd, cardPath);
	if (!existsSync(manifestFile(root))) throw new Error("请先展开创作工程再归位");
	const outline = outlineCardProject(cwd, cardPath);
	const item = outline.sections.flatMap(s => s.items).find(i => i.key === key);
	if (!item) throw new Error("找不到目录项：" + key);
	if (section !== null && !isCardSectionId(section)) throw new Error("未知板块：" + section);
	const items = loadSections(root);
	if (section === null || section === item.defaultSection) delete items[key];
	else items[key] = section;
	atomicWrite(sectionsFile(root), JSON.stringify({ version: 1, items }, null, "\t"));
	return outlineCardProject(cwd, cardPath);
}

export function previewCardProject(cwd: string, cardPath: string, userName: string): CardProjectPreview {
	const { raw, ...build } = buildCardProject(cwd, cardPath);
	const card = normalizeCard(raw);
	const front = buildCardFrontSnapshot({ card: cardPath, userName }, raw, card.name);
	return { build, front, greetings: [card.firstMes, ...card.alternateGreetings],
		variables: findInitVar(card.book) ?? findSchemaDefaults(front.scripts) ?? {} };
}

/** REST 与助手共用操作，避免两套读写语义。源码可直接用原生 read/edit/write 修改。 */
export function cardProjectOperation(cwd: string, cardPath: string, args: Record<string, unknown>): unknown {
	const requiredString = (key: string) => {
		if (typeof args[key] !== "string") throw new Error("缺少参数：" + key);
		return args[key] as string;
	};
	switch (args.action) {
		case "inspect": return inspectCardProject(cwd, cardPath);
		case "outline": {
			const outline = outlineCardProject(cwd, cardPath);
			if (typeof args.section === "string") {
				const section = outline.sections.find(s => s.id === args.section);
				if (!section) throw new Error("未知板块：" + args.section);
				return { ...outline, sections: [section] };
			}
			if (args.full === true) return outline;
			// 默认只给板块概览；E 类卡的条目上百，逐板块再读
			return { ...outline, sections: outline.sections.map(s => ({ id: s.id, label: s.label, size: s.size, count: s.items.length, disabled: s.items.filter(i => !i.enabled).length })) };
		}
		case "assign": return assignCardSection(cwd, cardPath, requiredString("key"), typeof args.section === "string" && args.section ? args.section : null);
		case "prepare": return prepareCardProject(cwd, cardPath);
		case "read": {
			const result = readCardResource(cwd, cardPath, requiredString("resource"));
			if (args.offset === undefined && args.limit === undefined) return result;
			const lines = result.text.split("\n");
			const offset = typeof args.offset === "number" ? Math.max(1, Math.floor(args.offset)) : 1;
			const limit = typeof args.limit === "number" ? Math.max(1, Math.min(2000, Math.floor(args.limit))) : 200;
			return { ...result, text: lines.slice(offset - 1, offset - 1 + limit).join("\n"), offset,
				totalLines: lines.length, nextOffset: offset - 1 + limit < lines.length ? offset + limit : null };
		}
		case "write": return writeCardResource(cwd, cardPath, requiredString("resource"), requiredString("text"), requiredString("version"));
		case "check": {
			const { raw: _raw, ...report } = buildCardProject(cwd, cardPath);
			return report;
		}
		case "apply": return applyCardProject(cwd, cardPath, requiredString("buildHash"));
		case "undo": return undoCardProject(cwd, cardPath);
		default: throw new Error("未知创作操作");
	}
}
