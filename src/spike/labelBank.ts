// Dev experiment: non-generative topic naming by matching each group's centre
// against a bank of topic labels embedded with the same local model.

import { TOPIC_LABELS_RU } from "../indexing/topicLabels";
import type IndexaPlugin from "../main";

const dot = (a: Float32Array, b: Float32Array) => {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] * b[i];
	return s;
};

export async function labelBankExperiment(plugin: IndexaPlugin, labels = TOPIC_LABELS_RU) {
	const r = plugin.lastResult;
	if (!r?.proposals) throw new Error("Run Analyze vault first");
	const index = plugin.getVectorIndex();
	const cache = plugin.getCache();
	const t0 = performance.now();
	const raw = await plugin.getProvider().embedBatch(labels);
	const labelVecs = raw.map((v) => index.centre(v)!);
	const embedMs = Math.round(performance.now() - t0);

	const rows = [];
	for (const p of r.proposals.proposals.filter((x) => x.kind === "topic")) {
		const vs = p.members
			.filter((m) => m.primary)
			.map((m) => cache.peek(m.noteId))
			.filter((e) => e !== undefined)
			.map((e) => index.centre(e.documentVector)!);
		const c = new Float32Array(vs[0].length);
		for (const v of vs) for (let i = 0; i < c.length; i++) c[i] += v[i];
		const n = Math.hypot(...c) || 1;
		for (let i = 0; i < c.length; i++) c[i] /= n;
		const ranked = labels.map((l, i) => ({ l, s: dot(c, labelVecs[i]) })).sort((a, b) => b.s - a.s);
		rows.push({ current: p.name.primary ?? "Unnamed", top: ranked.slice(0, 3).map((x) => `${x.l} (${x.s.toFixed(2)})`), margin: +(ranked[0].s - ranked[1].s).toFixed(3) });
	}
	return { labels: labels.length, embedMs, rows };
}
