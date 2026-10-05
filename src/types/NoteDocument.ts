/** A vault note as seen by the analysis pipeline (spec §14). */
export interface NoteDocument {
	/** Stable internal id; survives renames (see NoteIdRegistry). */
	id: string;
	path: string;
	title: string;
	/** Raw Markdown including frontmatter. */
	content: string;
	headings: string[];
	/** Tags without "#", from body and frontmatter. */
	tags: string[];
	/** Resolved target paths of outgoing links (unresolved links keep their link text). */
	links: string[];
	aliases: string[];
	frontmatter: Record<string, unknown>;
	modifiedAt: number;
}

/** The text that gets embedded for a note, plus content-quality signals. */
export interface ProcessedNote {
	noteId: string;
	text: string;
	/** Characters of meaningful body text after cleanup and template removal. */
	semanticChars: number;
	/**
	 * Too little own text for semantic placement (e.g. template-only cards).
	 * Such notes are grouped by metadata ("collections") instead.
	 */
	lowContent: boolean;
}
