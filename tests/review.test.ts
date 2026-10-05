import { describe, expect, it } from "vitest";
import type { IndexProposal, ProposalSet } from "../src/indexing/types";
import { applyReview, emptyReview, reconcileIds } from "../src/review/ReviewState";

const prop = (id: string, name: string, members: string[], secondary: string[] = [], kind: IndexProposal["kind"] = "topic"): IndexProposal => ({
	id,
	kind,
	name: { primary: name, alternatives: [name + " alt"], keywords: [name.toLowerCase()], confidence: 0.8 },
	members: [...members.map((noteId) => ({ noteId, score: 0.8, primary: true, via: "community" as const })), ...secondary.map((noteId) => ({ noteId, score: 0.3, primary: false, via: "centroid" as const }))],
	confidence: 0.7,
	sampleNoteIds: members.slice(0, 2),
	related: [],
});

const set = (proposals: IndexProposal[], unclassified: string[] = []): ProposalSet => ({
	createdAt: 0,
	proposals,
	unclassified,
	suggestions: {},
	stats: { contentNotes: 0, lowContentNotes: 0, classified: 0, multiIndexNotes: 0, collections: 0, dissolvedSmall: 0 },
});

const base = () => set([prop("a", "Planning", ["n1", "n2", "n3"], ["k1"]), prop("b", "Kafka", ["k1", "k2", "k3"]), prop("c", "Cooking", ["c1", "c2", "c3"])], ["u1"]);

describe("applyReview", () => {
	it("without decisions mirrors the proposals", () => {
		const r = applyReview(base(), emptyReview());
		expect(r.indexes.map((i) => i.name)).toEqual(["Planning", "Kafka", "Cooking"]);
		expect(r.unclassified).toEqual(["u1"]);
		expect(r.decisions).toBe(0);
		// k1 keeps Kafka as primary, Planning as secondary
		expect(r.indexes.find((i) => i.id === "a")!.members.find((m) => m.noteId === "k1")!.primary).toBe(false);
	});

	it("renames, ignores (members fall to unclassified) and counts decisions", () => {
		const review = { ...emptyReview(), names: { a: "Weekly planning" }, ignored: ["c"] };
		const r = applyReview(base(), review);
		expect(r.indexes[0]).toMatchObject({ name: "Weekly planning", renamed: true });
		expect(r.indexes.find((i) => i.id === "c")!.ignored).toBe(true);
		expect(r.unclassified.sort()).toEqual(["c1", "c2", "c3", "u1"]);
		expect(r.decisions).toBe(2);
	});

	it("merges into a target, keeping its name and the union of members", () => {
		const r = applyReview(base(), { ...emptyReview(), mergedInto: { b: "a" } });
		expect(r.indexes.map((i) => i.id)).toEqual(["a", "c"]);
		const a = r.indexes[0];
		expect(a.name).toBe("Planning");
		expect(a.mergedFrom).toEqual(["b"]);
		expect(a.members.map((m) => m.noteId).sort()).toEqual(["k1", "k2", "k3", "n1", "n2", "n3"]);
		expect(a.members.find((m) => m.noteId === "k1")!.primary).toBe(true);
	});

	it("adds and removes notes, also after a merge, and forces a primary index", () => {
		const review = { ...emptyReview(), mergedInto: { b: "a" }, added: { b: ["u1"] }, removed: { a: ["n3"] }, primary: { k1: "c" } };
		const s = base();
		s.proposals[2].members.push({ noteId: "k1", score: 0.2, primary: false, via: "centroid" });
		const r = applyReview(s, review);
		const a = r.indexes.find((i) => i.id === "a")!;
		expect(a.members.some((m) => m.noteId === "u1" && m.manual)).toBe(true);
		expect(a.members.some((m) => m.noteId === "n3")).toBe(false);
		expect(r.unclassified).toContain("n3");
		expect(r.indexes.find((i) => i.id === "c")!.members.find((m) => m.noteId === "k1")!.primary).toBe(true);
		expect(a.members.find((m) => m.noteId === "k1")!.primary).toBe(false);
	});
});

describe("reconcileIds", () => {
	it("keeps old ids for proposals that mostly kept their members", () => {
		const prev = base();
		const next = set([prop("x1", "Planning", ["n1", "n2", "n3", "n4"]), prop("x2", "Kafka", ["k1", "k2", "k9"]), prop("x3", "Travel", ["t1", "t2", "t3"])]);
		next.suggestions = { u1: [{ proposalId: "x1", score: 0.5 }] };
		const r = reconcileIds(prev, next);
		expect(r.proposals.map((p) => p.id)).toEqual(["a", "b", "x3"]);
		expect(r.suggestions.u1[0].proposalId).toBe("a");
	});

	it("never maps two new proposals to one old id and avoids id collisions", () => {
		const prev = set([prop("a", "A", ["1", "2", "3", "4"])]);
		const next = set([prop("p", "A1", ["1", "2", "3"]), prop("a", "A2", ["3", "4", "5"])]);
		const ids = reconcileIds(prev, next).proposals.map((p) => p.id);
		expect(new Set(ids).size).toBe(2);
		expect(ids).toContain("a");
	});
});

describe("reconcileIds with split indexes", () => {
	it("gives a re-formed group the id of the index the user split", () => {
		const parts = [prop("a1", "A1", ["1", "2", "3"]), prop("a2", "A2", ["4", "5", "6"])].map((p) => ({ ...p, splitFrom: "a" }));
		const prev = set([...parts, prop("b", "B", ["7", "8", "9"])]);
		const next = set([prop("x", "A", ["1", "2", "3", "4", "5", "6"]), prop("y", "B", ["7", "8", "9"])]);
		expect(reconcileIds(prev, next).proposals.map((p) => p.id)).toEqual(["a", "b"]);
	});
});
