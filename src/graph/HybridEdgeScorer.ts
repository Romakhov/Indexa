// Hybrid edge score (spec §35–37): semantic similarity is the main signal,
// the user's own structure (links, tags, folders) and shared keywords adjust it.
// Weights are configuration, not product constants. Pure.

export interface EdgeWeights {
	semantic: number;
	links: number;
	tags: number;
	keywords: number;
	folder: number;
}

export const DEFAULT_EDGE_WEIGHTS: EdgeWeights = { semantic: 0.7, links: 0.15, tags: 0.08, keywords: 0.05, folder: 0.02 };
export const SEMANTIC_ONLY: EdgeWeights = { semantic: 1, links: 0, tags: 0, keywords: 0, folder: 0 };

/** Per-note structural features, aligned by row with the neighbour table ids. */
export interface NoteFeatures {
	/** rows this note links to (resolved wikilinks, either direction is enough) */
	links: number[];
	tags: string[];
	keywords: string[];
	folder: string;
}

const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
	if (!a.size || !b.size) return 0;
	let inter = 0;
	for (const x of a) if (b.has(x)) inter++;
	return inter / (a.size + b.size - inter);
};

export class HybridEdgeScorer {
	private readonly tagSets: Set<string>[];
	private readonly keywordSets: Set<string>[];
	private readonly linked = new Set<string>();

	constructor(
		private readonly features: NoteFeatures[],
		private readonly weights: EdgeWeights = DEFAULT_EDGE_WEIGHTS,
	) {
		this.tagSets = features.map((f) => new Set(f.tags));
		this.keywordSets = features.map((f) => new Set(f.keywords));
		// self-links (a note linking to itself) carry no pairwise signal
		features.forEach((f, i) => f.links.forEach((j) => i !== j && this.linked.add(pairKey(i, j))));
	}

	/** Undirected pairs (i < j) connected by an existing wikilink in either direction. */
	linkPairs(): [number, number][] {
		return [...this.linked].map((k) => k.split(":").map(Number) as [number, number]);
	}

	isLinked(i: number, j: number) {
		return this.linked.has(pairKey(i, j));
	}

	/** @param semantic normalised semantic similarity in [0, 1] */
	score(i: number, j: number, semantic: number): number {
		const w = this.weights;
		const fi = this.features[i];
		const fj = this.features[j];
		return (
			w.semantic * semantic +
			(w.links ? w.links * (this.isLinked(i, j) ? 1 : 0) : 0) +
			(w.tags ? w.tags * jaccard(this.tagSets[i], this.tagSets[j]) : 0) +
			(w.keywords ? w.keywords * jaccard(this.keywordSets[i], this.keywordSets[j]) : 0) +
			(w.folder ? w.folder * (fi.folder === fj.folder ? 1 : 0) : 0)
		);
	}
}

const pairKey = (i: number, j: number) => (i < j ? `${i}:${j}` : `${j}:${i}`);
