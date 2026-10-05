import { describe, expect, it } from "vitest";
import { readOwnKeyLines, restoreOwnKeyLines, setOwnKeys } from "../src/obsidian/FrontmatterManager";
import { newIndexNote, readSection, SECTION_END, SECTION_START, setSection } from "../src/obsidian/MarkdownWriter";

const userFm = [
	"---",
	"# my comment",
	"title: 'Kafka: consumer groups'",
	"tags:",
	"  - tech",
	"  - streaming",
	"aliases: [Kafka CG]",
	"rating: 5",
	"---",
	"# Kafka",
	"Body text.",
	"",
].join("\n");

describe("FrontmatterManager.setOwnKeys", () => {
	it("adds Indexa keys and leaves every other byte of the user's YAML alone", () => {
		const out = setOwnKeys(userFm, { "zk-type": "note", "zk-indexes": ["[[Backend]]", "[[Indexes/Kafka|Kafka]]"] });
		const before = userFm.split("---\n")[1];
		expect(out.startsWith("---\n" + before)).toBe(true);
		expect(out).toContain('zk-type: note\nzk-indexes:\n  - "[[Backend]]"\n  - "[[Indexes/Kafka|Kafka]]"\n---\n# Kafka\nBody text.\n');
	});

	it("replaces its own keys in place and is idempotent", () => {
		const once = setOwnKeys(userFm, { "zk-type": "note", "zk-indexes": ["[[A]]"] });
		const twice = setOwnKeys(once, { "zk-type": "note", "zk-indexes": ["[[B]]", "[[C]]"] });
		expect(twice).toBe(setOwnKeys(userFm, { "zk-type": "note", "zk-indexes": ["[[B]]", "[[C]]"] }));
		expect(setOwnKeys(twice, { "zk-type": "note", "zk-indexes": ["[[B]]", "[[C]]"] })).toBe(twice);
	});

	it("removing its keys restores the original text exactly", () => {
		const added = setOwnKeys(userFm, { "zk-type": "note", "zk-indexes": ["[[A]]"] });
		expect(setOwnKeys(added, { "zk-type": undefined, "zk-indexes": undefined })).toBe(userFm);
	});

	it("creates and fully removes a frontmatter in a note that had none", () => {
		const plain = "# Title\n\nText\n";
		const added = setOwnKeys(plain, { "zk-type": "note", "zk-indexes": ["[[A]]"] });
		expect(added).toBe('---\nzk-type: note\nzk-indexes:\n  - "[[A]]"\n---\n# Title\n\nText\n');
		expect(setOwnKeys(added, { "zk-type": undefined, "zk-indexes": undefined })).toBe(plain);
	});

	it("handles CRLF, BOM, an empty frontmatter and inline-array forms", () => {
		const crlf = "﻿---\r\ntags: [a]\r\nzk-indexes: [\"[[Old]]\"]\r\n---\r\nBody\r\n";
		const out = setOwnKeys(crlf, { "zk-indexes": ["[[New]]"] });
		expect(out).toBe('﻿---\r\ntags: [a]\r\nzk-indexes:\r\n  - "[[New]]"\r\n---\r\nBody\r\n');
		expect(setOwnKeys("---\n---\nBody\n", { "zk-type": "note" })).toBe("---\nzk-type: note\n---\nBody\n");
	});

	it("does not treat a similarly named user key as its own", () => {
		const t = "---\nzk-indexes-backup: x\nzk-type-user: y\n---\n";
		expect(setOwnKeys(t, { "zk-type": undefined, "zk-indexes": undefined })).toBe(t);
	});

	it("captures and restores raw key lines (surgical undo)", () => {
		const orig = "---\nzk-indexes:\n  - \"[[Mine]]\" # hand-written\nother: 1\n---\nBody\n";
		const raw = readOwnKeyLines(orig, "zk-indexes");
		expect(raw).toEqual(['zk-indexes:', '  - "[[Mine]]" # hand-written']);
		const changed = setOwnKeys(orig, { "zk-indexes": ["[[Generated]]"] });
		const restored = restoreOwnKeyLines(changed, "zk-indexes", raw);
		expect(restored).toContain('zk-indexes:\n  - "[[Mine]]" # hand-written');
		expect(restored).not.toContain("Generated");
	});
});

describe("MarkdownWriter", () => {
	it("appends, replaces and removes a controlled section without touching the rest", () => {
		const text = "# Note\n\nUser text.\n";
		const added = setSection(text, "Indexes: [[A]]");
		expect(added).toBe(`# Note\n\nUser text.\n\n${SECTION_START}\nIndexes: [[A]]\n${SECTION_END}\n`);
		expect(readSection(added)).toBe("Indexes: [[A]]");
		const replaced = setSection(added, "Indexes: [[B]]");
		expect(replaced).toBe(added.replace("[[A]]", "[[B]]"));
		expect(setSection(replaced, null)).toBe(text);
	});

	it("keeps user text after the section", () => {
		const t = `Top\n${SECTION_START}\nold\n${SECTION_END}\nUser after\n`;
		expect(setSection(t, "new")).toBe(`Top\n${SECTION_START}\nnew\n${SECTION_END}\nUser after\n`);
		expect(setSection(t, null)).toBe("Top\nUser after\n");
	});

	it("builds a generated index note in the spec format", () => {
		const n = newIndexNote({ name: "Planning", notes: ["[[Weekly planning]]", "[[GTD]]"], related: ["[[Productivity]]"] });
		expect(n.startsWith("---\nzk-type: index\nzk-generated: true\nzk-version: 1\n---\n\n# Planning\n")).toBe(true);
		expect(readSection(n)).toBe("## Notes\n\n- [[Weekly planning]]\n- [[GTD]]\n\n## Related indexes\n\n- [[Productivity]]");
	});
});
