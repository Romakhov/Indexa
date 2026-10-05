import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisWorkerClient } from "../src/analysis/AnalysisWorkerClient";
import { EmbeddingCache } from "../src/embeddings/EmbeddingCache";
import type { BinaryStore } from "../src/storage/BinaryStore";
import { BruteForceVectorIndex } from "../src/vectors/BruteForceVectorIndex";
import { HnswVectorIndex } from "../src/vectors/HnswVectorIndex";
import { IndexEngine } from "../src/vectors/IndexEngine";
import { neighborsOf, toNeighborMap } from "../src/vectors/NeighborTable";
import { centered, meanVector, VectorIndexService } from "../src/vectors/VectorIndexService";

const nullStore: BinaryStore = { read: async () => null, write: async () => undefined, remove: async () => undefined };

/** n unit vectors in `clusters` well separated groups (seeded). */
function clustered(n: number, dims: number, clusters: number, seed = 1) {
	let s = seed;
	const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
	const centers = Array.from({ length: clusters }, () => Float32Array.from({ length: dims }, rnd));
	return Array.from({ length: n }, (_, i) => {
		const v = centers[i % clusters].map((x) => x + 0.3 * rnd());
		const norm = Math.hypot(...v);
		return { id: `n${i}`, vector: v.map((x) => x / norm), cluster: i % clusters };
	});
}

const engine = (kind: "hnsw" | "brute-force" | "broken-hnsw", maxBruteForce = 3000) =>
	new IndexEngine(
		(k) => {
			if (k === "hnsw" && kind === "broken-hnsw") throw new Error("wasm failed");
			return k === "hnsw" && kind === "hnsw" ? new HnswVectorIndex(nullStore, "t") : new BruteForceVectorIndex();
		},
		{ maxBruteForce, capacity: 1024 },
	);

beforeAll(() => {
	// hnswlib-wasm-core is built for the web only
	(globalThis as any).window ??= globalThis;
});

describe("IndexEngine", () => {
	it("finds same-cluster neighbours and excludes self", async () => {
		const e = engine("brute-force");
		await e.init(16);
		const data = clustered(60, 16, 3);
		await e.upsert(data);
		const res = await e.search(data[0].vector, 5, "n0");
		expect(res.map((r) => r.id)).not.toContain("n0");
		expect(res.every((r) => Number(r.id.slice(1)) % 3 === 0)).toBe(true);
	});

	it("updates and removes", async () => {
		const e = engine("brute-force");
		await e.init(16);
		const data = clustered(30, 16, 3);
		await e.upsert(data);
		await e.upsert([{ id: "n0", vector: data[1].vector }]); // n0 moves into cluster 1
		expect((await e.search(data[1].vector, 2, "n1"))[0].id).toBe("n0");
		await e.remove(["n0"]);
		expect(e.size).toBe(29);
		expect((await e.search(data[1].vector, 30)).some((r) => r.id === "n0")).toBe(false);
	});

	it("builds a top-K neighbour table", async () => {
		const e = engine("brute-force");
		await e.init(16);
		await e.upsert(clustered(40, 16, 4));
		const t = await e.knnAll(5);
		expect(t.ids).toHaveLength(40);
		expect(neighborsOf(t, 0)).toHaveLength(5);
		expect(toNeighborMap(t).get("n0")!.every((r) => Number(r.id.slice(1)) % 4 === 0)).toBe(true);
	});

	it("HNSW matches exact search (recall@10 ≥ 0.95) and keeps working past its initial capacity", async () => {
		const data = clustered(1500, 32, 10);
		const h = engine("hnsw");
		await h.init(32, 256); // smaller than the data: forces growth rebuilds
		expect(h.kind).toBe("hnsw");
		await h.upsert(data);
		const b = engine("brute-force");
		await b.init(32);
		await b.upsert(data);
		let hit = 0;
		for (let i = 0; i < 100; i++) {
			const exact = new Set((await b.search(data[i].vector, 10, data[i].id)).map((r) => r.id));
			for (const r of await h.search(data[i].vector, 10, data[i].id)) if (exact.has(r.id)) hit++;
		}
		expect(hit / 1000).toBeGreaterThanOrEqual(0.95);
	});

	it("falls back to exact search for small vaults only", async () => {
		const small = engine("broken-hnsw");
		await small.init(8, 100);
		expect(small.kind).toBe("brute-force");
		expect(small.fallbackReason).toContain("wasm failed");

		await expect(engine("broken-hnsw", 50).init(8, 1000)).rejects.toThrow(/could not be loaded/);
		const capped = engine("broken-hnsw", 20);
		await capped.init(8, 30);
		await expect(capped.upsert(clustered(25, 8, 2))).rejects.toThrow(/too large/);
	});
});

class FakeClient {
	running = false;
	ids = new Set<string>();
	upserts = 0;
	inits = 0;
	async init() {
		this.running = true;
		this.ids.clear();
		this.inits++;
		return this.stats();
	}
	vectors = new Map<string, Float32Array>();
	async upsert(items: { id: string; vector: Float32Array }[]) {
		this.upserts += items.length;
		items.forEach((i) => this.vectors.set(i.id, i.vector));
		items.forEach((i) => this.ids.add(i.id));
		return this.stats();
	}
	async remove(ids: string[]) {
		ids.forEach((i) => this.ids.delete(i));
		return this.stats();
	}
	async stats() {
		return { kind: "fake", size: this.ids.size, fallbackReason: null };
	}
}

describe("VectorIndexService", () => {
	it("rebuilds once, then sends only changes", async () => {
		const cache = new EmbeddingCache(nullStore, "m", "v", 4);
		const vec = () => Float32Array.from([1, 0, 0, 0]);
		for (const id of ["a", "b", "c"]) cache.set({ noteId: id, contentHash: "h1", documentVector: vec() });
		const client = new FakeClient();
		const svc = new VectorIndexService(client as unknown as AnalysisWorkerClient, 4);

		expect(await svc.sync(cache, ["a", "b", "c"])).toMatchObject({ upserted: 3, removed: 0, rebuilt: true });
		expect(await svc.sync(cache, ["a", "b", "c"])).toMatchObject({ upserted: 0, removed: 0, rebuilt: false });

		cache.set({ noteId: "b", contentHash: "h2", documentVector: vec() });
		expect(await svc.sync(cache, ["a", "b"])).toMatchObject({ upserted: 1, removed: 1, rebuilt: false });
		expect([...client.ids].sort()).toEqual(["a", "b"]);

		client.running = false; // worker restarted: rebuild from cache
		expect(await svc.sync(cache, ["a", "b"])).toMatchObject({ upserted: 2, rebuilt: true });
		expect(client.inits).toBe(2);
	});

	it("indexes mean-centred vectors, with the mean taken from content notes only", async () => {
		const cache = new EmbeddingCache(nullStore, "m", "v", 2);
		cache.set({ noteId: "x", contentHash: "h", documentVector: Float32Array.from([1, 0]) });
		cache.set({ noteId: "y", contentHash: "h", documentVector: Float32Array.from([0, 1]) });
		cache.set({ noteId: "card", contentHash: "h", documentVector: Float32Array.from([-1, 0]) });
		const client = new FakeClient();
		const svc = new VectorIndexService(client as unknown as AnalysisWorkerClient, 2);
		await svc.sync(cache, ["x", "y", "card"], { meanIds: ["x", "y"] });
		// mean of x and y is (0.5, 0.5): x → (0.5,-0.5) normalised
		expect([...client.vectors.get("x")!].map((v) => +v.toFixed(4))).toEqual([0.7071, -0.7071]);
		expect([...client.vectors.get("card")!].map((v) => +v.toFixed(4))).toEqual([-0.9487, -0.3162]);
	});

	it("re-centres after large changes", async () => {
		const cache = new EmbeddingCache(nullStore, "m", "v", 2);
		const ids = Array.from({ length: 10 }, (_, i) => `n${i}`);
		ids.forEach((id) => cache.set({ noteId: id, contentHash: "h", documentVector: Float32Array.from([1, 0]) }));
		const client = new FakeClient();
		const svc = new VectorIndexService(client as unknown as AnalysisWorkerClient, 2);
		await svc.sync(cache, ids);
		cache.set({ noteId: "n0", contentHash: "h2", documentVector: Float32Array.from([0, 1]) });
		expect((await svc.sync(cache, ids)).rebuilt).toBe(false);
		ids.slice(1, 4).forEach((id) => cache.set({ noteId: id, contentHash: "h2", documentVector: Float32Array.from([0, 1]) }));
		await svc.sync(cache, ids); // 4 of 10 changed since centring
		expect((await svc.sync(cache, ids)).rebuilt).toBe(true);
	});

	it("centred() and meanVector() helpers", () => {
		expect([...meanVector([Float32Array.from([1, 3]), Float32Array.from([3, 1])], 2)]).toEqual([2, 2]);
		expect(Math.hypot(...centered(Float32Array.from([3, 1]), Float32Array.from([2, 2])))).toBeCloseTo(1, 6);
	});
});
