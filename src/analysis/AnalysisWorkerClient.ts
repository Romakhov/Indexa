import type { NeighborTable } from "../vectors/NeighborTable";
import type { VectorSearchResult } from "../vectors/VectorIndex";
import type { AnalysisRequest, AnalysisResponse, ClusterResponse, IndexStats } from "./protocol";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; onProgress?: (done: number, total: number) => void };
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/** Main-thread handle to the analysis worker. Started lazily, never in onload(). */
export class AnalysisWorkerClient {
	private worker: Worker | null = null;
	private url: string | null = null;
	private nextId = 1;
	private pending = new Map<number, Pending>();

	private start(): Worker {
		if (this.worker) return this.worker;
		this.url = URL.createObjectURL(new Blob([__ANALYSIS_WORKER_CODE__], { type: "text/javascript" }));
		this.worker = new Worker(this.url, { name: "indexa-analysis" });
		this.worker.onmessage = (ev: MessageEvent<AnalysisResponse>) => this.onMessage(ev.data);
		this.worker.onerror = (ev) => this.terminate(new Error(`Analysis worker crashed: ${ev.message}`));
		return this.worker;
	}

	private request<T>(msg: DistributiveOmit<AnalysisRequest, "id">, transfer: Transferable[] = [], onProgress?: Pending["onProgress"]): Promise<T> {
		const worker = this.start();
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject, onProgress });
			worker.postMessage({ ...msg, id }, transfer);
		});
	}

	private onMessage(msg: AnalysisResponse) {
		const p = this.pending.get(msg.id);
		if (!p) return;
		if (msg.type === "progress") {
			p.onProgress?.(msg.done, msg.total);
			return;
		}
		this.pending.delete(msg.id);
		if (msg.type === "error") p.reject(new Error(msg.message));
		else if (msg.type === "ok") p.resolve(msg.stats);
		else if (msg.type === "search") p.resolve(msg.results);
		else if (msg.type === "cluster") p.resolve(msg.result);
		else p.resolve(msg.table);
	}

	init(dims: number, capacity: number): Promise<IndexStats> {
		return this.request({ type: "init", dims, capacity });
	}

	/** Vectors are packed into one buffer and transferred (no copy). */
	upsert(items: { id: string; vector: Float32Array }[], onProgress?: Pending["onProgress"]): Promise<IndexStats> {
		const dims = items[0]?.vector.length ?? 0;
		const packed = new Float32Array(items.length * dims);
		items.forEach((it, i) => packed.set(it.vector, i * dims));
		return this.request({ type: "upsert", ids: items.map((i) => i.id), vectors: packed }, [packed.buffer], onProgress);
	}

	remove(ids: string[]): Promise<IndexStats> {
		return this.request({ type: "remove", ids });
	}

	search(vector: Float32Array, k: number, excludeId?: string): Promise<VectorSearchResult[]> {
		return this.request({ type: "search", vector, k, excludeId });
	}

	knnAll(k: number, onProgress?: Pending["onProgress"]): Promise<NeighborTable> {
		return this.request({ type: "knnAll", k }, [], onProgress);
	}

	cluster(req: Omit<Extract<AnalysisRequest, { type: "cluster" }>, "id" | "type">): Promise<ClusterResponse> {
		return this.request({ type: "cluster", ...req });
	}

	stats(): Promise<IndexStats> {
		return this.request({ type: "stats" });
	}

	get running() {
		return this.worker !== null;
	}

	/** Stops the worker; the index is gone and will be rebuilt from the cache on next use. */
	terminate(reason = new Error("Analysis worker stopped")) {
		this.worker?.terminate();
		if (this.url) URL.revokeObjectURL(this.url);
		this.worker = null;
		this.url = null;
		for (const p of this.pending.values()) p.reject(reason);
		this.pending.clear();
	}
}
