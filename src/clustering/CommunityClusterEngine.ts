// Adapter over graphology-communities-louvain. The only module that knows its API.

import louvain from "graphology-communities-louvain";
import type { SemanticGraph } from "../graph/SemanticGraphBuilder";
import type { ClusterEngine, ClusterOptions, ClusterResult } from "./ClusterEngine";

/** mulberry32: tiny seeded PRNG so Louvain's node shuffling is reproducible. */
export function seededRandom(seed: number): () => number {
	let s = seed | 0;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export class CommunityClusterEngine implements ClusterEngine {
	readonly algorithm = "louvain";

	async cluster(graph: SemanticGraph, options: ClusterOptions): Promise<ClusterResult> {
		const res = louvain.detailed(graph, {
			getEdgeWeight: "weight",
			resolution: options.resolution,
			rng: seededRandom(options.seed),
		});
		return { communities: new Map(Object.entries(res.communities)), count: res.count, modularity: res.modularity };
	}
}
