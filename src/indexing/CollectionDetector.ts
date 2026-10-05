// Collections (approved product rule): notes with little own text, e.g.
// template-made movie cards, cannot be placed by meaning. They are grouped by
// the metadata they share instead: frontmatter `type`, then a tag, then a folder.
// Pure.

export interface CollectionNote {
	id: string;
	path: string;
	tags: string[];
	frontmatter: Record<string, unknown>;
	lowContent: boolean;
}

export interface Collection {
	signature: string;
	/** human label derived from the signature, e.g. "фильм", "Movies" */
	label: string;
	noteIds: string[];
}

export interface CollectionOptions {
	minNotes: number;
	/** a signature becomes a collection when at least this share of its notes is low-content */
	minLowContentShare: number;
	/** folders are a weaker signal than type/tags: stricter thresholds */
	minFolderNotes?: number;
	minFolderLowContentShare?: number;
}

const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

function signatures(n: CollectionNote): { sig: string; label: string }[] {
	const out: { sig: string; label: string }[] = [];
	const type = n.frontmatter["type"];
	if (typeof type === "string" && type.trim()) out.push({ sig: `type: ${type.trim().toLowerCase()}`, label: type.trim() });
	for (const t of n.tags) out.push({ sig: `#${t.toLowerCase()}`, label: t.split("/").pop()! });
	const folder = folderOf(n.path);
	if (folder) out.push({ sig: `folder: ${folder}`, label: folder.split("/").pop()! });
	return out;
}

export function detectCollections(notes: CollectionNote[], opts: CollectionOptions): Collection[] {
	// candidate signature -> notes carrying it
	const bySig = new Map<string, { label: string; ids: Set<string>; low: number }>();
	for (const n of notes) {
		for (const { sig, label } of signatures(n)) {
			const e = bySig.get(sig) ?? { label, ids: new Set<string>(), low: 0 };
			e.ids.add(n.id);
			if (n.lowContent) e.low++;
			bySig.set(sig, e);
		}
	}
	const qualifying = [...bySig].filter(([sig, e]) => {
		const folder = sig.startsWith("folder:");
		const minNotes = folder ? Math.max(opts.minNotes, opts.minFolderNotes ?? 0) : opts.minNotes;
		const minShare = folder ? Math.max(opts.minLowContentShare, opts.minFolderLowContentShare ?? 0) : opts.minLowContentShare;
		return e.ids.size >= minNotes && e.low / e.ids.size >= minShare;
	});
	// priority: type > tag > folder, then larger first
	const rank = (sig: string) => (sig.startsWith("type:") ? 0 : sig.startsWith("#") ? 1 : 2);
	qualifying.sort((a, b) => rank(a[0]) - rank(b[0]) || b[1].ids.size - a[1].ids.size);

	// each note joins the first (best) qualifying collection it carries
	const taken = new Set<string>();
	const out: Collection[] = [];
	for (const [sig, e] of qualifying) {
		const ids = [...e.ids].filter((id) => !taken.has(id));
		if (ids.length < opts.minNotes) continue;
		ids.forEach((id) => taken.add(id));
		out.push({ signature: sig, label: e.label, noteIds: ids });
	}
	return out;
}
