// Turns a raw Markdown note into the text that gets embedded.
// Keeps: title, headings, prose, link text. Drops: YAML, code, queries,
// embeds, URLs, HTML, formatting noise.

export interface PreparedNote {
	text: string;
	/** Length of meaningful body text after cleanup (title excluded). */
	bodyChars: number;
}

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

export function prepareNote(raw: string, title: string, maxChars = 2000): PreparedNote {
	let s = raw.replace(FRONTMATTER, "");
	s = s.replace(FENCED, " ").replace(HTML_COMMENT, " ").replace(OBSIDIAN_COMMENT, " ");
	s = s.replace(EMBED, " ").replace(IMAGE, " ");
	s = s.replace(MD_LINK, "$1").replace(WIKILINK, (_m, target: string, alias?: string) => alias || target);
	s = s.replace(URL, " ").replace(INLINE_CODE, " ").replace(HTML_TAG, " ");
	s = s.replace(CALLOUT, "").replace(RULE, "").replace(TABLE_SEP, "");
	s = s.replace(HEADING, "$1.");
	s = s.replace(/[|*_>#=~]+/g, " ").replace(/[\t  -​ 　 ]+/g, " ");
	s = s
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join("\n");

	const body = s.startsWith(title) ? s.slice(title.length).trim() : s;
	return { text: `${title}\n${body}`.slice(0, maxChars), bodyChars: body.length };
}
