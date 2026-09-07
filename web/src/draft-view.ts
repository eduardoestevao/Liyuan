import type { DraftView } from "./wire.ts";
import type { TurnSegment } from "./timeline.ts";

/** The server's canonical timeline plus a replaceable, uncommitted stream preview. */
export function workspaceSegments(ws: DraftView): TurnSegment[] {
	const segs = structuredClone(ws.timeline) as TurnSegment[];
	const preview = ws.preview;
	if (!preview || preview.version !== ws.version || !preview.content) return segs;
	if (preview.name === "draft_append") return [...segs, { kind: "text", draft: true, text: (ws.draft ? preview.separator ?? "\n\n" : "") + preview.content }];
	const first = segs.findIndex((s) => s.kind === "text" && (s.draft || preview.name === "direct"));
	const kept = segs.filter((s) => !(s.kind === "text" && (s.draft || preview.name === "direct")));
	kept.splice(first < 0 ? kept.length : first, 0, { kind: "text", draft: true, text: preview.content });
	return kept;
}
