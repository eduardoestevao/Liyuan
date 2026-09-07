/** Deterministic projection only. Never mutates pi's canonical messages or user decisions. */
export function projectToolContext(messages: unknown[]): {
	messages: unknown[];
	stats: { messages: number; chars: number; toolChars: number; prunedChars: number; prunedResults: number };
} {
	const seen = new Set<string>();
	const latestDraft = new Map<string, number>();
	let prunedChars = 0, prunedResults = 0, toolChars = 0;
	const out = messages.slice();
	const eligible = new Set(["draft_read", "draft_search", "lorebook_read", "lorebook_search", "memory_read", "memory_search", "skill_read", "world_state_get"]);
	for (let i = out.length - 1; i >= 0; i--) {
		const m = out[i] as { role?: string; toolName?: string; content?: unknown; details?: { version?: number; draftId?: string }; isError?: boolean };
		if (m?.role !== "toolResult" || !eligible.has(m.toolName ?? "") || m.isError || !Array.isArray(m.content)) continue;
		const text = m.content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
		const key = `${m.toolName}\0${text}`;
		const id = m.details?.draftId;
		const version = m.details?.version;
		const outdated = !!id && typeof version === "number" && (latestDraft.get(id) ?? version) > version;
		if (id && typeof version === "number") latestDraft.set(id, Math.max(latestDraft.get(id) ?? 0, version));
		const duplicate = seen.has(key);
		seen.add(key);
		if (duplicate || outdated) {
			const receipt = outdated ? `较早的稿件读取结果 v${version}；后续结果已包含更新版本。` : `与后续 ${m.toolName} 结果相同。`;
			if (receipt.length < text.length) {
				out[i] = { ...m, content: [{ type: "text", text: receipt }] };
				prunedChars += text.length - receipt.length; prunedResults++;
				toolChars += receipt.length;
				continue;
			}
		}
		toolChars += text.length;
	}
	return { messages: out, stats: { messages: out.length, chars: JSON.stringify(out).length, toolChars, prunedChars, prunedResults } };
}
