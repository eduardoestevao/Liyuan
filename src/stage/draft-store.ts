/** A beat owns one atomic document. Revisions and the current text commit together. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TurnWorkspace } from "./workspace.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const component = (s: string) => {
	if (!/^[a-zA-Z0-9_-]+$/.test(s)) throw new Error("Invalid draft identity");
	return s;
};

export function draftDirectory(cwd: string, sessionDir: string | undefined, sessionId: string): string {
	// New card chats and legacy sessions both retain their own scope.
	return join(sessionDir ? dirname(sessionDir) : join(cwd, ".liyuan"), "稿件", component(sessionId));
}

export class DraftStore {
	readonly file: string;
	#digest: string | undefined;
	constructor(directory: string, id: string) {
		this.file = join(directory, `${component(id)}.json`);
	}
	read(): TurnWorkspace | undefined {
		if (!existsSync(this.file)) return undefined;
		const raw = readFileSync(this.file, "utf8");
		const data = JSON.parse(raw);
		if (data.schema !== 1 || !data.workspace || typeof data.workspace.draft !== "string") throw new Error("稿件文件无效");
		this.#digest = hash(raw);
		return data.workspace;
	}
	write(ws: TurnWorkspace): void {
		const current = existsSync(this.file) ? hash(readFileSync(this.file, "utf8")) : undefined;
		if (current !== this.#digest) throw new Error("稿件文件已被另一操作修改；请重新读取当前稿件。");
		mkdirSync(dirname(this.file), { recursive: true });
		const raw = JSON.stringify({ schema: 1, workspace: ws }, null, 2) + "\n";
		const temporary = `${this.file}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, raw, { encoding: "utf8", flag: "wx" });
			renameSync(temporary, this.file);
			this.#digest = hash(raw);
		} finally {
			if (existsSync(temporary)) unlinkSync(temporary);
		}
	}
}

export function listDrafts(directory: string): TurnWorkspace[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory).filter((f) => /^[a-zA-Z0-9_-]+\.json$/.test(f)).flatMap((file) => {
		try { return new DraftStore(directory, file.slice(0, -5)).read() ?? []; } catch { return []; }
	}).sort((a, b) => b.updatedAt - a.updatedAt);
}
