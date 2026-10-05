// Stores the embedding model in IndexedDB of the Obsidian app (origin
// app://obsidian.md): shared between vaults, never part of a vault, so vault
// sync does not copy it, and no file system access outside the vault is needed.

import { requestUrl } from "obsidian";

export interface ModelSpec {
	/** Hugging Face repo id; also the transformers.js model id. */
	id: string;
	/** Pinned commit, so the downloaded files never change silently. */
	revision: string;
	dtype: string;
	files: string[];
	approxBytes: number;
	license: string;
	dims: number;
}

export const E5_SMALL: ModelSpec = {
	id: "Xenova/multilingual-e5-small",
	revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
	dtype: "q8",
	files: ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"],
	approxBytes: 135_500_000,
	license: "MIT",
	dims: 384,
};

const DB_NAME = "indexa-models";
const STORE = "files";
/** written after the last file, so an interrupted download never looks installed */
const COMPLETE = ".complete";

const done = <T>(req: IDBRequest<T>) =>
	new Promise<T>((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
	});

export class ModelStore {
	private db: Promise<IDBDatabase> | null = null;

	constructor(private readonly dbName = DB_NAME) {}

	/** Where the model lives, for reports and the README. */
	location(spec: ModelSpec): string {
		return `IndexedDB ${this.dbName}/${this.prefix(spec)}`;
	}

	private prefix(spec: ModelSpec) {
		return `${spec.id}@${spec.revision}/`;
	}

	private open(): Promise<IDBDatabase> {
		this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open(this.dbName, 1);
			req.onupgradeneeded = () => req.result.createObjectStore(STORE);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
		}).catch((e: unknown) => {
			this.db = null;
			throw e;
		});
		return this.db;
	}

	private async get(key: string): Promise<ArrayBuffer | undefined> {
		const db = await this.open();
		return done(db.transaction(STORE, "readonly").objectStore(STORE).get(key) as IDBRequest<ArrayBuffer | undefined>);
	}

	private async put(key: string, value: ArrayBuffer): Promise<void> {
		const db = await this.open();
		const tx = db.transaction(STORE, "readwrite");
		tx.objectStore(STORE).put(value, key);
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write failed"));
		});
	}

	private async has(key: string): Promise<boolean> {
		const db = await this.open();
		return (await done(db.transaction(STORE, "readonly").objectStore(STORE).count(key))) > 0;
	}

	async isInstalled(spec: ModelSpec): Promise<boolean> {
		return this.has(this.prefix(spec) + COMPLETE);
	}

	/** Explicit user action only. The only network request the plugin makes. */
	async download(spec: ModelSpec, onProgress?: (file: string, i: number, n: number) => void): Promise<void> {
		// ask the app not to evict the model under storage pressure (best effort)
		await navigator.storage?.persist?.().catch(() => false);
		for (let i = 0; i < spec.files.length; i++) {
			const file = spec.files[i];
			const key = this.prefix(spec) + file;
			if (await this.has(key)) continue;
			onProgress?.(file, i + 1, spec.files.length);
			const url = `https://huggingface.co/${spec.id}/resolve/${spec.revision}/${file}`;
			const res = await requestUrl({ url, throw: true });
			await this.put(key, res.arrayBuffer);
		}
		await this.put(this.prefix(spec) + COMPLETE, new ArrayBuffer(0));
	}

	async readAll(spec: ModelSpec): Promise<Record<string, ArrayBuffer>> {
		const out: Record<string, ArrayBuffer> = {};
		for (const file of spec.files) {
			const buf = await this.get(this.prefix(spec) + file);
			if (!buf) throw new Error(`Model file missing: ${file}. Run "Download local semantic model" again.`);
			out[file] = buf;
		}
		return out;
	}
}
