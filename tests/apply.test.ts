import { describe, expect, it } from "vitest";
import { indexFileName, planApply, type VaultView } from "../src/indexing/IndexBuilder";
import type { EffectiveIndex } from "../src/review/ReviewState";

const ix = (id: string, name: string, members: [string, boolean][], extra: Partial<EffectiveIndex> = {}): EffectiveIndex => ({
	id,
	kind: "topic",
	name,
	renamed: false,
	unnamed: false,
	nameOptions: [],
	keywords: ["kw1", "kw2"],
	confidence: 0.7,
	members: members.map(([noteId, primary]) => ({ noteId, score: 0.8, primary, via: "community" })),
	sampleNoteIds: [],
	related: [],
	ignored: false,
	mergedFrom: [],
	...extra,
});

function vault(files: Record<string, { generated?: boolean; note?: boolean; index?: boolean }>, paths: Record<string, string>): VaultView {
	return {
		exists: (p) => p in files,
		isGenerated: (p) => !!files[p]?.generated,
		notePath: (id) => paths[id],
		notesWithOwnKeys: () => Object.entries(files).filter(([, f]) => f.note).map(([p]) => p),
		generatedIndexes: () => Object.entries(files).filter(([, f]) => f.generated).map(([p]) => p),
	};
}

const opts = { indexFolder: "Indexes", moveNotes: false, moveTarget: "Zettelkasten", previousIndexFiles: {} };

describe("indexFileName", () => {
	it("makes safe, readable file names", () => {
		expect(indexFileName("AI: agents / tools?")).toBe("AI agents tools");
		expect(indexFileName("  ")).toBe("Untitled index");
	});
});

describe("planApply", () => {
	const paths = { n1: "A/n1.md", n2: "B/n2.md", n3: "n3.md" };

	it("creates index notes, assigns primary first, and de-duplicates file names", () => {
		const plan = planApply([ix("a", "Planning", [["n1", true], ["n2", false]]), ix("b", "Planning", [["n2", true], ["n3", true]]), ix("c", "Ignored", [["n3", false]], { ignored: true })], vault({}, paths), opts);
		expect(plan.indexes.map((i) => [i.path, i.action])).toEqual([
			["Indexes/Planning.md", "create"],
			["Indexes/Planning (2).md", "create"],
		]);
		expect(plan.notes.find((n) => n.noteId === "n2")!.indexIds).toEqual(["b", "a"]);
		expect(plan.notes.find((n) => n.noteId === "n3")!.indexIds).toEqual(["b"]);
	});

	it("updates the user's own note with the same name instead of duplicating it", () => {
		const plan = planApply([ix("a", "Астрофизика", [["n1", true]])], vault({ "Indexes/Астрофизика.md": {} }, paths), opts);
		expect(plan.indexes[0]).toMatchObject({ action: "update", userNote: true });
	});

	it("renames the generated file of an index the user renamed after an earlier Apply", () => {
		const plan = planApply([ix("a", "Space", [["n1", true]])], vault({ "Indexes/Astro.md": { generated: true, index: true } }, paths), { ...opts, previousIndexFiles: { a: "Indexes/Astro.md" } });
		expect(plan.indexes[0]).toMatchObject({ path: "Indexes/Space.md", renameFrom: "Indexes/Astro.md", action: "update", userNote: false });
		expect(plan.staleIndexes).toEqual([]);
	});

	it("cleans up notes and generated indexes that are no longer used", () => {
		const v = vault({ "old.md": { note: true }, "n3.md": { note: true }, "Indexes/Gone.md": { generated: true } }, paths);
		const plan = planApply([ix("a", "Planning", [["n3", true]])], v, opts);
		expect(plan.clearNotes).toEqual(["old.md"]);
		expect(plan.staleIndexes).toEqual(["Indexes/Gone.md"]);
	});

	it("skips deleted notes and names unnamed topics by keywords", () => {
		const plan = planApply([ix("a", "Unnamed topic", [["n1", true], ["gone", true]], { unnamed: true })], vault({}, paths), opts);
		expect(plan.indexes[0].path).toBe("Indexes/Topic — kw1, kw2.md");
		expect(plan.skipped).toEqual([{ noteId: "gone", reason: "note no longer exists" }]);
	});

	it("plans optional moves without overwriting", () => {
		const v = vault({ "Zettelkasten/n2.md": {} }, paths);
		const plan = planApply([ix("a", "P", [["n1", true], ["n2", true]])], v, { ...opts, moveNotes: true });
		expect(plan.moves).toEqual([{ noteId: "n1", from: "A/n1.md", to: "Zettelkasten/n1.md" }]);
		expect(plan.skipped[0].reason).toContain("already exists");
	});
});
