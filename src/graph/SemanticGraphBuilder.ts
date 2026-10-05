import Graph from "graphology";
import { timeSlicer } from "../core/yieldToUi";
import type { VectorSearchResult } from "../vectors/VectorIndex";

export type SemanticGraph = Graph<Record<string, never>, { weight: number; similarity: number }>;

export interface GraphBuildOptions {
	/**
	 * multilingual-e5 similarities are compressed (unrelated texts still score
	 * ~0.75–0.8), so raw cosine is a poor edge weight. With rescale=true the
	 * weight is (sim - floor) / (1 - floor), floor = lowest kNN similarity seen.
	 */
	rescale: boolean;
}

/** Builds a sparse undirected graph from per-node top-K neighbour lists. */
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
