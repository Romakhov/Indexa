import { describe, expect, it } from "vitest";
import { detectCollections } from "../src/indexing/CollectionDetector";
import { classify, confidenceForThreshold, type ClassifierNote } from "../src/indexing/IndexClassifier";
import { isGenericName, suggestIndexName, TitleVocabulary } from "../src/indexing/IndexNamingEngine";
import { buildProposals, type ProposalNote } from "../src/indexing/IndexProposalEngine";
import { KeywordExtractor } from "../src/keywords/KeywordExtractor";

/** unit vector along axis `a` (+ a little of axis `b`) in 6-d */
function v(a: number, b = -1, mix = 0): Float32Array {
	const x = new Float32Array(6);
	x[a] = 1;
	if (b >= 0) x[b] = mix;
	const n = Math.hypot(...x);
	return x.map((y) => y / n);
}

describe("CollectionDetector", () => {
	it("groups low-content notes by type, then tag; folders need stronger evidence", () => {
		const notes = [
			...Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, path: `Cinema/m${i}.md`, tags: ["кино/фильм"], frontmatter: { type: "фильм" }, lowContent: true })),
			{ id: "review", path: "Cinema/review.md", tags: ["кино/фильм"], frontmatter: { type: "фильм" }, lowContent: false },
			...Array.from({ length: 3 }, (_, i) => ({ id: `f${i}`, path: `Small/f${i}.md`, tags: [], frontmatter: {}, lowContent: true })),
			{ id: "plain", path: "x.md", tags: [], frontmatter: {}, lowContent: false },
		];
		const cols = detectCollections(notes, { minNotes: 3, minLowContentShare: 0.5, minFolderNotes: 5, minFolderLowContentShare: 0.8 });
		expect(cols).toHaveLength(1);
		expect(cols[0].signature).toBe("type: фильм");
		expect(cols[0].noteIds).toContain("review"); // the collection owns its content notes too
	});
});

describe("IndexNamingEngine", () => {
	it("never proposes generic names", () => {
		expect(isGenericName("Misc")).toBe(true);
		expect(isGenericName("Разное")).toBe(true);
		expect(isGenericName("Kafka")).toBe(false);
	});

	it("prefers a shared title phrase in the user's own form", () => {
		const titles = ["Манипуляция сознанием через авторитет", "Методы манипуляции", "Термин манипуляции сознанием", "Чувства в пропаганде", "Манипуляция сознанием и язык"];
		const name = suggestIndexName({
			centralTitles: titles,
			keywords: ["манипуляции", "пропаганде", "сознания"],
			tagShares: [],
			vocabulary: new TitleVocabulary([...titles, "Планирование на год", "Черные дыры"]),
			taken: new Set(),
		});
		expect(name.primary).toBe("Манипуляция сознанием");
		expect(name.confidence).toBeGreaterThan(0.5);
	});

	it("ignores tags that are everywhere in the vault", () => {
		const name = suggestIndexName({ centralTitles: [], keywords: [], tagShares: [{ tag: "note", share: 1 }, { tag: "kafka", share: 0.9 }], vaultTagShare: new Map([["note", 0.9], ["kafka", 0.05]]), taken: new Set() });
		expect(name.primary).toBe("Kafka");
	});

	it("returns Unnamed (no primary) with keywords when confidence is low", () => {
		const name = suggestIndexName({ centralTitles: ["a1", "b2"], keywords: [], tagShares: [], taken: new Set() });
		expect(name.primary).toBeUndefined();
	});
});

describe("IndexClassifier", () => {
	// two topics (axes 0 and 1) plus a loner on axis 2 that Louvain put into topic A
	const notes: ClassifierNote[] = [
		...["a1", "a2", "a3", "a4"].map((id, i) => ({ id, vector: v(0, 3, 0.1 * i), neighbors: ["a1", "a2", "a3", "a4"].filter((x) => x !== id) })),
		...["b1", "b2", "b3", "b4"].map((id, i) => ({ id, vector: v(1, 4, 0.3 * i), neighbors: ["b1", "b2", "b3", "b4"].filter((x) => x !== id) })),
		{ id: "loner", vector: v(2), neighbors: ["b1", "a1", "b2"] },
		// a long note about A whose second section is clearly about B (spec §43)
		{ id: "weekly", vector: v(0, 1, 0.3), chunks: [{ heading: "Plan", vector: v(0) }, { heading: "Kafka", vector: v(1, 4, 0.45) }], neighbors: ["a1", "a2", "b1"] },
	];
	const communities = new Map(notes.map((n) => [n.id, n.id.startsWith("b") ? 1 : 0]));

	it("peels the loner off into unclassified and keeps the topics", () => {
		const res = classify(notes, communities, { minNotes: 3, minConfidence: 0.3, secondaryPercentile: 0.1 });
		expect(res.indexes).toHaveLength(2);
		expect(res.unclassified).toContain("loner");
		expect(res.memberships.get("a1")![0]).toMatchObject({ primary: true, via: "community" });
	});

	it("gives a long note a secondary index through its chunk", () => {
		const res = classify(notes, communities, { minNotes: 3, minConfidence: 0.3, secondaryPercentile: 0.1 });
		const m = res.memberships.get("weekly")!;
		const b = res.indexes.indexOf(1);
		expect(m[0].primary).toBe(true);
		expect(m.some((x) => !x.primary && x.index === b && x.via === "chunk" && x.heading === "Kafka")).toBe(true);
	});

	it("maps the threshold setting to a confidence cut-off", () => {
		expect(confidenceForThreshold(0)).toBe(0.2);
		expect(confidenceForThreshold(25)).toBe(0.3);
		expect(confidenceForThreshold(100)).toBe(0.6);
	});
});

describe("buildProposals", () => {
	it("produces named topics, collections and unclassified notes", () => {
		const mk = (id: string, title: string, axis: number, group: string[]): ProposalNote => ({
			id,
			path: `${id}.md`,
			title,
			tags: [],
			frontmatter: {},
			lowContent: false,
			vector: v(axis, 5, Number(id.slice(1)) * 0.05),
			neighbors: group.filter((x) => x !== id),
		});
		const a = ["p1", "p2", "p3", "p4"];
		const k = ["k1", "k2", "k3", "k4"];
		const notes: ProposalNote[] = [
			mk("p1", "Планирование недели", 0, a),
			mk("p2", "Планирование года", 0, a),
			mk("p3", "Планирование квартала", 0, a),
			mk("p4", "Обзор целей", 0, a),
			mk("k1", "Kafka consumer groups", 1, k),
			mk("k2", "Kafka retention", 1, k),
			mk("k3", "Kafka exactly once", 1, k),
			mk("k4", "Брокеры", 1, k),
			...Array.from({ length: 4 }, (_, i) => ({ id: `film${i}`, path: `Cinema/film${i}.md`, title: `Film ${i}`, tags: [], frontmatter: { type: "фильм" }, lowContent: true, neighbors: [] })),
			{ id: "orphan", path: "orphan.md", title: "Orphan", tags: [], frontmatter: {}, lowContent: true, neighbors: [] },
		];
		const communities = new Map([...a.map((id) => [id, 0] as const), ...k.map((id) => [id, 1] as const)]);
		const kx = new KeywordExtractor(notes.filter((n) => !n.lowContent).map((n) => ({ id: n.id, text: n.title })));
		const set = buildProposals(notes, communities, kx, { minNotes: 3, maxIndexesPerNote: 3, minConfidence: 0.2 });
		const names = set.proposals.map((p) => p.name.primary);
		expect(names).toContain("Планирование");
		expect(names).toContain("Kafka");
		expect(set.proposals.find((p) => p.kind === "collection")?.members).toHaveLength(4);
		expect(set.unclassified).toContain("orphan");
		// ids are stable for the same core members
		const again = buildProposals(notes, communities, kx, { minNotes: 3, maxIndexesPerNote: 3, minConfidence: 0.2 });
		expect(again.proposals.map((p) => p.id)).toEqual(set.proposals.map((p) => p.id));
	});
});
