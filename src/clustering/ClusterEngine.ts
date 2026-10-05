import type { SemanticGraph } from "../graph/SemanticGraphBuilder";

export interface ClusterOptions {
	/** Higher -> more, smaller communities. */
	resolution: number;
	/** Fixed seed makes results reproducible between runs. */
	seed: number;
}

export interface ClusterResult {
	/** node id -> community index */
	communities: Map<string, number>;
	count: number;
	modularity: number;
}

export interface ClusterEngine {
	cluster(graph: SemanticGraph, options: ClusterOptions): Promise<ClusterResult>;
}
