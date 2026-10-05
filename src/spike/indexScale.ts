// Dev check (spec §93): index sync + top-K for n synthetic vectors run in the
// analysis worker while the main thread stays responsive.

import { EmbeddingCache } from "../embeddings/EmbeddingCache";
import type { BinaryStore } from "../storage/BinaryStore";
import type { VectorIndexService } from "../vectors/VectorIndexService";
import { stallMonitor } from "./stall";

const memoryStore = (): BinaryStore => ({ read: async () => null, write: async () => undefined, remove: async () => undefined });

export async function indexScale(service: VectorIndexService, n: number, dims = 384, k = 15) {
	let s = 7;
	const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
	const centers = Array.from({ length: 40 }, () => Float32Array.from({ length: dims }, rnd));
	const cache = new EmbeddingCache(memoryStore(), "synthetic", "1", dims);
	for (let i = 0; i < n; i++) {
		const v = centers[i % 40].map((x) => x + 0.5 * rnd());
		const norm = Math.hypot(...v);
		cache.set({ noteId: `s${i}`, contentHash: "h", documentVector: v.map((x) => x / norm) });
	}
	const ids = Array.from({ length: n }, (_, i) => `s${i}`);
	service.reset();
	const stop = stallMonitor();
	const t0 = performance.now();
	const sync = await service.sync(cache, ids);
	const t1 = performance.now();
	const table = await service.knnAll(k);
	const t2 = performance.now();
	const again = await service.sync(cache, ids);
	const t3 = performance.now();
	const stall = stop();
	service.reset(); // leave no synthetic data behind
	return {
		n,
		kind: sync.stats.kind,
		buildMs: Math.round(t1 - t0),
		knnMs: Math.round(t2 - t1),
		noChangeSyncMs: Math.round(t3 - t2),
		noChangeUpserted: again.upserted,
		edgesUpperBound: table.ids.length * k,
		mainThreadLongTasks: { worstMs: stall.worstMs, count: stall.count },
	};
}
