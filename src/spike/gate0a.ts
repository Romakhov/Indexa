// Gate 0a: prove the ML runtime works inside Obsidian.
// model loads from local disk -> RU/EN embeddings -> batch -> semantic check
// -> UI stays responsive -> zero network requests from the worker.

import { cosine } from "../embeddings/EmbeddingProvider";
import type { LocalEmbeddingProvider } from "../embeddings/LocalEmbeddingProvider";

const PAIRS = {
	ru: {
		a: "Как планировать рабочую неделю",
		b: "Система управления задачами на следующие семь дней",
		c: "Как образуются черные дыры",
	},
	en: {
		a: "How to plan your work week",
		b: "A task management system for the next seven days",
		c: "How black holes form",
	},
};

const SAMPLE_PARAGRAPHS = [
	"Kafka consumer groups distribute partitions between consumers; each partition is read by exactly one consumer in the group, and offsets are committed to track progress.",
	"Чтобы неделя не развалилась, в воскресенье выписываю три главных результата, раскладываю задачи по дням и оставляю буфер на непредвиденное.",
	"The James Webb Space Telescope observes in the infrared, which lets it see through dust clouds and detect light from the earliest galaxies.",
	"Для глазури подойдёт смесь полевого шпата, кварца и каолина; обжиг при 1240 градусах даёт матовую поверхность.",
	"PostgreSQL uses MVCC: every transaction sees a snapshot of the data, and VACUUM reclaims space from dead tuples left behind by updates.",
	"Ретроспектива спринта: что получилось, что мешало, какие эксперименты попробуем в следующей итерации.",
	"A Docker image is built from layers; ordering the Dockerfile so rarely changing steps come first keeps the build cache effective.",
	"Чёрная дыра образуется, когда ядро массивной звезды коллапсирует под действием собственной гравитации после исчерпания топлива.",
];

/** Measures main-thread stalls: the worst gap between 16 ms timer ticks. */
function stallMonitor() {
	let last = performance.now();
	let worst = 0;
	const t = window.setInterval(() => {
		const now = performance.now();
		worst = Math.max(worst, now - last);
		last = now;
	}, 16);
	return () => {
		window.clearInterval(t);
		return worst;
	};
}

export async function runGate0a(provider: LocalEmbeddingProvider, extra: Record<string, unknown>) {
	const stopStall = stallMonitor();
	const t0 = performance.now();
	await provider.initialize();
	const initWallMs = performance.now() - t0;

	const sims: Record<string, number> = {};
	for (const [lang, p] of Object.entries(PAIRS)) {
		const [a, b, c] = await provider.embedBatch([p.a, p.b, p.c]);
		sims[`${lang}:A~B`] = cosine(a, b);
		sims[`${lang}:A~C`] = cosine(a, c);
	}
	const [ruA, enA, ruC] = await provider.embedBatch([PAIRS.ru.a, PAIRS.en.a, PAIRS.ru.c]);
	sims["cross:ruA~enA"] = cosine(ruA, enA);
	sims["cross:ruA~ruC"] = cosine(ruA, ruC);

	// throughput: 64 paragraphs, batches of 8
	const texts = Array.from({ length: 64 }, (_, i) => SAMPLE_PARAGRAPHS[i % SAMPLE_PARAGRAPHS.length] + ` (${i})`);
	const tb = performance.now();
	for (let i = 0; i < texts.length; i += 8) await provider.embedBatch(texts.slice(i, i + 8));
	const batchMs = performance.now() - tb;

	// single vs batch equivalence
	const single = await provider.embed(texts[0]);
	const [batched] = await provider.embedBatch([texts[0], texts[1]]);
	const singleVsBatch = cosine(single, batched);

	const worstStallMs = stopStall();

	const checks = {
		modelInitialized: provider.dimensions > 0,
		ruSemantic: sims["ru:A~B"] > sims["ru:A~C"],
		enSemantic: sims["en:A~B"] > sims["en:A~C"],
		crossLingual: sims["cross:ruA~enA"] > sims["cross:ruA~ruC"],
		// q8 dynamic quantization: padding in a batch shifts activations slightly (~0.997)
		batchConsistent: singleVsBatch > 0.995,
		uiResponsive: worstStallMs < 200,
		noNetwork: provider.blockedRequests.length === 0,
	};

	return {
		gate: "0a",
		passed: Object.values(checks).every(Boolean),
		checks,
		dimensions: provider.dimensions,
		backend: provider.initInfo?.backend,
		modelLoadMs: Math.round(provider.initInfo?.loadMs ?? 0),
		initWallMs: Math.round(initWallMs),
		similarities: Object.fromEntries(Object.entries(sims).map(([k, v]) => [k, +v.toFixed(4)])),
		throughput: { texts: texts.length, ms: Math.round(batchMs), textsPerSec: +((texts.length / batchMs) * 1000).toFixed(1) },
		singleVsBatch: +singleVsBatch.toFixed(6),
		worstMainThreadStallMs: Math.round(worstStallMs),
		blockedRequests: provider.blockedRequests,
		memory: (performance as any).memory
			? { usedJSHeapMB: Math.round((performance as any).memory.usedJSHeapSize / 1048576) }
			: undefined,
		...extra,
	};
}
