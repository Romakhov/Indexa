import type { KeywordExtractor } from "../keywords/KeywordExtractor";
import type { NoteDocument } from "../types/NoteDocument";
import type { NoteFeatures } from "./HybridEdgeScorer";

/**
 * Structural features for every row of a neighbour table (rows = note ids).
 * Links are resolved to rows; links to notes outside the analysis are dropped.
 */
export function buildNoteFeatures(rowIds: string[], notes: NoteDocument[], keywords: KeywordExtractor, keywordsPerNote = 10): NoteFeatures[] {
	const byId = new Map(notes.map((n) => [n.id, n]));
	const rowOfPath = new Map<string, number>();
	rowIds.forEach((id, row) => {
		const n = byId.get(id);
		if (n) rowOfPath.set(n.path, row);
	});
	return rowIds.map((id) => {
		const n = byId.get(id);
		if (!n) return { links: [], tags: [], keywords: [], folder: "" };
		const links = [...new Set(n.links.map((p) => rowOfPath.get(p)).filter((r): r is number => r !== undefined))];
		return {
			links,
			tags: n.tags.map((t) => t.toLowerCase()),
			keywords: keywords.noteKeywords(n.id, keywordsPerNote),
			folder: n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "",
		};
	});
}
