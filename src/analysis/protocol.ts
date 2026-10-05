// Messages between the plugin and the analysis worker (vector index, later graph + clustering).

import type { NeighborTable } from "../vectors/NeighborTable";
import type { VectorSearchResult } from "../vectors/VectorIndex";

export type AnalysisRequest =
	| { type: "init"; id: number; dims: number; capacity: number }
	| { type: "upsert"; id: number; ids: string[]; vectors: Float32Array }
	| { type: "remove"; id: number; ids: string[] }
	| { type: "search"; id: number; vector: Float32Array; k: number; excludeId?: string }
	| { type: "knnAll"; id: number; k: number }
	| { type: "stats"; id: number };

export interface IndexStats {
	kind: string;
	size: number;
	fallbackReason: string | null;
}

export type AnalysisResponse =
	| { type: "ok"; id: number; stats: IndexStats }
	| { type: "search"; id: number; results: VectorSearchResult[] }
	| { type: "knnAll"; id: number; table: NeighborTable }
	| { type: "progress"; id: number; done: number; total: number }
	| { type: "error"; id: number; message: string };
