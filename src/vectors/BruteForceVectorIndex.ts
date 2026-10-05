import type { BinaryStore } from "../storage/BinaryStore";
import type { VectorIndex, VectorSearchResult } from "./VectorIndex";

/**
 * Exact O(n) search per query. For tests, small vaults, benchmark baselines
 * and as a fallback when the ANN library cannot be loaded. Never use it to
 * build a full kNN graph of a large vault.
 */
export class BruteForceVectorIndex implements VectorIndex {
	readonly kind = "brute-force";
	private dims = 0;
	private vectors = new Map<string, Float32Array>();

	constructor(
		private readonly store?: BinaryStore,
		private readonly name = "bruteforce",
	) {}

	get size() {
		return this.vectors.size;
	}

	async initialize(dimensions: number) {
		this.dims = dimensions;
	}

	async add(id: string, vector: Float32Array) {
		if (vector.length !== this.dims) throw new Error(`Expected ${this.dims} dims, got ${vector.length}`);
		this.vectors.set(id, vector);
	}

	update(id: string, vector: Float32Array) {
		return this.add(id, vector);
	}

	async remove(id: string) {
		this.vectors.delete(id);
	}

	has(id: string) {
		return this.vectors.has(id);
	}

	async search(query: Float32Array, k: number): Promise<VectorSearchResult[]> {
		const out: VectorSearchResult[] = [];
		for (const [id, v] of this.vectors) {
			let s = 0;
			for (let i = 0; i < v.length; i++) s += v[i] * query[i];
			out.push({ id, score: s });
		}
		out.sort((a, b) => b.score - a.score);
		return out.slice(0, k);
	}

	async save() {
		if (!this.store) return;
		const ids = [...this.vectors.keys()];
		const data = new Float32Array(ids.length * this.dims);
		ids.forEach((id, i) => data.set(this.vectors.get(id)!, i * this.dims));
		await this.store.write(`${this.name}.json`, new TextEncoder().encode(JSON.stringify({ dims: this.dims, ids })));
		await this.store.write(`${this.name}.f32`, data.buffer);
	}

	async load() {
		if (!this.store) return false;
		const meta = await this.store.read(`${this.name}.json`);
		const bin = await this.store.read(`${this.name}.f32`);
		if (!meta || !bin) return false;
		const { dims, ids } = JSON.parse(new TextDecoder().decode(meta)) as { dims: number; ids: string[] };
		const data = new Float32Array(bin);
		this.dims = dims;
		this.vectors = new Map(ids.map((id, i) => [id, data.slice(i * dims, (i + 1) * dims)]));
		return true;
	}

	async clear() {
		this.vectors.clear();
	}
}
