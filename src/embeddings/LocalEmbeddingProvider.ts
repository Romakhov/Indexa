import type { EmbeddingProvider } from "./EmbeddingProvider";
import type { ModelSpec, ModelStore } from "./ModelStore";
import type { WorkerRequest, WorkerResponse } from "./worker/protocol";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/**
 * Runs the embedding model in a dedicated Web Worker so inference never blocks
 * the Obsidian UI. The worker is created lazily on initialize().
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
	dimensions = 0;
	initInfo: { loadMs: number; backend: string } | null = null;
	readonly blockedRequests: string[] = [];

	private worker: Worker | null = null;
	private workerUrl: string | null = null;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private initPromise: Promise<void> | null = null;

	constructor(
		private readonly store: ModelStore,
		private readonly spec: ModelSpec,
		/** E5 models expect a task prefix; "query: " is the one for symmetric similarity / clustering. */
		private readonly prefix = "query: ",
		private readonly device: "wasm" | "webgpu" = "wasm",
	) {}

	initialize(): Promise<void> {
		this.initPromise ??= this.doInitialize().catch((e) => {
			this.initPromise = null;
			throw e;
		});
		return this.initPromise;
	}

	private async doInitialize(): Promise<void> {
		if (!this.store.isInstalled(this.spec)) throw new Error("Local semantic model is not installed");
		const files = await this.store.readAll(this.spec);

		this.workerUrl = URL.createObjectURL(new Blob([__WORKER_CODE__], { type: "text/javascript" }));
		this.worker = new Worker(this.workerUrl, { name: "indexa-embeddings" });
		this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev.data);
		this.worker.onerror = (ev) => this.failAll(new Error(`Embedding worker crashed: ${ev.message}`));

		const res = await this.request(
			{ type: "init", modelId: this.spec.id, dtype: this.spec.dtype, device: this.device, files },
			Object.values(files),
		);
		this.dimensions = res.dimensions;
		this.initInfo = { loadMs: res.loadMs, backend: res.backend };
	}

	async embed(text: string): Promise<Float32Array> {
		return (await this.embedBatch([text]))[0];
	}

	async embedBatch(texts: string[]): Promise<Float32Array[]> {
		await this.initialize();
		const res = await this.request({ type: "embed", texts: texts.map((t) => this.prefix + t) });
		return res.vectors;
	}

	async dispose(): Promise<void> {
		if (this.worker) {
			await this.request({ type: "dispose" }).catch(() => undefined);
			this.worker.terminate();
		}
		if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
		this.worker = null;
		this.workerUrl = null;
		this.initPromise = null;
		this.failAll(new Error("Embedding provider disposed"));
	}

	private request(msg: DistributiveOmit<WorkerRequest, "id">, transfer: Transferable[] = []): Promise<any> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.worker!.postMessage({ ...msg, id }, transfer);
		});
	}

	private onMessage(msg: WorkerResponse) {
		if (msg.type === "blocked") {
			this.blockedRequests.push(msg.url);
			console.warn("[indexa] blocked network request from embedding worker:", msg.url);
			return;
		}
		if (msg.type === "log") {
			console.debug("[indexa] worker:", msg.message);
			return;
		}
		const p = this.pending.get(msg.id);
		if (!p) return;
		this.pending.delete(msg.id);
		if (msg.type === "error") p.reject(new Error(msg.message));
		else p.resolve(msg);
	}

	private failAll(err: Error) {
		for (const p of this.pending.values()) p.reject(err);
		this.pending.clear();
	}
}
