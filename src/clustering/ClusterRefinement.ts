import Graph from "graphology";
import type { SemanticGraph } from "../graph/SemanticGraphBuilder";
import type { ClusterEngine, ClusterOptions, ClusterResult } from "./ClusterEngine";

export interface RefinementOptions {
	/** A community larger than this share of all nodes is considered too broad. */
	maxShare: number;
	/** Never split communities smaller than this. */
	minSizeToSplit: number;
	maxDepth: number;
}

function inducedSubgraph(graph: SemanticGraph, nodes: string[]): SemanticGraph {
	const sub: SemanticGraph = new Graph({ type: "undirected", multi: false, allowSelfLoops: false });
	const set = new Set(nodes);
	for (const n of nodes) sub.addNode(n);
	for (const n of nodes) {
		graph.forEachEdge(n, (_e, attr, s, t) => {
			const other = s === n ? t : s;
			if (set.has(other) && !sub.hasEdge(n, other)) sub.addEdge(n, other, attr);
		});
	}
	return sub;
}

/**
 * Recursive refinement (spec §45–46): re-runs community detection on the
 * subgraph of every too-broad community and replaces it with its parts.
 */
export async function refineCommunities(
	graph: SemanticGraph,
	initial: ClusterResult,
	engine: ClusterEngine,
	cluster: ClusterOptions,
	opts: RefinementOptions,
): Promise<ClusterResult & { splits: number }> {
	const total = graph.order;
	const communities = new Map(initial.communities);
	let next = Math.max(-1, ...communities.values()) + 1;
	let splits = 0;

	const members = () => {
		const m = new Map<number, string[]>();
		for (const [n, c] of communities) m.set(c, [...(m.get(c) ?? []), n]);
		return m;
	};

	for (let depth = 0; depth < opts.maxDepth; depth++) {
		let changed = false;
		for (const [, nodes] of members()) {
			if (nodes.length / total <= opts.maxShare || nodes.length < opts.minSizeToSplit) continue;
			const sub = await engine.cluster(inducedSubgraph(graph, nodes), cluster);
			if (sub.count < 2) continue;
			const remap = new Map<number, number>();
			for (const [n, c] of sub.communities) {
				if (!remap.has(c)) remap.set(c, next++);
				communities.set(n, remap.get(c)!);
			}
			splits++;
			changed = true;
		}
		if (!changed) break;
	}
	return { communities, count: new Set(communities.values()).size, modularity: initial.modularity, splits };
}
