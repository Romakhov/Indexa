// The vector-search side of the analysis worker. Pure: runs in a worker in
// the plugin and in Node in tests. Knows VectorIndex, not a specific library.

import type { NeighborTable } from "./NeighborTable";
import type { VectorIndex, VectorSearchResult } from "./VectorIndex";

export interface IndexItem {
	id: string;
	vector: Float32Array;
}

export type IndexFactory = (kind: "hnsw" | "brute-force") => VectorIndex;

export interface IndexEngineOptions {
	/** above this size a missing ANN library is an error, not a silent O(n²) fallback (spec §83) */
	maxBruteForce: number;
	/** expected number of vectors; avoids index growth rebuilds */
	capacity: number;
}

export class IndexEngine {
	private index: VectorIndex | null = null;
	private vectors = new Map<string, Float32Array>();
	private dims = 0;
	fallbackReason: string | null = null;

	constructor(
		private readonly factory: IndexFactory,
		private readonly options: IndexEngineOptions = { maxBruteForce: 3000, capacity: 1024 },
	) {}

	get kind() {
		return this.index?.kind ?? "none";
	}

	get size() {
		return this.vectors.size;
	}

	async init(dims: number, capacity = this.options.capacity) {
		this.dims = dims;
		this.vectors.clear();
		this.fallbackReason = null;
		try {
			this.index = this.factory("hnsw");
			await (this.index as VectorIndex & { initialize(d: number, c?: number): Promise<void> }).initialize(dims, capacity);
		} catch (e) {
			// ANN library unavailable: brute force is fine for small vaults only
			this.fallbackReason = e instanceof Error ? e.message : String(e);
			if (capacity > this.options.maxBruteForce * 2) throw new Error(`Vector index library could not be loaded (${this.fallbackReason})`);
			this.index = this.factory("brute-force");
			await this.index.initialize(dims);
		}
	}

	private get idx(): VectorIndex {
		if (!this.index) throw new Error("IndexEngine is not initialized");
		return this.index;
	}

	async upsert(items: IndexItem[], onProgress?: (done: number) => void) {
		if (this.index?.kind === "brute-force" && this.vectors.size + items.length > this.options.maxBruteForce) {
			throw new Error(`Vector index library unavailable and the vault is too large for exact search (${this.fallbackReason})`);
		}
		for (let i = 0; i < items.length; i++) {
			const { id, vector } = items[i];
			if (vector.length !== this.dims) throw new Error(`Vector for ${id} has ${vector.length} dims, expected ${this.dims}`);
			await (this.vectors.has(id) ? this.idx.update(id, vector) : this.idx.add(id, vector));
			this.vectors.set(id, vector);
			if (onProgress && i % 100 === 99) onProgress(i + 1);
		}
		onProgress?.(items.length);
	}

	async remove(ids: string[]) {
		for (const id of ids) {
			if (!this.vectors.delete(id)) continue;
			await this.idx.remove(id);
		}
	}

	ids(): string[] {
		return [...this.vectors.keys()];
	}

	async search(vector: Float32Array, k: number, excludeId?: string): Promise<VectorSearchResult[]> {
		const res = await this.idx.search(vector, excludeId ? k + 1 : k);
		return (excludeId ? res.filter((r) => r.id !== excludeId) : res).slice(0, k);
	}

	/** Top-K neighbours for every indexed vector (self excluded). */
	async knnAll(k: number, onProgress?: (done: number, total: number) => void): Promise<NeighborTable> {
		const ids = this.ids();
		const row = new Map(ids.map((id, i) => [id, i]));
		const neighbors = new Int32Array(ids.length * k).fill(-1);
		const scores = new Float32Array(ids.length * k);
		for (let i = 0; i < ids.length; i++) {
			const res = await this.search(this.vectors.get(ids[i])!, k, ids[i]);
			res.forEach((r, j) => {
				neighbors[i * k + j] = row.get(r.id)!;
				scores[i * k + j] = r.score;
			});
			if (onProgress && (i % 200 === 199 || i === ids.length - 1)) onProgress(i + 1, ids.length);
		}
		return { ids, k, neighbors, scores };
	}
}
