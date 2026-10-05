// Turns raw communities into confident index memberships (spec §42–48).
// All vectors are mean-centred and normalised (same space as the index).
// Pure: no Obsidian imports.
//
//   1. centroid per community
//   2. confidence per member = blend of
//        - closeness to its centroid (as a percentile over all members), and
//        - neighbourhood agreement: share of its kNN that sit in the same community
//   3. low-confidence members → unclassified; communities left too small dissolve
//   4. centroids recomputed from confident ("core") members
//   5. every note scored against every centroid with document and best-chunk
//      similarity: unclassified notes that fit as well as a typical member are
//      rescued; strong secondary fits become extra indexes (multi-index)

export interface ClassifierNote {
	id: string;
	vector: Float32Array;
	/** chunk vectors of long notes (spec §43), with their headings */
	chunks?: { heading?: string; vector: Float32Array }[];
	/** semantic neighbours (ids), best first */
	neighbors: string[];
}

export interface ClassifierOptions {
	minNotes: number;
	maxIndexesPerNote: number;
	/** minimum member confidence (0–1) to stay in an index */
	minConfidence: number;
	/** rescue / secondary need at least this percentile of the index's core-member scores */
	rescuePercentile: number;
	secondaryPercentile: number;
	/** chunk similarity is discounted slightly vs whole-document similarity */
	chunkDiscount: number;
	neighborsForAgreement: number;
}

export const DEFAULT_CLASSIFIER_OPTIONS: ClassifierOptions = {
	minNotes: 3,
	maxIndexesPerNote: 3,
	minConfidence: 0.4,
	rescuePercentile: 0.25,
	secondaryPercentile: 0.1,
	chunkDiscount: 0.95,
	neighborsForAgreement: 10,
};

/** Maps the "Semantic threshold" setting (0–100) to the member confidence cut-off. */
export function confidenceForThreshold(threshold: number): number {
	return +(0.2 + 0.4 * (Math.min(100, Math.max(0, threshold)) / 100)).toFixed(3);
}

export interface Membership {
	index: number;
	score: number;
	primary: boolean;
	via: "community" | "centroid" | "chunk";
	heading?: string;
}

export interface ClassifierResult {
	/** community number per kept index, in output order */
	indexes: number[];
	centroids: Float32Array[];
	/** note id -> memberships (primary first) */
	memberships: Map<string, Membership[]>;
	unclassified: string[];
	dissolved: number;
	/** sorted core-member similarities per index, for percentile scores and later incremental assignment */
	coreScores: number[][];
}

const dot = (a: Float32Array, b: Float32Array) => {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] * b[i];
	return s;
};

function centroidOf(vectors: Float32Array[]): Float32Array {
	const d = vectors[0].length;
	const m = new Float32Array(d);
	for (const v of vectors) for (let i = 0; i < d; i++) m[i] += v[i];
	let n = 0;
	for (const x of m) n += x * x;
	n = Math.sqrt(n) || 1;
	for (let i = 0; i < d; i++) m[i] /= n;
	return m;
}

/** fraction of sorted values below s (binary search) */
export function rankIn(sorted: number[], s: number): number {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (sorted[mid] < s) lo = mid + 1;
		else hi = mid;
	}
	return sorted.length ? lo / sorted.length : 0;
}

const percentile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))] : 0);

export function classify(notes: ClassifierNote[], communities: Map<string, number>, options: Partial<ClassifierOptions> = {}): ClassifierResult {
	const o = { ...DEFAULT_CLASSIFIER_OPTIONS, ...options };
	// 1–2: confidence of every community member
	const groups = new Map<number, ClassifierNote[]>();
	for (const n of notes) {
		const c = communities.get(n.id);
		if (c !== undefined) groups.set(c, [...(groups.get(c) ?? []), n]);
	}
	const first = new Map([...groups].map(([c, ms]) => [c, centroidOf(ms.map((m) => m.vector))]));
	const raw = notes.filter((n) => communities.has(n.id)).map((n) => ({ n, c: communities.get(n.id)!, s: dot(n.vector, first.get(communities.get(n.id)!)!) }));
	const sortedScores = raw.map((r) => r.s).sort((a, b) => a - b);
	const rankOf = (s: number) => rankIn(sortedScores, s);
	const confidence = new Map<string, number>();
	for (const { n, c, s } of raw) {
		const near = n.neighbors.filter((id) => communities.has(id)).slice(0, o.neighborsForAgreement);
		const agree = near.length ? near.filter((id) => communities.get(id) === c).length / near.length : 0;
		confidence.set(n.id, 0.5 * rankOf(s) + 0.5 * agree);
	}

	// 3: keep confident members, dissolve communities that end up too small
	const core = new Map<number, ClassifierNote[]>();
	for (const [c, ms] of groups) core.set(c, ms.filter((m) => confidence.get(m.id)! >= o.minConfidence));
	let dissolved = 0;
	const kept = [...core].filter(([, ms]) => {
		if (ms.length >= o.minNotes) return true;
		dissolved++;
		return false;
	});
	kept.sort((a, b) => b[1].length - a[1].length);

	// 4: centroids from core members only
	const indexes = kept.map(([c]) => c);
	const centroids = kept.map(([, ms]) => centroidOf(ms.map((m) => m.vector)));
	const coreScores = kept.map(([, ms], k) => ms.map((m) => dot(m.vector, centroids[k])).sort((a, b) => a - b));
	const thresholds = coreScores.map((s) => ({ rescue: percentile(s, o.rescuePercentile), secondary: percentile(s, o.secondaryPercentile) }));
	/** "fits better than this share of the index's own core members" */
	const fitPercentile = (k: number, s: number) => rankIn(coreScores[k], s);
	const coreIndexOf = new Map<string, number>();
	kept.forEach(([, ms], k) => ms.forEach((m) => coreIndexOf.set(m.id, k)));

	// 5: score every note against every centroid (document + best chunk)
	const memberships = new Map<string, Membership[]>();
	const unclassified: string[] = [];
	for (const n of notes) {
		const fits: Membership[] = centroids.map((cv, k) => {
			const doc = dot(n.vector, cv);
			let best = doc;
			let via: Membership["via"] = "centroid";
			let heading: string | undefined;
			for (const ch of n.chunks ?? []) {
				const s = o.chunkDiscount * dot(ch.vector, cv);
				if (s > best) {
					best = s;
					via = "chunk";
					heading = ch.heading;
				}
			}
			return { index: k, score: best, primary: false, via, heading };
		});
		const out: Membership[] = [];
		const home = coreIndexOf.get(n.id);
		if (home !== undefined) {
			out.push({ index: home, score: confidence.get(n.id)!, primary: true, via: "community" });
		} else {
			// rescue: fits some index as well as its typical core member
			const rescue = fits.filter((f) => f.score >= thresholds[f.index].rescue).sort((a, b) => b.score - a.score)[0];
			if (rescue) out.push({ ...rescue, primary: true, score: fitPercentile(rescue.index, rescue.score) });
		}
		if (!out.length) {
			unclassified.push(n.id);
			continue;
		}
		const secondary = fits
			.filter((f) => f.index !== out[0].index && f.score >= thresholds[f.index].secondary)
			.sort((a, b) => b.score - a.score)
			.slice(0, o.maxIndexesPerNote - 1)
			.map((f) => ({ ...f, score: fitPercentile(f.index, f.score) }));
		memberships.set(n.id, [...out, ...secondary]);
	}
	return { indexes, centroids, memberships, unclassified, dissolved, coreScores };
}
