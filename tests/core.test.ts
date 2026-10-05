import { describe, expect, it } from "vitest";
import { exclusionReason, type ExclusionRules } from "../src/core/exclusion";
import { NoteIdRegistry } from "../src/core/NoteIdRegistry";
import { detectTemplateLines, normalizeLine } from "../src/core/TemplateDetector";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings/Settings";

const rules: ExclusionRules = { excludedFolders: ["Templates", "Daily/"], excludedTags: ["zk-ignore", "private"], configDir: ".obsidian" };
const meta = (path: string, frontmatter: Record<string, unknown> = {}, tags: string[] = []) => ({ path, frontmatter, tags });

describe("exclusionReason", () => {
	it("includes ordinary notes", () => {
		expect(exclusionReason(meta("Notes/Kafka.md"), rules)).toBeNull();
	});
	it("excludes folders, but not folders that only share a prefix", () => {
		expect(exclusionReason(meta("Templates/Daily.md"), rules)).toBe("folder");
		expect(exclusionReason(meta("Daily/2026-10-05.md"), rules)).toBe("folder");
		expect(exclusionReason(meta("Templates old/x.md"), rules)).toBeNull();
	});
	it("excludes zk-ignore frontmatter, tags (incl. nested) and generated indexes", () => {
		expect(exclusionReason(meta("a.md", { "zk-ignore": true }), rules)).toBe("frontmatter");
		expect(exclusionReason(meta("a.md", {}, ["Private/diary"]), rules)).toBe("tag");
		expect(exclusionReason(meta("a.md", {}, ["privateer"]), rules)).toBeNull();
		expect(exclusionReason(meta("Indexes/Planning.md", { "zk-type": "index" }), rules)).toBe("generated-index");
	});
	it("excludes drawings and the config dir", () => {
		expect(exclusionReason(meta("Excalidraw/x.excalidraw.md"), rules)).toBe("drawing");
		expect(exclusionReason(meta("Files/Контент-завод.md", { "excalidraw-plugin": "parsed" }), rules)).toBe("drawing");
		expect(exclusionReason(meta(".obsidian/plugins/x/README.md"), rules)).toBe("config");
	});
});

describe("NoteIdRegistry", () => {
	let n = 0;
	const make = () => new NoteIdRegistry(() => `id${++n}`);

	it("keeps ids across renames and distinguishes duplicate names", () => {
		const r = make();
		const a = r.idFor("A/Note.md");
		const b = r.idFor("B/Note.md");
		expect(a).not.toBe(b);
		r.rename("A/Note.md", "C/Renamed.md");
		expect(r.idFor("C/Renamed.md")).toBe(a);
		expect(r.peek("A/Note.md")).toBeUndefined();
		expect(r.pathOf(a)).toBe("C/Renamed.md");
		r.remove("C/Renamed.md");
		expect(r.pathOf(a)).toBeUndefined();
		expect(r.pathOf(b)).toBe("B/Note.md");
	});

	it("round-trips through serialize/load and prunes missing paths", () => {
		const r = make();
		const id = r.idFor("x.md");
		r.idFor("gone.md");
		r.retainOnly(["x.md"]);
		const r2 = make();
		r2.load(r.serialize());
		expect(r2.size).toBe(1);
		expect(r2.idFor("x.md")).toBe(id);
		expect(r2.isDirty).toBe(false);
	});
});

describe("TemplateDetector", () => {
	it("treats lines differing only in digits as the same", () => {
		expect(normalizeLine("Оценка: 6/10 · Год: 2015")).toBe(normalizeLine("оценка: 8/10 ·  год: 2019"));
	});
	it("needs both a minimum count and a minimum share", () => {
		const bodies = Array.from({ length: 100 }, (_, i) => (i < 4 ? ["Links", "unique " + "x".repeat(i)] : ["unique " + "x".repeat(i)]));
		expect(detectTemplateLines(bodies).size).toBe(0);
		bodies.forEach((b, i) => i < 10 && b.push("Zettel-links"));
		expect(detectTemplateLines(bodies).has("zettel-links")).toBe(true);
	});
});

describe("normalizeSettings", () => {
	it("fills defaults and repairs invalid values", () => {
		const s = normalizeSettings({ excludedFolders: ["Templates/", " ", 3], excludedTags: ["#zk-ignore"], detailLevel: 99, debounceMs: "x" });
		expect(s.excludedFolders).toEqual(["Templates"]);
		expect(s.excludedTags).toEqual(["zk-ignore"]);
		expect(s.detailLevel).toBe(10);
		expect(s.debounceMs).toBe(DEFAULT_SETTINGS.debounceMs);
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
	});
});
