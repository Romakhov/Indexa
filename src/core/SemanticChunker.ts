// Splits long notes into semantic chunks along their Markdown structure
// (spec §17–23). Pure: no Obsidian imports.
//
//   heading sections → too long: split by paragraph, then sentence, then hard cut
//                    → too short: merge with a neighbour
//                    → too many: merge the smallest adjacent pair until ≤ max
//
// Sizes are in characters. multilingual-e5 reads at most 512 tokens; RU/EN
// text averages ~3.5–4.5 chars per token, so 1500 chars stays inside the window.

import type { NoteDocument } from "../types/NoteDocument";
import { cleanMarkdown } from "./MarkdownProcessor";
import { TemplateLines } from "./TemplateDetector";

export interface ChunkerOptions {
	/** notes whose cleaned body is at most this long get no chunks (document vector only) */
	minNoteChars: number;
	maxChunkChars: number;
	minChunkChars: number;
	maxChunksPerNote: number;
}

export const DEFAULT_CHUNKER_OPTIONS: ChunkerOptions = {
	minNoteChars: 1500,
	maxChunkChars: 1500,
	minChunkChars: 300,
	maxChunksPerNote: 20,
};

export interface Chunk {
	/** "H1 › H2" path of the first section in the chunk; undefined before the first heading */
	heading?: string;
	/** character offsets of the chunk's source in NoteDocument.content */
	start: number;
	end: number;
	/** cleaned chunk body */
	content: string;
	/** text sent to the model: document + section context + body (spec §20) */
	text: string;
}

interface Piece {
	heading?: string;
	start: number;
	end: number;
	lines: string[];
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^(```|~~~)/;

const size = (p: Piece) => p.lines.reduce((n, l) => n + l.length + 1, 0);

/** Raw sections between headings (fenced code is never treated as a heading). */
function sections(content: string): { heading?: string; start: number; end: number; raw: string }[] {
	const fm = content.match(FRONTMATTER);
	let offset = fm ? fm[0].length : 0;
	const out: { heading?: string; start: number; end: number; raw: string }[] = [];
	const path: string[] = [];
	let cur = { heading: undefined as string | undefined, start: offset, raw: [] as string[] };
	let fence: string | null = null;

	for (const line of content.slice(offset).split("\n")) {
		const f = line.match(FENCE);
		if (f) fence = fence === null ? f[1] : fence === f[1] ? null : fence;
		const h = fence === null && !f ? line.match(HEADING) : null;
		if (h) {
			out.push({ heading: cur.heading, start: cur.start, end: offset, raw: cur.raw.join("\n") });
			const level = h[1].length;
			path.length = level - 1;
			path[level - 1] = h[2].trim();
			cur = { heading: path.filter(Boolean).join(" › "), start: offset, raw: [] };
		} else cur.raw.push(line);
		offset += line.length + 1;
	}
	out.push({ heading: cur.heading, start: cur.start, end: Math.min(offset, content.length), raw: cur.raw.join("\n") });
	return out;
}

function splitLong(p: Piece, max: number): Piece[] {
	// break overlong lines into sentences, then hard-cut
	const units: string[] = [];
	for (const line of p.lines) {
		if (line.length <= max) {
			units.push(line);
			continue;
		}
		let buf = "";
		for (const s of line.split(/(?<=[.!?…])\s+/)) {
			if (buf && buf.length + s.length + 1 > max) {
				units.push(buf);
				buf = "";
			}
			buf = buf ? `${buf} ${s}` : s;
			while (buf.length > max) {
				units.push(buf.slice(0, max));
				buf = buf.slice(max);
			}
		}
		if (buf) units.push(buf);
	}
	// pack units greedily
	const out: Piece[] = [];
	let cur: string[] = [];
	let n = 0;
	for (const u of units) {
		if (cur.length && n + u.length + 1 > max) {
			out.push({ ...p, lines: cur });
			cur = [];
			n = 0;
		}
		cur.push(u);
		n += u.length + 1;
	}
	if (cur.length) out.push({ ...p, lines: cur });
	return out;
}

const merge = (a: Piece, b: Piece): Piece => ({
	heading: a.heading ?? b.heading,
	start: Math.min(a.start, b.start),
	end: Math.max(a.end, b.end),
	lines: [...a.lines, ...b.lines],
});

export function chunkNote(
	doc: Pick<NoteDocument, "content" | "title">,
	templates: TemplateLines = TemplateLines.empty(),
	options: Partial<ChunkerOptions> = {},
): Chunk[] {
	const o = { ...DEFAULT_CHUNKER_OPTIONS, ...options };
	let pieces: Piece[] = sections(doc.content)
		.map((s) => ({
			heading: s.heading,
			start: s.start,
			end: s.end,
			lines: cleanMarkdown(s.raw).filter((l) => !templates.has(l)),
		}))
		.filter((p) => p.lines.length > 0);

	const total = pieces.reduce((n, p) => n + size(p), 0);
	if (total <= o.minNoteChars) return [];

	pieces = pieces.flatMap((p) => (size(p) > o.maxChunkChars ? splitLong(p, o.maxChunkChars) : [p]));

	// merge too-short pieces into a neighbour while the result still fits
	for (let i = 0; i < pieces.length; ) {
		if (pieces.length > 1 && size(pieces[i]) < o.minChunkChars) {
			const next = pieces[i + 1];
			const prev = pieces[i - 1];
			if (next && size(pieces[i]) + size(next) <= o.maxChunkChars) {
				pieces.splice(i, 2, merge(pieces[i], next));
				continue;
			}
			if (prev && size(prev) + size(pieces[i]) <= o.maxChunkChars) {
				pieces.splice(i - 1, 2, merge(prev, pieces[i]));
				i = Math.max(0, i - 1);
				continue;
			}
		}
		i++;
	}

	// chunk explosion guard (spec §23): merge the smallest adjacent pair
	while (pieces.length > o.maxChunksPerNote) {
		let best = 0;
		for (let i = 1; i < pieces.length - 1; i++) if (size(pieces[i]) + size(pieces[i + 1]) < size(pieces[best]) + size(pieces[best + 1])) best = i;
		pieces.splice(best, 2, merge(pieces[best], pieces[best + 1]));
	}

	return pieces.map((p) => {
		const content = p.lines.join("\n");
		const context = [`Document: ${doc.title}`, p.heading ? `Section: ${p.heading}` : null].filter(Boolean).join("\n");
		return { heading: p.heading, start: p.start, end: p.end, content, text: `${context}\n\n${content}` };
	});
}
