// Keeps the worker-side vector index in sync with the embedding cache
// (spec §30, §60, §63). The cache is the persisted source of truth: after a
// restart the index is rebuilt from it in the worker; afterwards only changed,
// new and deleted notes are sent (incremental update, no full rebuild).
//
// Vectors are mean-centred before indexing. multilingual-e5 vectors share a
// large common component, so long, mixed notes become "hubs" that look
// similar to everything. On the real test vault centring raised neighbour
// agreement with the user's own indexes from 0.33 to 0.43 and cut the most
// popular neighbour from 67 to 16 incoming links.

import type { AnalysisWorkerClient } from "../analysis/AnalysisWorkerClient";
import type { IndexStats } from "../analysis/protocol";
import type { CachedEmbedding, EmbeddingCache } from "../embeddings/EmbeddingCache";
import type { NeighborTable } from "./NeighborTable";
import type { VectorSearchResult } from "./VectorIndex";

export interface SyncResult {
	upserted: number;
	removed: number;
	rebuilt: boolean;
	stats: IndexStats;
}

export interface SyncOptions {
	/** notes that define the mean (notes with real content); defaults to all live notes */
	meanIds?: Iterable<string>;
	onProgress?: (done: number, total: number) => void;
}

const BATCH = 500;
/** re-centre once this share of the index changed since the mean was computed */
const RECENTER_SHARE = 0.2;

export function meanVector(vectors: Float32Array[], dims: number): Float32Array {
	const m = new Float32Array(dims);
	for (const v of vectors) for (let i = 0; i < dims; i++) m[i] += v[i];
	if (vectors.length) for (let i = 0; i < dims; i++) m[i] /= vectors.length;
	return m;
}

/** normalize(v - mean) */
export function centered(v: Float32Array, mean: Float32Array): Float32Array {
	const out = new Float32Array(v.length);
	let s = 0;
	for (let i = 0; i < v.length; i++) {
		out[i] = v[i] - mean[i];
		s += out[i] * out[i];
	}
	const n = Math.sqrt(s) || 1;
	for (let i = 0; i < out.length; i++) out[i] /= n;
	return out;
}

export class VectorIndexService {
	/** noteId -> contentHash of the vector currently in the index */
	private synced = new Map<string, string>();
	private mean: Float32Array | null = null;
	private changedSinceMean = 0;

	constructor(
		private readonly client: AnalysisWorkerClient,
		private readonly dims: number,
	) {}

	get size() {
		return this.synced.size;
	}

	async sync(cache: EmbeddingCache, liveIds: Iterable<string>, options: SyncOptions = {}): Promise<SyncResult> {
		const entries = [...liveIds].map((id) => cache.peek(id)).filter((e): e is CachedEmbedding => e !== undefined);
		const needsRebuild =
			!this.client.running || this.synced.size === 0 || this.mean === null || this.changedSinceMean > RECENTER_SHARE * Math.max(1, this.synced.size);

		if (needsRebuild) {
			const meanSet = options.meanIds ? new Set(options.meanIds) : null;
			const basis = meanSet ? entries.filter((e) => meanSet.has(e.noteId)) : entries;
			this.mean = meanVector((basis.length ? basis : entries).map((e) => e.documentVector), this.dims);
			await this.client.init(this.dims, Math.max(1024, entries.length * 2));
			this.synced.clear();
			this.changedSinceMean = 0;
		}
		const mean = this.mean!;

		const live = new Set(entries.map((e) => e.noteId));
		const toRemove = [...this.synced.keys()].filter((id) => !live.has(id));
		const toUpsert = entries.filter((e) => this.synced.get(e.noteId) !== e.contentHash);
		const total = toUpsert.length;

		let stats = toRemove.length ? await this.client.remove(toRemove) : await this.client.stats();
		toRemove.forEach((id) => this.synced.delete(id));
		for (let i = 0; i < toUpsert.length; i += BATCH) {
			const batch = toUpsert.slice(i, i + BATCH);
			stats = await this.client.upsert(
				batch.map((e) => ({ id: e.noteId, vector: centered(e.documentVector, mean) })),
				(done) => options.onProgress?.(i + done, total),
			);
			batch.forEach((e) => this.synced.set(e.noteId, e.contentHash));
		}
		if (!needsRebuild) this.changedSinceMean += toUpsert.length + toRemove.length;
		options.onProgress?.(total, total);
		return { upserted: toUpsert.length, removed: toRemove.length, rebuilt: needsRebuild, stats };
	}

	knnAll(k: number, onProgress?: (done: number, total: number) => void): Promise<NeighborTable> {
		return this.client.knnAll(k, onProgress);
	}

	/** @param vector a raw (uncentred) document vector */
	search(vector: Float32Array, k: number, excludeId?: string): Promise<VectorSearchResult[]> {
		if (!this.mean) throw new Error("Vector index is not built yet");
		return this.client.search(centered(vector, this.mean), k, excludeId);
	}

	/** Forget local sync state (e.g. after the worker was stopped). */
	reset() {
		this.synced.clear();
		this.mean = null;
	}
}
