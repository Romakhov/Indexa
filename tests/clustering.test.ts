import { describe, expect, it } from "vitest";
import { clusterNotes, resolutionForDetail } from "../src/clustering/clusterNotes";
import { DEFAULT_EDGE_WEIGHTS, HybridEdgeScorer, SEMANTIC_ONLY, type NoteFeatures } from "../src/graph/HybridEdgeScorer";
import { buildHybridGraph } from "../src/graph/SemanticGraphBuilder";
import { KeywordExtractor, stem, tokenize } from "../src/keywords/KeywordExtractor";
import type { NeighborTable } from "../src/vectors/NeighborTable";

const f = (o: Partial<NoteFeatures> = {}): NoteFeatures => ({ links: [], tags: [], keywords: [], folder: "", ...o });

describe("KeywordExtractor", () => {
	it("tokenises RU/EN, drops stopwords and collapses inflections", () => {
		expect(tokenize("Планирование недели и планировании задач, это the plan")).toEqual(["планирование", "недели", "планировании", "задач", "plan"]);
		expect(stem("планирование")).toBe(stem("планировании"));
	});

	it("finds distinctive keywords of notes and groups", () => {
		const docs = [
			{ id: "a", text: "Kafka consumer groups partitions Kafka broker" },
			{ id: "b", text: "Kafka retention partitions broker offsets" },
			{ id: "c", text: "Планирование недели приоритеты задачи планирование" },
			{ id: "d", text: "Планирование квартала цели задачи" },
			{ id: "e", text: "Рецепт борща свекла капуста" },
		];
		const kx = new KeywordExtractor(docs);
		expect(kx.noteKeywords("a", 3)).toContain(stem("kafka"));
		expect(kx.groupKeywords(["c", "d"], 2)).toContain("планирование");
	});
});

describe("HybridEdgeScorer", () => {
	it("adds structure on top of semantics and ignores self-links", () => {
		const s = new HybridEdgeScorer([f({ links: [1, 0], tags: ["x"], folder: "A" }), f({ tags: ["x"], folder: "A" }), f({ folder: "B" })], DEFAULT_EDGE_WEIGHTS);
		expect(s.linkPairs()).toEqual([[0, 1]]);
		expect(s.score(0, 1, 0.5)).toBeCloseTo(0.7 * 0.5 + 0.15 + 0.08 + 0.02, 6);
		expect(s.score(0, 2, 0.5)).toBeCloseTo(0.35, 6);
		expect(new HybridEdgeScorer([f(), f()], SEMANTIC_ONLY).score(0, 1, 0.4)).toBeCloseTo(0.4, 6);
	});
});

/** two dense groups {0,1,2} and {3,4,5}; row 6 excluded */
function twoGroups(): NeighborTable {
	const k = 2;
	const nb = [
		[1, 2],
		[0, 2],
		[0, 1],
		[4, 5],
		[3, 5],
		[3, 4],
		[0, 3],
	];
	return {
		ids: ["a", "b", "c", "d", "e", "f", "g"],
		k,
		neighbors: Int32Array.from(nb.flat()),
		scores: Float32Array.from(nb.flat().map(() => 0.5)),
	};
}

describe("buildHybridGraph", () => {
	it("uses kNN edges among included notes and adds link-only edges", () => {
		const table = twoGroups();
		const include = [true, true, true, true, true, true, false];
		const features = table.ids.map(() => f());
		features[2] = f({ links: [3] }); // c -> d bridges the groups
		const { graph, stats } = buildHybridGraph({ table, include, features, weights: DEFAULT_EDGE_WEIGHTS, similarity: () => 0.3 });
		expect(graph.order).toBe(6);
		expect(graph.hasNode("g")).toBe(false);
		expect(stats.knnEdges).toBe(6);
		expect(stats.linkOnlyEdges).toBe(1);
		expect(graph.hasEdge("c", "d")).toBe(true);
	});
});

describe("clusterNotes", () => {
	it("separates the two groups, numbers communities by size, leaves excluded rows at -1", async () => {
		const table = twoGroups();
		const res = await clusterNotes(
			table,
			[true, true, true, true, true, true, false],
			table.ids.map(() => f()),
			() => 0,
			{ weights: SEMANTIC_ONLY, resolution: 1, seed: 1, refineMaxShare: null },
		);
		expect(res.count).toBe(2);
		const c = [...res.community];
		expect(c[0]).toBe(c[1]);
		expect(c[1]).toBe(c[2]);
		expect(c[3]).toBe(c[4]);
		expect(c[0]).not.toBe(c[3]);
		expect(c[6]).toBe(-1);
		expect(new Set(c.slice(0, 6))).toEqual(new Set([0, 1]));
	});

	it("maps detail level monotonically to resolution", () => {
		const r = Array.from({ length: 10 }, (_, i) => resolutionForDetail(i + 1));
		expect(r.every((x, i) => i === 0 || x > r[i - 1])).toBe(true);
		expect(resolutionForDetail(5)).toBe(3);
	});
});
