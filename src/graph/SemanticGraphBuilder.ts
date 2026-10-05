import Graph from "graphology";
import { timeSlicer } from "../core/yieldToUi";
import type { NeighborTable } from "../vectors/NeighborTable";
import type { VectorSearchResult } from "../vectors/VectorIndex";
import { HybridEdgeScorer, type EdgeWeights, type NoteFeatures } from "./HybridEdgeScorer";

export type SemanticGraph = Graph<Record<string, never>, { weight: number; similarity: number }>;

export interface GraphBuildOptions {
	/**
	 * multilingual-e5 similarities are compressed (unrelated texts still score
	 * ~0.75–0.8), so raw cosine is a poor edge weight. With rescale=true the
	 * weight is (sim - floor) / (1 - floor), floor = lowest kNN similarity seen.
	 */
	rescale: boolean;
}

/** Builds a sparse undirected graph from per-node top-K neighbour lists (semantic only). */
export async function buildSemanticGraph(
	neighbours: Map<string, VectorSearchResult[]>,
	opts: GraphBuildOptions = { rescale: true },
): Promise<SemanticGraph> {
	const graph: SemanticGraph = new Graph({ type: "undirected", multi: false, allowSelfLoops: false });
	for (const id of neighbours.keys()) graph.addNode(id);

	let floor = 1;
	if (opts.rescale) for (const list of neighbours.values()) for (const n of list) floor = Math.min(floor, n.score);
	const weightOf = (sim: number) => (opts.rescale ? Math.max(1e-6, (sim - floor) / (1 - floor)) : sim);

	const maybeYield = timeSlicer();
	for (const [id, list] of neighbours) {
		await maybeYield();
		for (const n of list) {
			if (n.id === id || !graph.hasNode(n.id)) continue;
			if (graph.hasEdge(id, n.id)) continue; // symmetric similarity: same weight both ways
			graph.addEdge(id, n.id, { similarity: n.score, weight: weightOf(n.score) });
		}
	}
	return graph;
}

export interface HybridGraphInput {
	table: NeighborTable;
	/** rows of table.ids that take part (e.g. notes with enough own text) */
	include: boolean[];
	features: NoteFeatures[];
	weights: EdgeWeights;
	/** cosine similarity between two rows, for link-only pairs outside the kNN lists */
	similarity: (i: number, j: number) => number;
}

export interface HybridGraphStats {
	nodes: number;
	edges: number;
	knnEdges: number;
	linkOnlyEdges: number;
	semanticP5: number;
	semanticP95: number;
}

const quantile = (sorted: Float32Array, q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);

/**
 * Sparse hybrid graph (spec §34–37): nodes = included notes, edges = top-K
 * semantic neighbours plus pairs the user already linked. Semantic similarity
 * is normalised to [0, 1] between the 5th and 95th percentile of kNN scores,
 * then combined with structural signals by HybridEdgeScorer.
 */
export function buildHybridGraph(input: HybridGraphInput): { graph: SemanticGraph; stats: HybridGraphStats } {
	const { table, include, features, weights } = input;
	const scorer = new HybridEdgeScorer(features, weights);
	const graph: SemanticGraph = new Graph({ type: "undirected", multi: false, allowSelfLoops: false });
	table.ids.forEach((id, i) => include[i] && graph.addNode(id));

	const sims: number[] = [];
	for (let i = 0; i < table.ids.length; i++) {
		if (!include[i]) continue;
		for (let j = 0; j < table.k; j++) {
			const n = table.neighbors[i * table.k + j];
			if (n >= 0 && include[n]) sims.push(table.scores[i * table.k + j]);
		}
	}
	const sorted = Float32Array.from(sims).sort();
	const p5 = quantile(sorted, 0.05);
	const p95 = quantile(sorted, 0.95);
	const norm = (s: number) => Math.min(1, Math.max(0, (s - p5) / Math.max(1e-6, p95 - p5)));

	let knnEdges = 0;
	for (let i = 0; i < table.ids.length; i++) {
		if (!include[i]) continue;
		for (let j = 0; j < table.k; j++) {
			const n = table.neighbors[i * table.k + j];
			if (n < 0 || !include[n] || n === i) continue;
			const a = table.ids[i];
			const b = table.ids[n];
			if (graph.hasEdge(a, b)) continue;
			const sim = table.scores[i * table.k + j];
			graph.addEdge(a, b, { similarity: sim, weight: Math.max(1e-6, scorer.score(i, n, norm(sim))) });
			knnEdges++;
		}
	}
	let linkOnlyEdges = 0;
	if (weights.links > 0) {
		for (const [i, j] of scorer.linkPairs()) {
			if (!include[i] || !include[j]) continue;
			const a = table.ids[i];
			const b = table.ids[j];
			if (graph.hasEdge(a, b)) continue;
			const sim = input.similarity(i, j);
			graph.addEdge(a, b, { similarity: sim, weight: Math.max(1e-6, scorer.score(i, j, norm(sim))) });
			linkOnlyEdges++;
		}
	}
	return { graph, stats: { nodes: graph.order, edges: graph.size, knnEdges, linkOnlyEdges, semanticP5: p5, semanticP95: p95 } };
}
