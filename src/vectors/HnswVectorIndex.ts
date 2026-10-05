// Adapter over hnswlib-wasm-core. The only module that knows that library's API.
//
// Persistence: hnswlib-wasm-core 0.9.1 ships writeIndexToBuffer/readIndexFromBuffer
// bindings with an unregistered std::vector<char> type, so they throw at runtime.
// The adapter therefore persists its inputs (ids + Float32 vectors) and rebuilds
// the graph on load() with the same seed and insertion order (deterministic).
//
// Growth: resizeIndex() on a populated index makes every later search ~1000x
// slower in this build (0.1 ms -> 128 ms per query at 2k vectors). The adapter
// never resizes a non-empty index; it rebuilds into a doubled capacity instead.

import { loadHnswlib as loadUntyped } from "hnswlib-wasm-core";
import { timeSlicer } from "../core/yieldToUi";
import type { BinaryStore } from "../storage/BinaryStore";
import type { VectorIndex, VectorSearchResult } from "./VectorIndex";

// The package's .d.ts imports a file it does not ship, so its types resolve to
// nothing. This is the subset of the emscripten bindings the adapter uses.
interface VecF {
	resize(n: number, fill: number): void;
	set(i: number, v: number): void;
	delete(): void;
}
interface Hnsw {
	initIndex(maxElements: number, m: number, efConstruction: number, seed: number): void;
	setEfSearch(ef: number): void;
	getMaxElements(): number;
	addPoint(point: VecF, label: number, replaceDeleted: boolean): void;
	markDelete(label: number): void;
	searchKnn(query: VecF, k: number, filter: undefined): { neighbors: number[]; distances: number[] };
	delete(): void;
}
interface HnswlibModule {
	HierarchicalNSW: new (space: "ip" | "l2" | "cosine", dims: number) => Hnsw;
	VectorFloat: new () => VecF;
}
const loadHnswlib = loadUntyped as unknown as () => Promise<HnswlibModule>;

export interface HnswParams {
	m: number;
	efConstruction: number;
	efSearch: number;
	seed: number;
	initialCapacity: number;
}

const DEFAULTS: HnswParams = { m: 16, efConstruction: 200, efSearch: 64, seed: 100, initialCapacity: 1024 };

interface Meta {
	version: 2;
	dims: number;
	params: HnswParams;
	/** live ids in insertion order; vector i is at offset i * dims in the .f32 file */
	ids: string[];
}

export class HnswVectorIndex implements VectorIndex {
	readonly kind = "hnsw";
	private lib: HnswlibModule | null = null;
	private index: Hnsw | null = null;
	private dims = 0;
	private readonly params: HnswParams;
	private labels: (string | null)[] = [];
	private ids = new Map<string, number>();
	/** live vectors in insertion order: source of truth for save() and rebuilds */
	private vectors = new Map<string, Float32Array>();
	/** Reused emscripten vector: the bindings accept VectorFloat only (not arrays, despite the typings). */
	private scratch: VecF | null = null;

	constructor(
		private readonly store: BinaryStore,
		private readonly name = "hnsw",
		params: Partial<HnswParams> = {},
	) {
		this.params = { ...DEFAULTS, ...params };
	}

	get size() {
		return this.ids.size;
	}

	/** @param capacity expected number of vectors; avoids rebuilds while growing */
	async initialize(dimensions: number, capacity = this.params.initialCapacity) {
		this.lib ??= await loadHnswlib();
		this.dims = dimensions;
		this.index?.delete();
		this.index = this.create();
		this.index.initIndex(Math.max(capacity, 16), this.params.m, this.params.efConstruction, this.params.seed);
		this.index.setEfSearch(this.params.efSearch);
		this.labels = [];
		this.ids.clear();
		this.vectors.clear();
	}

	/** Rebuilds the graph from the live vectors into a fresh index (also drops tombstones). */
	private async rebuild(capacity: number) {
		const live = [...this.vectors];
		await this.initialize(this.dims, capacity);
		const maybeYield = timeSlicer();
		for (const [id, v] of live) {
			await this.add(id, v);
			await maybeYield();
		}
	}

	private toVec(v: Float32Array): VecF {
		if (!this.scratch) {
			this.scratch = new this.lib!.VectorFloat();
			this.scratch.resize(this.dims, 0);
		}
		for (let i = 0; i < v.length; i++) this.scratch.set(i, v[i]);
		return this.scratch;
	}

	private create(): Hnsw {
		this.scratch?.delete();
		this.scratch = null;
		// vectors are L2-normalised, so inner product == cosine
		return new this.lib!.HierarchicalNSW("ip", this.dims);
	}

	private get idx(): Hnsw {
		if (!this.index) throw new Error("HnswVectorIndex is not initialized");
		return this.index;
	}

	async add(id: string, vector: Float32Array) {
		if (this.ids.has(id)) return this.update(id, vector);
		if (vector.length !== this.dims) throw new Error(`Expected ${this.dims} dims, got ${vector.length}`);
		if (this.labels.length >= this.idx.getMaxElements()) await this.rebuild(Math.max(this.vectors.size + 1, this.idx.getMaxElements()) * 2);
		const label = this.labels.length;
		this.idx.addPoint(this.toVec(vector), label, false);
		this.labels.push(id);
		this.ids.set(id, label);
		this.vectors.set(id, vector);
	}

	async update(id: string, vector: Float32Array) {
		await this.remove(id);
		await this.add(id, vector);
	}

	async remove(id: string) {
		const label = this.ids.get(id);
		if (label === undefined) return;
		this.idx.markDelete(label);
		this.labels[label] = null;
		this.ids.delete(id);
		this.vectors.delete(id);
	}

	has(id: string) {
		return this.ids.has(id);
	}

	async search(vector: Float32Array, k: number): Promise<VectorSearchResult[]> {
		const n = Math.min(k, this.ids.size);
		if (n === 0) return [];
		const res = this.idx.searchKnn(this.toVec(vector), n, undefined);
		const out: VectorSearchResult[] = [];
		for (let i = 0; i < res.neighbors.length; i++) {
			const id = this.labels[res.neighbors[i]];
			if (id !== null && id !== undefined) out.push({ id, score: 1 - res.distances[i] });
		}
		return out.sort((a, b) => b.score - a.score);
	}

	async save() {
		const ids = [...this.vectors.keys()];
		const data = new Float32Array(ids.length * this.dims);
		ids.forEach((id, i) => data.set(this.vectors.get(id)!, i * this.dims));
		const meta: Meta = { version: 2, dims: this.dims, params: this.params, ids };
		await this.store.write(`${this.name}.f32`, data.buffer);
		// meta last; load() rejects a meta whose id count does not match the vector file
		await this.store.write(`${this.name}.json`, new TextEncoder().encode(JSON.stringify(meta)));
	}

	async load(): Promise<boolean> {
		const metaBuf = await this.store.read(`${this.name}.json`);
		const bin = await this.store.read(`${this.name}.f32`);
		if (!metaBuf || !bin) return false;
		const meta = JSON.parse(new TextDecoder().decode(metaBuf)) as Meta;
		if (meta.version !== 2 || bin.byteLength !== meta.ids.length * meta.dims * 4) return false;
		const data = new Float32Array(bin);
		await this.initialize(meta.dims, Math.max(this.params.initialCapacity, meta.ids.length * 2));
		const maybeYield = timeSlicer();
		for (let i = 0; i < meta.ids.length; i++) {
			await this.add(meta.ids[i], data.slice(i * meta.dims, (i + 1) * meta.dims));
			await maybeYield();
		}
		return true;
	}

	async clear() {
		if (this.dims) await this.initialize(this.dims);
	}
}
