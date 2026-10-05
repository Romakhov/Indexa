/// <reference lib="webworker" />
// Analysis worker: vector index (and, from Phase 4, graph + clustering).
// Holds no model and no note text; only ids and vectors. No network access.

import type { BinaryStore } from "../storage/BinaryStore";
import { BruteForceVectorIndex } from "../vectors/BruteForceVectorIndex";
import { HnswVectorIndex } from "../vectors/HnswVectorIndex";
import { IndexEngine } from "../vectors/IndexEngine";
import type { AnalysisRequest, AnalysisResponse } from "./protocol";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: AnalysisResponse, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);

// Obsidian enables Node in workers; nothing here needs it.
for (const name of ["process", "require", "module", "global", "Buffer"]) {
	try {
		Object.defineProperty(globalThis, name, { value: undefined, configurable: true, writable: true });
	} catch {
		/* ignore */
	}
}
for (const name of ["fetch", "importScripts", "XMLHttpRequest"]) {
	(ctx as any)[name] = () => {
		throw new Error(`Network access is disabled in the analysis worker (${name})`);
	};
}

/** The index is rebuilt from the embedding cache, so it never persists itself. */
const nullStore: BinaryStore = { read: async () => null, write: async () => undefined, remove: async () => undefined };

const engine = new IndexEngine((kind) => (kind === "hnsw" ? new HnswVectorIndex(nullStore, "index") : new BruteForceVectorIndex()));

const stats = () => ({ kind: engine.kind, size: engine.size, fallbackReason: engine.fallbackReason });

ctx.onmessage = async (ev: MessageEvent<AnalysisRequest>) => {
	const req = ev.data;
	try {
		switch (req.type) {
			case "init":
				await engine.init(req.dims, req.capacity);
				return post({ type: "ok", id: req.id, stats: stats() });
			case "upsert": {
				const d = req.vectors.length / Math.max(1, req.ids.length);
				const items = req.ids.map((id, i) => ({ id, vector: req.vectors.subarray(i * d, (i + 1) * d) }));
				await engine.upsert(items, (done) => post({ type: "progress", id: req.id, done, total: items.length }));
				return post({ type: "ok", id: req.id, stats: stats() });
			}
			case "remove":
				await engine.remove(req.ids);
				return post({ type: "ok", id: req.id, stats: stats() });
			case "search":
				return post({ type: "search", id: req.id, results: await engine.search(req.vector, req.k, req.excludeId) });
			case "knnAll": {
				const table = await engine.knnAll(req.k, (done, total) => post({ type: "progress", id: req.id, done, total }));
				return post({ type: "knnAll", id: req.id, table }, [table.neighbors.buffer, table.scores.buffer]);
			}
			case "stats":
				return post({ type: "ok", id: req.id, stats: stats() });
		}
	} catch (e) {
		post({ type: "error", id: req.id, message: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) });
	}
};
