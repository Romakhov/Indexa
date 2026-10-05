// Which notes the analysis must not see (spec §14–15). Pure: no Obsidian imports.

export type ExclusionReason = "folder" | "frontmatter" | "tag" | "generated-index" | "drawing" | "config";

export interface ExclusionRules {
	excludedFolders: string[];
	excludedTags: string[];
	/** The vault config dir (usually ".obsidian"); never analysed. */
	configDir: string;
}

export interface NoteMeta {
	path: string;
	frontmatter: Record<string, unknown> | undefined;
	/** tags without "#" */
	tags: string[];
}

const inFolder = (path: string, folder: string) => {
	const f = folder.replace(/^\/+|\/+$/g, "");
	return f.length > 0 && (path === f || path.startsWith(f + "/"));
};

const tagMatches = (tag: string, excluded: string) => {
	const t = tag.toLowerCase();
	const e = excluded.toLowerCase();
	return t === e || t.startsWith(e + "/");
};

export function exclusionReason(note: NoteMeta, rules: ExclusionRules): ExclusionReason | null {
	if (inFolder(note.path, rules.configDir)) return "config";
	if (note.path.endsWith(".excalidraw.md")) return "drawing";
	if (rules.excludedFolders.some((f) => inFolder(note.path, f))) return "folder";
	const fm = note.frontmatter ?? {};
	if (fm["zk-ignore"] === true || fm["zk-ignore"] === "true") return "frontmatter";
	// generated index notes are proposals' output, not input (spec §14)
	if (fm["zk-type"] === "index") return "generated-index";
	if (note.tags.some((t) => rules.excludedTags.some((e) => tagMatches(t, e)))) return "tag";
	return null;
}
