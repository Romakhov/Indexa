// Seeded classification: use the user's existing indexes as anchors.
// Each index centroid = mean of its member note vectors (+ optionally the
// embedding of the index name). Evaluated leave-one-out on labeled notes,
// then used to propose assignments for unlabeled notes. No LLM involved.

import { cosine } from "../embeddings/EmbeddingProvider";

export interface SeedItem {
	id: string;
	gold: string | null;
	vector: Float32Array;
}

export interface Prediction {
	label: string;
	score: number;
}

function normalize(v: Float32Array): Float32Array {
	let n = 0;
	for (const x of v) n += x * x;
	n = Math.sqrt(n) || 1;
	return v.map((x) => x / n);
}

function add(into: Float32Array, v: Float32Array, sign = 1) {
	for (let i = 0; i < v.length; i++) into[i] += sign * v[i];
}

/** Ranks labels for a vector by similarity to centroids. */
function rank(v: Float32Array, centroids: Map<string, Float32Array>): Prediction[] {
	return [...centroids].map(([label, c]) => ({ label, score: cosine(v, c) })).sort((a, b) => b.score - a.score);
}

export function seededEvaluation(items: SeedItem[], titleVectors: Map<string, Float32Array>, dims: number) {
	const labeled = items.filter((it) => it.gold);
	const sums = new Map<string, Float32Array>();
	const counts = new Map<string, number>();
	for (const it of labeled) {
		const s = sums.get(it.gold!) ?? new Float32Array(dims);
		add(s, it.vector);
		sums.set(it.gold!, s);
		counts.set(it.gold!, (counts.get(it.gold!) ?? 0) + 1);
	}
	const labels = [...new Set([...counts.keys(), ...titleVectors.keys()])];

	const centroidsFor = (useTitle: boolean, exclude?: SeedItem) => {
		const out = new Map<string, Float32Array>();
		for (const label of labels) {
			const s = new Float32Array(dims);
			let n = 0;
			const sum = sums.get(label);
			if (sum) {
				add(s, sum);
				n += counts.get(label)!;
			}
			if (exclude?.gold === label) {
				add(s, exclude.vector, -1);
				n--;
			}
			const tv = titleVectors.get(label);
			if (useTitle && tv) {
				add(s, tv);
				n++;
			}
			if (n > 0) out.set(label, normalize(s));
		}
		return out;
	};

	// leave-one-out accuracy
	const strategies = {
		centroid: (it: SeedItem) => rank(it.vector, centroidsFor(false, it)),
		centroidPlusTitle: (it: SeedItem) => rank(it.vector, centroidsFor(true, it)),
		knnVote: (it: SeedItem) => {
			const near = labeled
				.filter((o) => o !== it)
				.map((o) => ({ o, s: cosine(it.vector, o.vector) }))
				.sort((a, b) => b.s - a.s)
				.slice(0, 7);
			const votes = new Map<string, number>();
			for (const { o, s } of near) votes.set(o.gold!, (votes.get(o.gold!) ?? 0) + s);
			return [...votes].map(([label, score]) => ({ label, score })).sort((a, b) => b.score - a.score);
		},
	};
	const loo: Record<string, { top1: number; top3: number; top1Frequent: number; evaluated: number; evaluatedFrequent: number }> = {};
	const perIndex = new Map<string, { n: number; hit: number }>();
	for (const [name, predict] of Object.entries(strategies)) {
		let top1 = 0;
		let top3 = 0;
		let top1F = 0;
		let nF = 0;
		for (const it of labeled) {
			const preds = predict(it);
			const hit1 = preds[0]?.label === it.gold;
			if (hit1) top1++;
			if (preds.slice(0, 3).some((p) => p.label === it.gold)) top3++;
			if (counts.get(it.gold!)! >= 4) {
				nF++;
				if (hit1) top1F++;
			}
			if (name === "centroidPlusTitle") {
				const s = perIndex.get(it.gold!) ?? { n: 0, hit: 0 };
				s.n++;
				if (hit1) s.hit++;
				perIndex.set(it.gold!, s);
			}
		}
		loo[name] = {
			top1: +(top1 / labeled.length).toFixed(3),
			top3: +(top3 / labeled.length).toFixed(3),
			top1Frequent: +(top1F / Math.max(1, nF)).toFixed(3),
			evaluated: labeled.length,
			evaluatedFrequent: nF,
		};
	}

	// proposals for unlabeled notes: best centroid + margin over the runner-up
	const full = centroidsFor(true);
	const proposals = items
		.filter((it) => !it.gold)
		.map((it) => {
			const r = rank(it.vector, full);
			return { id: it.id, best: r[0], second: r[1], margin: r[0].score - (r[1]?.score ?? 0) };
		});

	return { loo, perIndex, counts, labels, proposals };
}
