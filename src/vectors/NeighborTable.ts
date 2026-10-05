import type { VectorSearchResult } from "./VectorIndex";

/**
 * Top-K neighbours of every indexed note in a compact, transferable form:
 * row i holds the neighbours of ids[i] as indexes into ids (-1 = empty slot).
 */
export interface NeighborTable {
	ids: string[];
	k: number;
	neighbors: Int32Array;
	scores: Float32Array;
}

export function neighborsOf(t: NeighborTable, row: number): VectorSearchResult[] {
	const out: VectorSearchResult[] = [];
	for (let j = 0; j < t.k; j++) {
		const n = t.neighbors[row * t.k + j];
		if (n < 0) break;
		out.push({ id: t.ids[n], score: t.scores[row * t.k + j] });
	}
	return out;
}

export function toNeighborMap(t: NeighborTable): Map<string, VectorSearchResult[]> {
	const m = new Map<string, VectorSearchResult[]>();
	t.ids.forEach((id, i) => m.set(id, neighborsOf(t, i)));
	return m;
}
