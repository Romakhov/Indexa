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
