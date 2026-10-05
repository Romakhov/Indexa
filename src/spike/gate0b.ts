// Gate 0b: prove the whole technical pipeline inside Obsidian.
// note -> embedding -> HNSW -> top-K -> graphology graph -> Louvain -> clusters
// on 100 / 500 / ~2000 notes of a labelled corpus (scripts/make-corpus.mjs).

import type { App } from "obsidian";
import type { ClusterResult } from "../clustering/ClusterEngine";
import { CommunityClusterEngine, seededRandom } from "../clustering/CommunityClusterEngine";
import type { LocalEmbeddingProvider } from "../embeddings/LocalEmbeddingProvider";
import { buildSemanticGraph } from "../graph/SemanticGraphBuilder";
import type { BinaryStore } from "../storage/BinaryStore";
import { BruteForceVectorIndex } from "../vectors/BruteForceVectorIndex";
import { HnswVectorIndex } from "../vectors/HnswVectorIndex";
import type { VectorSearchResult } from "../vectors/VectorIndex";
import { nmi, purity } from "./metrics";
import { stallMonitor } from "./stall";
import { timeSlicer } from "../core/yieldToUi";

const CORPUS = "corpus";
/** stage spans, to attribute long tasks to pipeline stages */
const stages: { name: string; start: number; end: number }[] = [];
const K = 15;


interface ManifestItem {
	file: string;
	topic: string;
	lang: string;
}

/** Spike-only embedding cache: path+length -> vector, persisted as one binary blob. */
class SpikeEmbeddingCache {
	private map = new Map<string, Float32Array>();
	constructor(
		private readonly store: BinaryStore,
		private readonly dims: number,
	) {}
	key(path: string, text: string) {
		return `${path}\u0000${text.length}`;
	}
	get(k: string) {
		return this.map.get(k);
	}
	getByPath(path: string) {
		for (const [k, v] of this.map) if (k.startsWith(path + "\u0000")) return v;
		return undefined;
	}
	set(k: string, v: Float32Array) {
		this.map.set(k, v);
	}
	async load() {
		const meta = await this.store.read("spike-emb.json");
		const bin = await this.store.read("spike-emb.f32");
		if (!meta || !bin) return;
		const keys = JSON.parse(new TextDecoder().decode(meta)) as string[];
		const data = new Float32Array(bin);
		keys.forEach((k, i) => this.map.set(k, data.slice(i * this.dims, (i + 1) * this.dims)));
	}
	async save() {
		const keys = [...this.map.keys()];
		const data = new Float32Array(keys.length * this.dims);
		keys.forEach((k, i) => data.set(this.map.get(k)!, i * this.dims));
		await this.store.write("spike-emb.json", new TextEncoder().encode(JSON.stringify(keys)));
		await this.store.write("spike-emb.f32", data.buffer);
	}
}

function noteText(raw: string, title: string) {
	const body = raw.replace(/^# .*\n+/, "").trim();
	return `${title}\n${body}`.slice(0, 2000);
}

const sameTopK = (a: VectorSearchResult[], b: VectorSearchResult[]) =>
	a.length === b.length && a.every((x, i) => x.id === b[i].id);

async function runSize(
	app: App,
	provider: LocalEmbeddingProvider,
	store: BinaryStore,
	cache: SpikeEmbeddingCache,
	items: ManifestItem[],
) {
	const t: Record<string, number> = {};
	let mark = performance.now();
	const lap = (name: string) => {
		const now = performance.now();
		t[name] = Math.round(now - mark);
		stages.push({ name: `${items.length}:${name}`, start: mark, end: now });
		mark = now;
	};

	// 1. read notes
	const texts: string[] = [];
	for (const it of items) {
		const raw = await app.vault.adapter.read(`${CORPUS}/${it.file}`);
		texts.push(noteText(raw, it.file.replace(/\.md$/, "")));
	}
	lap("readMs");

	// 2. embed (cache first; misses batched, length-sorted to reduce padding)
	const vectors: Float32Array[] = new Array(items.length);
	const misses: number[] = [];
	items.forEach((it, i) => {
		const v = cache.get(cache.key(it.file, texts[i]));
		if (v) vectors[i] = v;
		else misses.push(i);
	});
	misses.sort((a, b) => texts[a].length - texts[b].length);
	for (let i = 0; i < misses.length; i += 8) {
		const batch = misses.slice(i, i + 8);
		const out = await provider.embedBatch(batch.map((j) => texts[j]));
		batch.forEach((j, n) => {
			vectors[j] = out[n];
			cache.set(cache.key(items[j].file, texts[j]), out[n]);
		});
	}
	lap("embedMs");
	const embedded = misses.length;
	const embedPerSec = embedded ? +((embedded / t.embedMs) * 1000).toFixed(1) : null;
	if (embedded) await cache.save();

	// 3. HNSW build (chunked so the UI keeps breathing)
	const ids = items.map((it) => it.file);
	const maybeYield = timeSlicer();
	const hnsw = new HnswVectorIndex(store, `hnsw-${items.length}`);
	await hnsw.initialize(provider.dimensions, items.length * 2);
	for (let i = 0; i < ids.length; i++) {
		await hnsw.add(ids[i], vectors[i]);
		await maybeYield();
	}
	lap("hnswBuildMs");

	// 4. top-K neighbours for every note
	const neighbours = new Map<string, VectorSearchResult[]>();
	for (let i = 0; i < ids.length; i++) {
		neighbours.set(ids[i], (await hnsw.search(vectors[i], K + 1)).filter((r) => r.id !== ids[i]).slice(0, K));
		await maybeYield();
	}
	lap("knnMs");
	const knnLatencyMs = +(t.knnMs / ids.length).toFixed(3);

	// 5. recall vs exact search on a sample (brute force only for measurement)
	const brute = new BruteForceVectorIndex();
	await brute.initialize(provider.dimensions);
	for (let i = 0; i < ids.length; i++) await brute.add(ids[i], vectors[i]);
	await maybeYield();
	const sample = ids.map((_, i) => i).filter((i) => i % Math.max(1, Math.floor(ids.length / 100)) === 0);
	let hit = 0;
	let total = 0;
	for (const i of sample) {
		await maybeYield();
		const exact = new Set((await brute.search(vectors[i], K + 1)).filter((r) => r.id !== ids[i]).slice(0, K).map((r) => r.id));
		for (const r of neighbours.get(ids[i])!) if (exact.has(r.id)) hit++;
		total += exact.size;
	}
	const recallAtK = +(hit / total).toFixed(4);
	lap("recallMs");

	// 6. persistence round trip
	await hnsw.save();
	const saved = (await store.read(`hnsw-${items.length}.f32`))!.byteLength;
	const reloaded = new HnswVectorIndex(store, `hnsw-${items.length}`);
	const tLoad = performance.now();
	const loadedOk = await reloaded.load();
	const reloadMs = Math.round(performance.now() - tLoad);
	let persistEqual = loadedOk;
	for (const i of sample) {
		if (!persistEqual) break;
		persistEqual = sameTopK(await hnsw.search(vectors[i], K), await reloaded.search(vectors[i], K));
	}
	// incremental ops on the reloaded index
	await reloaded.remove(ids[0]);
	const removedGone = !(await reloaded.search(vectors[0], K)).some((r) => r.id === ids[0]);
	await reloaded.add(ids[0], vectors[0]);
	const reAddedFound = (await reloaded.search(vectors[0], 1))[0]?.id === ids[0];
	lap("persistMs");

	// 7. graph
	const graph = await buildSemanticGraph(neighbours, { rescale: true });
	const graphRaw = await buildSemanticGraph(neighbours, { rescale: false });
	lap("graphMs");

	// 8. communities
	const engine = new CommunityClusterEngine();
	const labels = items.map((it) => it.topic);
	const runs: ClusterResult[] = [];
	for (const seed of [1, 2, 3]) runs.push(await engine.cluster(graph, { resolution: 1, seed }));
	lap("louvain3xMs");
	const again = await engine.cluster(graph, { resolution: 1, seed: 1 });
	const part = (r: { communities: Map<string, number> }) => ids.map((id) => r.communities.get(id)!);
	const deterministic = part(again).every((c, i) => c === part(runs[0])[i]);
	const seedStabilityNmi = +((nmi(part(runs[0]), part(runs[1])) + nmi(part(runs[0]), part(runs[2]))) / 2).toFixed(4);
	const raw = await engine.cluster(graphRaw, { resolution: 1, seed: 1 });

	const sizes = [...part(runs[0]).reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map<number, number>()).values()].sort((a, b) => b - a);

	return {
		notes: items.length,
		newlyEmbedded: embedded,
		embedPerSec,
		timingsMs: t,
		knnLatencyMs,
		hnsw: { recallAtK, k: K, persistedBytes: saved, reloadMs, persistReloadEqual: persistEqual, removeWorks: removedGone, reAddWorks: reAddedFound },
		graph: { nodes: graph.order, edges: graph.size, avgDegree: +((2 * graph.size) / graph.order).toFixed(1), fullPairwiseEdges: (ids.length * (ids.length - 1)) / 2 },
		louvain: {
			communities: runs[0].count,
			modularity: +runs[0].modularity.toFixed(4),
			sizesTop10: sizes.slice(0, 10),
			deterministicSameSeed: deterministic,
			seedStabilityNmi,
		},
		qualityVsTopics: {
			nmiRescaled: +nmi(labels, part(runs[0])).toFixed(4),
			purityRescaled: +purity(labels, part(runs[0])).toFixed(4),
			nmiRawWeights: +nmi(labels, part(raw)).toFixed(4),
			communitiesRawWeights: raw.count,
		},
	};
}

/**
 * Scale probe without embedding cost: n synthetic vectors made from the cached
 * corpus vectors plus small Gaussian noise (re-normalised). Measures that the
 * ANN -> sparse graph -> Louvain path stays near-linear.
 */
async function scaleProbe(store: BinaryStore, base: Float32Array[], n: number) {
	const rand = seededRandomNormal(7);
	const dims = base[0].length;
	const vecs: Float32Array[] = [];
	const genYield = timeSlicer();
	for (let i = 0; i < n; i++) {
		await genYield();
		const src = base[i % base.length];
		const v = new Float32Array(dims);
		let norm = 0;
		for (let d = 0; d < dims; d++) {
			v[d] = src[d] + 0.02 * rand();
			norm += v[d] * v[d];
		}
		norm = Math.sqrt(norm);
		for (let d = 0; d < dims; d++) v[d] /= norm;
		vecs.push(v);
	}
	const ids = vecs.map((_, i) => `s${i}`);
	const t: Record<string, number> = {};
	let mark = performance.now();
	const lap = (k: string) => {
		const now = performance.now();
		t[k] = Math.round(now - mark);
		mark = now;
	};
	const maybeYield = timeSlicer();
	const hnsw = new HnswVectorIndex(store, `scale-${n}`);
	await hnsw.initialize(dims, n * 2);
	for (let i = 0; i < n; i++) {
		await hnsw.add(ids[i], vecs[i]);
		await maybeYield();
	}
	lap("hnswBuildMs");
	const neighbours = new Map<string, VectorSearchResult[]>();
	for (let i = 0; i < n; i++) {
		neighbours.set(ids[i], (await hnsw.search(vecs[i], K + 1)).filter((r) => r.id !== ids[i]).slice(0, K));
		await maybeYield();
	}
	lap("knnMs");
	const graph = await buildSemanticGraph(neighbours);
	lap("graphMs");
	const res = await new CommunityClusterEngine().cluster(graph, { resolution: 1, seed: 1 });
	lap("louvainMs");
	await hnsw.save();
	lap("saveMs");
	const reloaded = new HnswVectorIndex(store, `scale-${n}`);
	await reloaded.load();
	lap("reloadMs");
	await store.remove(`scale-${n}.f32`);
	await store.remove(`scale-${n}.json`);
	return { vectors: n, timingsMs: t, edges: graph.size, fullPairwiseEdges: (n * (n - 1)) / 2, communities: res.count };
}

function seededRandomNormal(seed: number) {
	const u = seededRandom(seed);
	return () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
}

export async function runGate0b(app: App, provider: LocalEmbeddingProvider, store: BinaryStore, sizes = [100, 500, 2000], scaleN = 10000) {
	const manifest = JSON.parse(await app.vault.adapter.read(`${CORPUS}/manifest.json`)) as ManifestItem[];
	const stopStall = stallMonitor();
	await provider.initialize();
	const cache = new SpikeEmbeddingCache(store, provider.dimensions);
	await cache.load();

	const results = [];
	for (const n of sizes) results.push(await runSize(app, provider, store, cache, manifest.slice(0, n)));
	const baseVectors = manifest.map((it) => cache.getByPath(it.file)).filter((v): v is Float32Array => !!v);
	const scale = scaleN > 0 ? await scaleProbe(store, baseVectors, scaleN) : null;
	const stall = stopStall();

	const checks = {
		hnswRecall: results.every((r) => r.hnsw.recallAtK >= 0.95),
		persistReload: results.every((r) => r.hnsw.persistReloadEqual),
		incrementalOps: results.every((r) => r.hnsw.removeWorks && r.hnsw.reAddWorks),
		graphSparse: results.every((r) => r.graph.edges <= r.notes * K),
		louvainDeterministic: results.every((r) => r.louvain.deterministicSameSeed),
		louvainStableAcrossSeeds: results.every((r) => r.louvain.seedStabilityNmi >= 0.7),
		scaleSparse: !scale || scale.edges <= scale.vectors * K,
		uiResponsive: stall.worstMs < 200,
		noNetwork: provider.blockedRequests.length === 0,
	};
	return {
		gate: "0b",
		passed: Object.values(checks).every(Boolean),
		checks,
		mainThreadLongTasks: {
			...stall,
			entries: stall.entries.map((e) => ({ ...e, stage: stages.find((st) => e.start >= st.start - 1 && e.start <= st.end)?.name ?? "other" })),
		},
		blockedRequests: provider.blockedRequests,
		memory: (performance as any).memory ? { usedJSHeapMB: Math.round((performance as any).memory.usedJSHeapSize / 1048576) } : undefined,
		results,
		scale,
	};
}
