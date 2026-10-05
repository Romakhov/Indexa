// Dev experiment: neighbour quality vs the user's manual indexes for several
// ways of building note vectors (hubness reduction).

import type { App } from "obsidian";
import type { AnalysisResult } from "../core/AnalysisRunner";
import type { EmbeddingCache } from "../embeddings/EmbeddingCache";

function norm(v: Float32Array) {
	let s = 0;
	for (const x of v) s += x * x;
	const n = Math.sqrt(s) || 1;
	return v.map((x) => x / n);
}

function gold(app: App, path: string): string | null {
	const f = app.vault.getFileByPath(path);
	const raw: unknown = f ? app.metadataCache.getFileCache(f)?.frontmatter?.["Zettel-link"] : undefined;
	const first: unknown = Array.isArray(raw) ? (raw[0] as unknown) : raw;
	const m = typeof first === "string" ? first.match(/\[\[([^\]|#]+)/) : null;
	return m ? m[1].split("/").pop()!.trim() : null;
}

export function hubnessExperiment(app: App, result: AnalysisResult, cache: EmbeddingCache, k = 5) {
	const notes = result.notes.filter((n) => !result.processed.find((p) => p.noteId === n.id)?.lowContent);
	const entries = notes.map((n) => cache.peek(n.id)!).filter(Boolean);
	const labels = notes.map((n) => gold(app, n.path));
	const d = entries[0].documentVector.length;

	const variants: Record<string, Float32Array[]> = {
		blend: entries.map((e) => e.documentVector),
		chunkMean: entries.map((e) => {
			if (!e.chunks?.length) return e.documentVector;
			const m = new Float32Array(d);
			for (const c of e.chunks) for (let i = 0; i < d; i++) m[i] += c.vector[i];
			return norm(m);
		}),
	};
	const center = (vs: Float32Array[]) => {
		const mean = new Float32Array(d);
		for (const v of vs) for (let i = 0; i < d; i++) mean[i] += v[i] / vs.length;
		return vs.map((v) => norm(v.map((x, i) => x - mean[i])));
	};
	variants.blendCentered = center(variants.blend);
	variants.chunkMeanCentered = center(variants.chunkMean);

	const out: Record<string, unknown> = {};
	for (const [name, vs] of Object.entries(variants)) {
		let agree = 0;
		let total = 0;
		const inDegree = new Array<number>(vs.length).fill(0);
		for (let i = 0; i < vs.length; i++) {
			const sims = vs.map((v, j) => {
				if (j === i) return -2;
				let s = 0;
				for (let t = 0; t < d; t++) s += v[t] * vs[i][t];
				return s;
			});
			const top = sims.map((s, j) => [s, j] as const).sort((a, b) => b[0] - a[0]).slice(0, k);
			for (const [, j] of top) inDegree[j]++;
			if (labels[i]) for (const [, j] of top) if (labels[j]) {
				total++;
				if (labels[j] === labels[i]) agree++;
			}
		}
		const sorted = [...inDegree].sort((a, b) => b - a);
		out[name] = {
			labelAgreementAtK: +(agree / total).toFixed(3),
			// hubness: how often the most popular notes appear as someone's neighbour
			maxInDegree: sorted[0],
			top1PercentShare: +(sorted.slice(0, Math.ceil(vs.length / 100)).reduce((a, b) => a + b, 0) / (vs.length * k)).toFixed(3),
			zeroInDegree: inDegree.filter((x) => x === 0).length,
		};
	}
	return { notes: vs(entries.length), labeled: labels.filter(Boolean).length, k, variants: out };
}
const vs = (n: number) => n;
