import type { EmbeddingProvider } from "./EmbeddingProvider";
import { LocalEmbeddingProvider } from "./LocalEmbeddingProvider";
import type { ModelSpec, ModelStore } from "./ModelStore";

/**
 * N single-threaded embedding workers behind one EmbeddingProvider.
 * onnxruntime-web cannot use threads in Obsidian (no SharedArrayBuffer), so
 * parallelism comes from separate workers, each with its own model session.
 * Each batch goes to the least busy worker; callers get parallelism by
 * keeping several embedBatch() calls in flight.
 */
export class PooledEmbeddingProvider implements EmbeddingProvider {
	private readonly workers: LocalEmbeddingProvider[];
	private readonly busy: number[];

	constructor(store: ModelStore, spec: ModelSpec, readonly size: number, device: "wasm" | "webgpu" = "wasm") {
		this.workers = Array.from({ length: Math.max(1, size) }, () => new LocalEmbeddingProvider(store, spec, undefined, device));
		this.busy = this.workers.map(() => 0);
	}

	get dimensions() {
		return this.workers[0].dimensions;
	}

	get blockedRequests(): string[] {
		return this.workers.flatMap((w) => w.blockedRequests);
	}

	async initialize() {
		// sequentially: each worker gets its own copy of the model files
		for (const w of this.workers) await w.initialize();
	}

	async embed(text: string) {
		return (await this.embedBatch([text]))[0];
	}

	async embedBatch(texts: string[]) {
		await this.initialize();
		let i = 0;
		for (let j = 1; j < this.busy.length; j++) if (this.busy[j] < this.busy[i]) i = j;
		this.busy[i]++;
		try {
			return await this.workers[i].embedBatch(texts);
		} finally {
			this.busy[i]--;
		}
	}

	async dispose() {
		await Promise.all(this.workers.map((w) => w.dispose()));
	}
}
