// Dev benchmark (spec §40, §74): graph + Louvain variants vs a density-based
// method (UMAP + HDBSCAN), scored against known labels. umap-js and
// hdbscan-ts are dev dependencies; they are bundled only into dev builds.

import { HDBSCAN } from "hdbscan-ts";
import { UMAP } from "umap-js";
import type { ClusterResult } from "../clustering/ClusterEngine";
import { refineCommunities } from "../clustering/ClusterRefinement";
import { CommunityClusterEngine, seededRandom } from "../clustering/CommunityClusterEngine";
import { buildNoteFeatures } from "../graph/features";
import { DEFAULT_EDGE_WEIGHTS, SEMANTIC_ONLY, type EdgeWeights } from "../graph/HybridEdgeScorer";
import { buildHybridGraph } from "../graph/SemanticGraphBuilder";
import { KeywordExtractor } from "../keywords/KeywordExtractor";
import { nmi, purity } from "../spike/metrics";
import type { NoteDocument, ProcessedNote } from "../types/NoteDocument";
import type { NeighborTable } from "../vectors/NeighborTable";

export interface BenchmarkInput {
	notes: NoteDocument[];
	processed: ProcessedNote[];
	table: NeighborTable;
	/** centred, normalised vectors by note id */
	vectors: Map<string, Float32Array>;
	/** known label per note id (missing = unlabeled) */
	labels: Map<string, string>;
}

interface Scored {
	variant: string;
	clusters: number;
	clustersAtLeast3: number;
	largestShare: number;
	noiseShare: number;
	/** noise counted as one extra cluster (penalises leaving notes unassigned) */
	nmi: number;
	/** clustered notes only (what the assigned part looks like) */
	nmiClustered: number;
	purity: number;
	ms: number;
}

function score(variant: string, rowIds: string[], assign: number[], input: BenchmarkInput, ms: number): Scored {
	const labeled = rowIds.map((id, i) => [input.labels.get(id), assign[i]] as const).filter(([l]) => l !== undefined);
	const gold = labeled.map(([l]) => l!);
	const pred = labeled.map(([, c]) => c);
	const clustered = labeled.filter(([, c]) => c >= 0);
	const sizes = assign.filter((c) => c >= 0).reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map<number, number>());
	const sorted = [...sizes.values()].sort((a, b) => b - a);
	return {
		variant,
		clusters: sizes.size,
		clustersAtLeast3: sorted.filter((s) => s >= 3).length,
		largestShare: +((sorted[0] ?? 0) / assign.length).toFixed(3),
		noiseShare: +(assign.filter((c) => c < 0).length / assign.length).toFixed(3),
		nmi: +nmi(gold, pred).toFixed(3),
		nmiClustered: clustered.length ? +nmi(clustered.map(([l]) => l!), clustered.map(([, c]) => c)).toFixed(3) : 0,
		purity: +purity(gold, pred).toFixed(3),
		ms: Math.round(ms),
	};
}

const dot = (a: Float32Array, b: Float32Array) => {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] * b[i];
	return s;
};

export async function clusteringBenchmark(input: BenchmarkInput, resolutions = [1, 2, 3, 4, 6]) {
	const content = new Set(input.processed.filter((p) => !p.lowContent).map((p) => p.noteId));
	const { table } = input;
	const include = table.ids.map((id) => content.has(id));
	const rows = table.ids.map((_, i) => i).filter((i) => include[i]);
	const rowIds = rows.map((i) => table.ids[i]);
	const keywords = new KeywordExtractor(input.processed.filter((p) => content.has(p.noteId)).map((p) => ({ id: p.noteId, text: p.text })));
	const features = buildNoteFeatures(table.ids, input.notes, keywords);
	const sim = (i: number, j: number) => dot(input.vectors.get(table.ids[i])!, input.vectors.get(table.ids[j])!);
	const engine = new CommunityClusterEngine();
	const results: Scored[] = [];
	const graphStats: Record<string, unknown> = {};

	const louvain = async (name: string, weights: EdgeWeights, refine: number | null) => {
		const { graph, stats } = buildHybridGraph({ table, include, features, weights, similarity: sim });
		graphStats[name] = stats;
		for (const resolution of resolutions) {
			const t0 = performance.now();
			let res: ClusterResult = await engine.cluster(graph, { resolution, seed: 1 });
			if (refine !== null) res = await refineCommunities(graph, res, engine, { resolution, seed: 1 }, { maxShare: refine, minSizeToSplit: 10, maxDepth: 3 });
			results.push(score(`${name} r=${resolution}`, rowIds, rowIds.map((id) => res.communities.get(id)!), input, performance.now() - t0));
		}
	};
	await louvain("louvain-semantic", SEMANTIC_ONLY, null);
	await louvain("louvain-hybrid", DEFAULT_EDGE_WEIGHTS, null);
	await louvain("louvain-hybrid+refine", DEFAULT_EDGE_WEIGHTS, 0.08);

	// stability of the hybrid graph across seeds
	const { graph } = buildHybridGraph({ table, include, features, weights: DEFAULT_EDGE_WEIGHTS, similarity: sim });
	const seeds = await Promise.all([1, 2, 3].map((seed) => engine.cluster(graph, { resolution: 3, seed })));
	const part = (r: ClusterResult) => rowIds.map((id) => r.communities.get(id)!);
	const seedStabilityNmi = +((nmi(part(seeds[0]), part(seeds[1])) + nmi(part(seeds[0]), part(seeds[2]))) / 2).toFixed(3);

	// density-based alternative: UMAP to 10-d, then HDBSCAN (the BERTopic recipe)
	const data = rowIds.map((id) => Array.from(input.vectors.get(id)!));
	const t0 = performance.now();
	const umap = new UMAP({ nComponents: 10, nNeighbors: 15, minDist: 0, random: seededRandom(42) });
	const reduced = umap.fit(data);
	const umapMs = performance.now() - t0;
	for (const minClusterSize of [3, 5, 10]) {
		const t1 = performance.now();
		const h = new HDBSCAN({ minClusterSize, minSamples: Math.min(minClusterSize, 5) });
		h.fit(reduced);
		results.push(score(`umap+hdbscan mcs=${minClusterSize}`, rowIds, h.labels_, input, umapMs + performance.now() - t1));
	}
	const t2 = performance.now();
	const raw = new HDBSCAN({ minClusterSize: 5, minSamples: 5 });
	raw.fit(data);
	results.push(score("hdbscan raw-384d mcs=5", rowIds, raw.labels_, input, performance.now() - t2));

	return {
		notes: rowIds.length,
		labeled: rowIds.filter((id) => input.labels.has(id)).length,
		distinctLabels: new Set(rowIds.map((id) => input.labels.get(id)).filter(Boolean)).size,
		graphStats,
		seedStabilityNmi,
		results,
	};
}
