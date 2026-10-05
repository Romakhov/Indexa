// Turns a raw Markdown note into the text that gets embedded (spec §16).
// Keeps: title, aliases, headings, tags, prose, link text.
// Drops: YAML, code, Dataview, embeds, URLs, HTML, formatting noise, template lines.
// Pure: no Obsidian imports.

import type { NoteDocument, ProcessedNote } from "../types/NoteDocument";
import { TemplateLines } from "./TemplateDetector";

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const FENCED = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const OBSIDIAN_COMMENT = /%%[\s\S]*?%%/g;
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;
const EMBED = /!\[\[[^\]]*\]\]/g;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const MD_LINK = /\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g;
const WIKILINK = /\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;
const URL = /\bhttps?:\/\/\S+/g;
const INLINE_CODE = /`[^`\n]*`/g;
const CALLOUT = /^>\s*\[![^\]]*\][+-]?\s*/gm;
const RULE = /^\s*([-_*=])\1{2,}\s*$/gm;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}.*$/gm;
const HEADING = /^#{1,6}\s+(.*)$/gm;
const DATAVIEW_FIELD = /^\s*[\p{L}\w-]+::.*$/gmu;
const INLINE_TAG = /(^|\s)#[\p{L}\w/-]+/gu;
const WHITESPACE = /[\t  -​ 　 ]+/g;

/** Low-content threshold: fewer own characters than this → not placed semantically. */
export const LOW_CONTENT_CHARS = 40;

export interface ProcessorOptions {
	maxChars: number;
	maxHeadings: number;
}


const DEFAULTS: ProcessorOptions = { maxChars: 2000, maxHeadings: 10 };

/** Cleans Markdown down to plain prose, one non-empty line per line. */
export function cleanMarkdown(raw: string): string[] {
	let s = raw.replace(FRONTMATTER, "");
	s = s.replace(FENCED, " ").replace(HTML_COMMENT, " ").replace(OBSIDIAN_COMMENT, " ");
	s = s.replace(DATAVIEW_FIELD, " ");
	s = s.replace(EMBED, " ").replace(IMAGE, " ");
	s = s.replace(MD_LINK, "$1").replace(WIKILINK, (_m, target: string, alias?: string) => alias || target);
	s = s.replace(URL, " ").replace(INLINE_CODE, " ").replace(HTML_TAG, " ");
	s = s.replace(CALLOUT, "").replace(RULE, "").replace(TABLE_SEP, "");
	s = s.replace(HEADING, "$1");
	s = s.replace(INLINE_TAG, "$1");
	s = s.replace(/[|*_>#=~]+/g, " ").replace(WHITESPACE, " ");
	return s
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

/** Cleaned body lines without a leading line that repeats the title. Input for template detection too. */
export function bodyLines(doc: Pick<NoteDocument, "content" | "title">): string[] {
	const lines = cleanMarkdown(doc.content);
	if (lines.length && lines[0].toLowerCase() === doc.title.toLowerCase()) lines.shift();
	return lines;
}

const tagWords = (tag: string) => tag.replace(/^#/, "").replace(/[/_-]+/g, " ");

/**
 * Builds the semantic representation of a note. Title, aliases and headings
 * are put first (high weight: they survive truncation and lead the text),
 * tags next, then the body.
 */
export function processNote(
	doc: NoteDocument,
	templates: TemplateLines = TemplateLines.empty(),
	options: Partial<ProcessorOptions> = {},
): ProcessedNote {
	const opts = { ...DEFAULTS, ...options };
	const lines = cleanMarkdown(doc.content).filter((l) => !templates.has(l));
	// a leading "# Title" duplicates the title
	if (lines.length && lines[0].toLowerCase() === doc.title.toLowerCase()) lines.shift();
	const body = lines.join("\n");

	const header = [doc.title];
	const aliases = doc.aliases.filter((a) => a && a.toLowerCase() !== doc.title.toLowerCase());
	if (aliases.length) header.push(aliases.join(", "));
	const headings = [...new Set(doc.headings.filter((h) => h && h.toLowerCase() !== doc.title.toLowerCase()))].slice(0, opts.maxHeadings);
	if (headings.length) header.push(headings.join("; "));
	if (doc.tags.length) header.push(doc.tags.map(tagWords).join(", "));

	const semanticChars = body.replace(/\s+/g, "").length;
	return {
		noteId: doc.id,
		text: [...header, body].filter(Boolean).join("\n").slice(0, opts.maxChars),
		headerText: header.join("\n").slice(0, opts.maxChars),
		semanticChars,
		lowContent: semanticChars < LOW_CONTENT_CHARS,
	};
}

/** Detects template lines over a whole corpus, then processes every note. */
export function processNotes(docs: NoteDocument[], templates: TemplateLines): ProcessedNote[] {
	return docs.map((d) => processNote(d, templates));
}

/** Spike helper kept for Gate 0c reproduction. */
export function prepareNote(raw: string, title: string, maxChars = 2000): { text: string; bodyChars: number } {
	const lines = cleanMarkdown(raw);
	if (lines.length && lines[0].toLowerCase() === title.toLowerCase()) lines.shift();
	const body = lines.join("\n");
	return { text: `${title}\n${body}`.slice(0, maxChars), bodyChars: body.length };
}
