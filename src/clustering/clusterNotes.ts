// Production clustering path (spec §38–46): sparse hybrid kNN graph →
// Louvain → recursive refinement of too-broad communities. Pure; runs in the
// analysis worker. Benchmarked against UMAP + HDBSCAN in Phase 4 (see README).

import type { EdgeWeights, NoteFeatures } from "../graph/HybridEdgeScorer";
import { buildHybridGraph, type HybridGraphStats } from "../graph/SemanticGraphBuilder";
import type { NeighborTable } from "../vectors/NeighborTable";
import { refineCommunities } from "./ClusterRefinement";
import { CommunityClusterEngine } from "./CommunityClusterEngine";

export interface ClusterNotesOptions {
	weights: EdgeWeights;
	resolution: number;
	seed: number;
	/** refine communities larger than this share of the included notes; null = off */
	refineMaxShare: number | null;
}

export interface ClusterNotesResult {
	/** community per table row; -1 for rows that were not included */
	community: Int32Array;
	count: number;
	modularity: number;
	refinedSplits: number;
	graph: HybridGraphStats;
	ms: number;
}

/** Maps the user-facing "level of detail" (1–10) to a Louvain resolution. */
export function resolutionForDetail(detail: number): number {
	return +(3 * Math.pow(1.3, detail - 5)).toFixed(3);
}

export async function clusterNotes(
	table: NeighborTable,
	include: boolean[],
	features: NoteFeatures[],
	similarity: (i: number, j: number) => number,
	opts: ClusterNotesOptions,
): Promise<ClusterNotesResult> {
	const t0 = performance.now();
	const { graph, stats } = buildHybridGraph({ table, include, features, weights: opts.weights, similarity });
	const engine = new CommunityClusterEngine();
	let res = await engine.cluster(graph, { resolution: opts.resolution, seed: opts.seed });
	let refinedSplits = 0;
	if (opts.refineMaxShare !== null) {
		const refined = await refineCommunities(graph, res, engine, { resolution: opts.resolution, seed: opts.seed }, { maxShare: opts.refineMaxShare, minSizeToSplit: 10, maxDepth: 3 });
		refinedSplits = refined.splits;
		res = refined;
	}
	// renumber communities by size, largest first, so ids are stable for equal input
	const sizes = new Map<number, number>();
	for (const c of res.communities.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
	const order = [...sizes].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([c]) => c);
	const renumber = new Map(order.map((c, i) => [c, i]));
	const community = new Int32Array(table.ids.length).fill(-1);
	table.ids.forEach((id, i) => {
		const c = res.communities.get(id);
		if (c !== undefined) community[i] = renumber.get(c)!;
	});
	return { community, count: sizes.size, modularity: res.modularity, refinedSplits, graph: stats, ms: Math.round(performance.now() - t0) };
}
