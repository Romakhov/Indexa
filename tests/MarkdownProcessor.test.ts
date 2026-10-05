import { describe, expect, it } from "vitest";
import { bodyLines, cleanMarkdown, LOW_CONTENT_CHARS, processNote } from "../src/core/MarkdownProcessor";
import { detectTemplateLines } from "../src/core/TemplateDetector";
import type { NoteDocument } from "../src/types/NoteDocument";

const doc = (content: string, extra: Partial<NoteDocument> = {}): NoteDocument => ({
	id: "id",
	path: "Note.md",
	title: "Kafka",
	content,
	headings: [],
	tags: [],
	links: [],
	aliases: [],
	frontmatter: {},
	modifiedAt: 0,
	...extra,
});

describe("cleanMarkdown", () => {
	it("drops frontmatter, code, dataview, embeds, urls and comments", () => {
		const md = [
			"---",
			"tags: [a]",
			"rating: 6",
			"---",
			"# Kafka",
			"Consumer groups split partitions.",
			"```dataview",
			"TABLE file.name",
			"```",
			"```js",
			"console.log(1)",
			"```",
			"![[diagram.png]]",
			"![poster](https://img/x.jpg)",
			"See https://kafka.apache.org for docs.",
			"%% private comment %%",
			"<!-- html comment -->",
			"status:: draft",
			"Uses `inline code` here.",
		].join("\n");
		const out = cleanMarkdown(md).join("\n");
		expect(out).toContain("Kafka");
		expect(out).toContain("Consumer groups split partitions.");
		for (const gone of ["rating", "TABLE", "console.log", "diagram", "poster", "https://", "private", "html comment", "status::", "inline code"]) {
			expect(out).not.toContain(gone);
		}
	});

	it("keeps link text from wikilinks and markdown links", () => {
		expect(cleanMarkdown("Read [[Notes/Retention|retention]] and [[Exactly once]] or [the docs](https://x.y)").join(" ")).toBe(
			"Read retention and Exactly once or the docs",
		);
	});

	it("collapses non-breaking-space lines and formatting", () => {
		expect(cleanMarkdown("**Bold**\n \n   \n> [!note] Callout text\n---\n| a | b |\n|---|---|")).toEqual(["Bold", "Callout text", "a b"]);
	});

	it("removes inline tags from prose", () => {
		expect(cleanMarkdown("Plan the week #planning/weekly today")).toEqual(["Plan the week today"]);
	});
});

describe("processNote", () => {
	it("puts title, aliases, headings and tags before the body", () => {
		const p = processNote(
			doc("# Kafka\n## Consumer Groups\nPartitions are assigned to consumers in a group.", {
				aliases: ["Apache Kafka"],
				headings: ["Kafka", "Consumer Groups"],
				tags: ["tech/streaming"],
			}),
		);
		expect(p.text.split("\n").slice(0, 4)).toEqual(["Kafka", "Apache Kafka", "Consumer Groups", "tech streaming"]);
		expect(p.text).toContain("Partitions are assigned");
		expect(p.lowContent).toBe(false);
	});

	it("does not repeat the title when the note starts with it", () => {
		const p = processNote(doc("# Kafka\nBody text that is long enough to count as content."));
		expect(p.text.match(/Kafka/g)).toHaveLength(1);
	});

	it("flags notes with too little own text", () => {
		const p = processNote(doc("Short."));
		expect(p.semanticChars).toBeLessThan(LOW_CONTENT_CHARS);
		expect(p.lowContent).toBe(true);
	});

	it("removes detected template lines, so template-only notes become low-content", () => {
		const cards = Array.from({ length: 20 }, (_, i) => doc(`# Film ${i}\n**Оценка:** ${i % 10}/10 · **Год:** ${2000 + i} · **Просмотрен:** 2025-08-${10 + i}`, { title: `Film ${i}` }));
		const templates = detectTemplateLines(cards.map((c) => bodyLines(c)));
		expect(templates.size).toBe(1);
		const p = processNote(cards[3], templates);
		expect(p.text).toBe("Film 3");
		expect(p.lowContent).toBe(true);
	});

	it("truncates to maxChars", () => {
		expect(processNote(doc("x ".repeat(5000)), undefined, { maxChars: 100 }).text.length).toBe(100);
	});
});
