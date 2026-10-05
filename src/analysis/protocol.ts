// Messages between the plugin and the analysis worker (vector index, later graph + clustering).

import type { ClusterNotesResult } from "../clustering/clusterNotes";
import type { EdgeWeights, NoteFeatures } from "../graph/HybridEdgeScorer";
import type { NeighborTable } from "../vectors/NeighborTable";
import type { VectorSearchResult } from "../vectors/VectorIndex";

export type AnalysisRequest =
	| { type: "init"; id: number; dims: number; capacity: number }
	| { type: "upsert"; id: number; ids: string[]; vectors: Float32Array }
	| { type: "remove"; id: number; ids: string[] }
	| { type: "search"; id: number; vector: Float32Array; k: number; excludeId?: string }
	| { type: "knnAll"; id: number; k: number }
	| { type: "stats"; id: number }
	| {
			type: "cluster";
			id: number;
			k: number;
			/** feature rows; links refer to positions in noteIds */
			noteIds: string[];
			features: NoteFeatures[];
			/** notes that take part (others keep community -1) */
			include: string[];
			weights: EdgeWeights;
			resolution: number;
			seed: number;
			refineMaxShare: number | null;
	  };

export interface ClusterResponse extends Omit<ClusterNotesResult, "community"> {
	ids: string[];
	community: Int32Array;
	knnMs: number;
}

export interface IndexStats {
	kind: string;
	size: number;
	fallbackReason: string | null;
}

export type AnalysisResponse =
	| { type: "ok"; id: number; stats: IndexStats }
	| { type: "search"; id: number; results: VectorSearchResult[] }
	| { type: "knnAll"; id: number; table: NeighborTable }
	| { type: "cluster"; id: number; result: ClusterResponse }
	| { type: "progress"; id: number; done: number; total: number }
	| { type: "error"; id: number; message: string };
