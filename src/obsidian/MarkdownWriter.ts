// Controlled sections (spec §58): Indexa only ever writes between its own
// markers; everything outside them belongs to the user. Obsidian comments
// (%% … %%) keep the markers invisible in reading view. Pure.

export const SECTION_START = "%% indexa:start %%";
export const SECTION_END = "%% indexa:end %%";

const eolOf = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");

function find(text: string): { start: number; end: number } | null {
	const start = text.indexOf(SECTION_START);
	if (start < 0) return null;
	const endMarker = text.indexOf(SECTION_END, start);
	if (endMarker < 0) return null;
	return { start, end: endMarker + SECTION_END.length };
}

export function readSection(text: string): string | null {
	const r = find(text);
	if (!r) return null;
	return text.slice(r.start + SECTION_START.length, r.end - SECTION_END.length).replace(/^\r?\n|\r?\n$/g, "");
}

/** Writes (or with null removes) the controlled section; appended at the end when new. */
export function setSection(text: string, content: string | null): string {
	const eol = eolOf(text);
	const r = find(text);
	const block = content === null ? "" : `${SECTION_START}${eol}${content.replace(/\r?\n/g, eol)}${eol}${SECTION_END}`;
	if (r) {
		if (content !== null) return text.slice(0, r.start) + block + text.slice(r.end);
		// removing: drop the block with its line break; at the end of the note also the
		// blank lines in front of it (byte-exact restores go through Undo's saved original)
		const before = text.slice(0, r.start);
		const after = text.slice(r.end).replace(/^\r?\n/, "");
		if (after) return before + after;
		const trimmed = before.replace(/(\r?\n)+$/, "");
		return trimmed ? trimmed + eol : "";
	}
	if (content === null) return text;
	const sep = text === "" ? "" : text.endsWith(eol + eol) ? "" : text.endsWith(eol) ? eol : eol + eol;
	return `${text}${sep}${block}${eol}`;
}

export interface IndexNoteContent {
	name: string;
	/** link texts, already formatted as [[…]] */
	notes: string[];
	related: string[];
}

export function indexSection(c: IndexNoteContent): string {
	const lines = ["## Notes", "", ...c.notes.map((l) => `- ${l}`)];
	if (c.related.length) lines.push("", "## Related indexes", "", ...c.related.map((l) => `- ${l}`));
	return lines.join("\n");
}

/** A new, generated index note (spec §56). */
export function newIndexNote(c: IndexNoteContent): string {
	return ["---", "zk-type: index", "zk-generated: true", "zk-version: 1", "---", "", `# ${c.name}`, "", SECTION_START, indexSection(c), SECTION_END, ""].join("\n");
}

/** The optional visible list of a note's indexes (setting "Add visible index links"). */
export function noteIndexSection(links: string[]): string {
	return `Indexes: ${links.join(" · ")}`;
}
