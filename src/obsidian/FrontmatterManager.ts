// Minimal-mutation frontmatter editing (spec §57–58). Works on the text, not on
// a parsed-and-reserialised YAML object: only Indexa's own keys are added,
// replaced or removed; every other byte of the user's frontmatter (comments,
// quoting, key order, line endings) stays as it was. Pure.

export const OWN_KEYS = ["zk-type", "zk-indexes", "zk-generated", "zk-version"] as const;
export type OwnKey = (typeof OWN_KEYS)[number];

export type OwnValue = string | number | boolean | string[];

interface Split {
	bom: string;
	eol: string;
	/** frontmatter lines without the --- fences; null = no frontmatter */
	lines: string[] | null;
	body: string;
}

/** inner block (group 3) keeps its trailing line break, so an empty frontmatter matches too */
const FM = /^(\uFEFF?)---[ \t]*(\r?\n)((?:[\s\S]*?\r?\n)?)---[ \t]*(?:\r?\n|$)/;

function split(text: string): Split {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const m = text.match(FM);
	if (!m) return { bom: text.startsWith("\uFEFF") ? "\uFEFF" : "", eol, lines: null, body: text.replace(/^\uFEFF/, "") };
	const inner = m[3];
	return { bom: m[1], eol: m[2], lines: inner === "" ? [] : inner.replace(/\r?\n$/, "").split(/\r?\n/), body: text.slice(m[0].length) };
}

function join(s: Split): string {
	if (s.lines === null) return s.bom + s.body;
	const fm = s.lines.length ? s.lines.join(s.eol) + s.eol : "";
	return `${s.bom}---${s.eol}${fm}---${s.eol}${s.body}`;
}

const keyOf = (line: string) => line.match(/^([^\s#][^:]*?)\s*:(?:\s|$)/)?.[1];

/** Removes a top-level key together with its indented / list continuation lines. */
function removeKey(lines: string[], key: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (keyOf(lines[i]) !== key) {
			out.push(lines[i]);
			continue;
		}
		while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || /^-\s/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
			// a blank line belongs to the block only if more continuation follows
			if (lines[i + 1].trim() === "" && !(i + 2 < lines.length && (/^\s+\S/.test(lines[i + 2]) || /^-\s/.test(lines[i + 2])))) break;
			i++;
		}
	}
	return out;
}

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function render(key: string, value: OwnValue): string[] {
	if (Array.isArray(value)) return value.length ? [`${key}:`, ...value.map((v) => `  - ${quote(v)}`)] : [`${key}: []`];
	if (typeof value === "string") return [`${key}: ${/^[\w.-]+$/u.test(value) ? value : quote(value)}`];
	return [`${key}: ${value}`];
}

/**
 * Sets Indexa keys (undefined = remove). Other keys are untouched; new keys are
 * appended at the end of the frontmatter, existing ones are replaced in place.
 */
export function setOwnKeys(text: string, values: Partial<Record<OwnKey, OwnValue | undefined>>): string {
	const s = split(text);
	const wanted = Object.entries(values) as [OwnKey, OwnValue | undefined][];
	if (s.lines === null) {
		const add = wanted.filter(([, v]) => v !== undefined).flatMap(([k, v]) => render(k, v!));
		if (!add.length) return text;
		return join({ ...s, lines: add, body: s.body });
	}
	let lines = s.lines;
	for (const [key, value] of wanted) {
		const at = lines.findIndex((l) => keyOf(l) === key);
		const rest = removeKey(lines, key);
		if (value === undefined) {
			lines = rest;
			continue;
		}
		const insertAt = at >= 0 ? at : rest.length;
		lines = [...rest.slice(0, insertAt), ...render(key, value), ...rest.slice(insertAt)];
	}
	// a frontmatter that only held Indexa keys disappears completely
	if (!lines.length && wanted.every(([, v]) => v === undefined)) return s.bom + s.body;
	return join({ ...s, lines });
}

/** Reads the raw text block of an own key (for undo of notes edited after Apply). */
export function readOwnKeyLines(text: string, key: OwnKey): string[] | null {
	const s = split(text);
	if (!s.lines) return null;
	const at = s.lines.findIndex((l) => keyOf(l) === key);
	if (at < 0) return null;
	const without = removeKey(s.lines, key);
	return s.lines.slice(at, at + (s.lines.length - without.length));
}

/** Restores raw key lines captured with readOwnKeyLines (null = key absent). */
export function restoreOwnKeyLines(text: string, key: OwnKey, raw: string[] | null): string {
	const cleared = setOwnKeys(text, { [key]: undefined });
	if (!raw) return cleared;
	const s = split(cleared);
	const lines = s.lines ?? [];
	return join({ ...s, lines: [...lines, ...raw] });
}
