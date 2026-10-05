import { describe, expect, it } from "vitest";
import { IncrementalScorer, matchesSignature, significantChange } from "../src/incremental/IncrementalScorer";

function v(a: number, b = -1, mix = 0): Float32Array {
	const x = new Float32Array(6);
	x[a] = 1;
	if (b >= 0) x[b] = mix;
	const n = Math.hypot(...x);
	return x.map((y) => y / n);
}

const vectors = new Map<string, Float32Array>([
	...[0, 1, 2, 3].map((i) => [`p${i}`, v(0, 4, 0.2 * i)] as const),
	...[0, 1, 2, 3].map((i) => [`k${i}`, v(1, 5, 0.45 * i)] as const),
]);
const indexes = [
	{ id: "planning", kind: "topic" as const, memberIds: ["p0", "p1", "p2", "p3"] },
	{ id: "kafka", kind: "topic" as const, memberIds: ["k0", "k1", "k2", "k3"] },
	{ id: "films", kind: "collection" as const, signature: "type: фильм", memberIds: [] },
];
const scorer = new IncrementalScorer(indexes, (id) => vectors.get(id));
const note = (vector: Float32Array, extra: object = {}) => ({ vector, path: "n.md", tags: [], frontmatter: {}, lowContent: false, ...extra });

describe("IncrementalScorer", () => {
	it("suggests the matching index for a new note, with a percentile score", () => {
		const s = scorer.suggest(note(v(0, 4, 0.3)), { max: 3, minPercentile: 0.1 });
		expect(s[0]).toMatchObject({ indexId: "planning", via: "document" });
		expect(s.some((x) => x.indexId === "kafka")).toBe(false);
	});

	it("adds an index through the best section of a long note", () => {
		const s = scorer.suggest(note(v(0, 4, 0.3), { chunks: [{ heading: "Plan", vector: v(0, 4, 0.2) }, { heading: "Kafka", vector: v(1, 5, 0.3) }] }), { max: 3, minPercentile: 0.1 });
		expect(s.map((x) => x.indexId).sort()).toEqual(["kafka", "planning"]);
		expect(s.find((x) => x.indexId === "kafka")).toMatchObject({ via: "chunk", heading: "Kafka" });
	});

	it("matches collections by metadata, also for notes with little text", () => {
		const s = scorer.suggest(note(v(3), { lowContent: true, frontmatter: { type: "Фильм" } }), { max: 3, minPercentile: 0.1 });
		expect(s).toEqual([{ indexId: "films", score: 1, via: "collection" }]);
		expect(matchesSignature("#кино/фильм", { path: "a.md", tags: ["кино/фильм"], frontmatter: {} })).toBe(true);
		expect(matchesSignature("folder: Cinema", { path: "Cinema/a.md", tags: [], frontmatter: {} })).toBe(true);
	});

	it("does not score indexes without enough known member vectors", () => {
		expect(new IncrementalScorer([{ id: "x", kind: "topic", memberIds: ["unknown", "p0"] }], (id) => vectors.get(id)).scoredIndexes).toBe(0);
	});
});

describe("significantChange", () => {
	it("ignores tiny edits and catches real changes of meaning", () => {
		expect(significantChange(v(0, 4, 0.2), v(0, 4, 0.21))).toBe(false);
		expect(significantChange(v(0), v(1))).toBe(true);
		expect(significantChange(undefined, v(0))).toBe(true);
	});
});

import { formatRemaining, StageEta } from "../src/core/eta";

describe("StageEta", () => {
	it("estimates from the stage's own rate and ignores cached work at the start", () => {
		const eta = new StageEta();
		expect(eta.update("Embedding", 5000, 10000, 0)).toBeNull(); // 5000 from cache at once
		expect(eta.update("Embedding", 5100, 10000, 10000)).toBeNull(); // too early
		const ms = eta.update("Embedding", 5300, 10000, 60000)!; // 300 notes per minute
		expect(Math.round(ms / 60000)).toBe(16);
		expect(formatRemaining(ms)).toBe("about 16 min left");
		expect(eta.update("Building vector index", 0, 10000, 61000)).toBeNull(); // new stage resets
		expect(formatRemaining(90 * 60000)).toBe("about 1 h 30 min left");

		// "0" first, then the cached jump: the jump is not counted as speed
		const e2 = new StageEta();
		e2.update("Embedding", 0, 10000, 0);
		e2.update("Embedding", 8800, 10000, 100);
		expect(Math.round(e2.update("Embedding", 9100, 10000, 60100)! / 60000)).toBe(3);
	});
});
