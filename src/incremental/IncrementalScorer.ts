// Scores one new or changed note against the current indexes (spec §44, §60–61)
// without re-analysing the vault. Index centres come from the *effective*
// indexes (after the user's review decisions). Pure: no Obsidian imports.

import { rankIn } from "../indexing/IndexClassifier";

export interface ScorableIndex {
	id: string;
	kind: "topic" | "collection";
	signature?: string;
	/** primary member note ids */
	memberIds: string[];
}

export interface IndexSuggestion {
	indexId: string;
	/** "fits better than this share of the index's own members" (0–1) */
	score: number;
	via: "document" | "chunk" | "collection";
	heading?: string;
}

const dot = (a: Float32Array, b: Float32Array) => {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] * b[i];
	return s;
};

function normalized(v: Float32Array): Float32Array {
	const n = Math.hypot(...v) || 1;
	return v.map((x) => x / n);
}

interface Centre {
	vector: Float32Array;
	/** sorted member similarities to the centre */
	memberScores: number[];
}

/** Collection signatures as written by CollectionDetector ("type: фильм", "#tag", "folder: X"). */
export function matchesSignature(signature: string, note: { path: string; tags: string[]; frontmatter: Record<string, unknown> }): boolean {
	if (signature.startsWith("type: ")) {
		const t = note.frontmatter["type"];
		return typeof t === "string" && t.trim().toLowerCase() === signature.slice(6);
	}
	if (signature.startsWith("#")) return note.tags.some((t) => t.toLowerCase() === signature.slice(1));
	if (signature.startsWith("folder: ")) return note.path.slice(0, note.path.lastIndexOf("/")) === signature.slice(8);
	return false;
}

export class IncrementalScorer {
	private centres = new Map<string, Centre>();

	/**
	 * @param vectorOf centred document vector of a note (undefined if unknown)
	 * @param minMembers indexes with fewer known member vectors are not scored
	 */
	constructor(
		private readonly indexes: ScorableIndex[],
		vectorOf: (noteId: string) => Float32Array | undefined,
		minMembers = 2,
	) {
		for (const ix of indexes) {
			if (ix.kind !== "topic") continue;
			const vs = ix.memberIds.map(vectorOf).filter((v): v is Float32Array => !!v);
			if (vs.length < minMembers) continue;
			const c = new Float32Array(vs[0].length);
			for (const v of vs) for (let i = 0; i < c.length; i++) c[i] += v[i];
			const vector = normalized(c);
			this.centres.set(ix.id, { vector, memberScores: vs.map((v) => dot(v, vector)).sort((a, b) => a - b) });
		}
	}

	get scoredIndexes() {
		return this.centres.size;
	}

	/**
	 * Suggestions for one note, best first. A topic is suggested when the note
	 * fits at least as well as the weakest `minPercentile` share of its members;
	 * a long note may qualify through its best section (chunk).
	 */
	suggest(
		note: { vector: Float32Array; chunks?: { heading?: string; vector: Float32Array }[]; path: string; tags: string[]; frontmatter: Record<string, unknown>; lowContent: boolean },
		opts: { max: number; minPercentile: number; chunkDiscount?: number },
	): IndexSuggestion[] {
		const out: IndexSuggestion[] = [];
		for (const ix of this.indexes) {
			if (ix.kind === "collection" && ix.signature && matchesSignature(ix.signature, note)) out.push({ indexId: ix.id, score: 1, via: "collection" });
		}
		if (!note.lowContent) {
			const discount = opts.chunkDiscount ?? 0.95;
			for (const [id, c] of this.centres) {
				let best = dot(note.vector, c.vector);
				let via: IndexSuggestion["via"] = "document";
				let heading: string | undefined;
				for (const ch of note.chunks ?? []) {
					const s = discount * dot(ch.vector, c.vector);
					if (s > best) {
						best = s;
						via = "chunk";
						heading = ch.heading;
					}
				}
				const score = rankIn(c.memberScores, best);
				if (score >= opts.minPercentile) out.push({ indexId: id, score: +score.toFixed(3), via, heading });
			}
		}
		return out.sort((a, b) => b.score - a.score).slice(0, opts.max);
	}
}

/** Did the meaning of a note change enough to re-evaluate its indexes (spec §62)? */
export function significantChange(before: Float32Array | undefined, after: Float32Array, threshold = 0.97): boolean {
	if (!before) return true;
	return dot(normalized(before), normalized(after)) < threshold;
}
