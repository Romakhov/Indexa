// Plans an Apply (spec §55–58): which index notes to create / update / rename,
// which notes get which indexes, what to clean up from a previous Apply.
// Pure: reads the vault through a narrow interface, writes nothing.

import type { EffectiveIndex } from "../review/ReviewState";

export interface VaultView {
	exists(path: string): boolean;
	/** frontmatter zk-generated: true */
	isGenerated(path: string): boolean;
	/** current path of a note id, if the note still exists */
	notePath(noteId: string): string | undefined;
	/** notes carrying Indexa note metadata (zk-type: note) */
	notesWithOwnKeys(): string[];
	/** generated index notes (zk-type: index + zk-generated: true) */
	generatedIndexes(): string[];
}

export interface ApplyOptions {
	indexFolder: string;
	moveNotes: boolean;
	moveTarget: string;
	/** index file per proposal id from the previous Apply */
	previousIndexFiles: Record<string, string>;
}

export interface PlannedIndex {
	proposalId: string;
	name: string;
	path: string;
	action: "create" | "update";
	/** the file had to be renamed first (index renamed in Review after an earlier Apply) */
	renameFrom?: string;
	/** an existing note the user wrote: only a controlled section is added */
	userNote: boolean;
	/** member note ids, primary members first */
	noteIds: string[];
	relatedProposalIds: string[];
}

export interface PlannedNote {
	noteId: string;
	path: string;
	/** index proposal ids, primary first */
	indexIds: string[];
}

export interface ApplyPlan {
	indexes: PlannedIndex[];
	notes: PlannedNote[];
	/** notes with Indexa metadata that no longer belong to any index */
	clearNotes: string[];
	/** generated index notes no index maps to any more */
	staleIndexes: string[];
	moves: { noteId: string; from: string; to: string }[];
	skipped: { noteId: string; reason: string }[];
}

const ILLEGAL = /[\\/:*?"<>|#^[\]]/g;

/** A safe, readable file name for an index. */
export function indexFileName(name: string): string {
	const clean = name.replace(ILLEGAL, " ").replace(/\s+/g, " ").trim().slice(0, 100).replace(/[. ]+$/, "");
	return clean || "Untitled index";
}

const join = (folder: string, name: string) => (folder ? `${folder.replace(/\/+$/, "")}/${name}.md` : `${name}.md`);
const parent = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

export function planApply(indexes: EffectiveIndex[], vault: VaultView, opts: ApplyOptions): ApplyPlan {
	const live = indexes.filter((i) => !i.ignored);
	const planned: PlannedIndex[] = [];
	const usedPaths = new Set<string>();

	for (const index of live) {
		const base = indexFileName(index.unnamed ? `Topic — ${index.keywords.slice(0, 2).join(", ")}` : index.name);
		let path = join(opts.indexFolder, base);
		for (let n = 2; usedPaths.has(path.toLowerCase()); n++) path = join(opts.indexFolder, `${base} (${n})`);
		usedPaths.add(path.toLowerCase());

		const previous = opts.previousIndexFiles[index.id];
		let renameFrom: string | undefined;
		if (previous && previous !== path && vault.exists(previous) && vault.isGenerated(previous) && !vault.exists(path)) renameFrom = previous;
		const existsNow = vault.exists(path);
		planned.push({
			proposalId: index.id,
			name: index.name,
			path,
			action: existsNow || renameFrom ? "update" : "create",
			renameFrom,
			userNote: existsNow && !vault.isGenerated(path),
			noteIds: [...index.members].sort((a, b) => Number(b.primary) - Number(a.primary)).map((m) => m.noteId),
			relatedProposalIds: index.related,
		});
	}

	const byProposal = new Map(planned.map((p) => [p.proposalId, p]));
	const notes = new Map<string, PlannedNote>();
	const skipped: ApplyPlan["skipped"] = [];
	for (const index of live) {
		for (const m of index.members) {
			const path = vault.notePath(m.noteId);
			if (!path) {
				skipped.push({ noteId: m.noteId, reason: "note no longer exists" });
				continue;
			}
			const n = notes.get(m.noteId) ?? { noteId: m.noteId, path, indexIds: [] };
			if (m.primary) n.indexIds.unshift(index.id);
			else n.indexIds.push(index.id);
			notes.set(m.noteId, n);
		}
	}
	for (const p of planned) p.relatedProposalIds = p.relatedProposalIds.filter((id) => byProposal.has(id));

	const notePaths = new Set([...notes.values()].map((n) => n.path));
	const indexPaths = new Set(planned.flatMap((p) => [p.path, p.renameFrom].filter((x): x is string => !!x)));
	const clearNotes = vault.notesWithOwnKeys().filter((p) => !notePaths.has(p) && !indexPaths.has(p));
	const staleIndexes = vault.generatedIndexes().filter((p) => !indexPaths.has(p));

	const moves: ApplyPlan["moves"] = [];
	if (opts.moveNotes && opts.moveTarget) {
		const target = opts.moveTarget.replace(/\/+$/, "");
		const taken = new Set<string>();
		for (const n of notes.values()) {
			if (parent(n.path) === target || n.path.startsWith(target + "/")) continue;
			const to = `${target}/${n.path.split("/").pop()}`;
			if (vault.exists(to) || taken.has(to.toLowerCase())) {
				skipped.push({ noteId: n.noteId, reason: `not moved: ${to} already exists` });
				continue;
			}
			taken.add(to.toLowerCase());
			moves.push({ noteId: n.noteId, from: n.path, to });
		}
	}

	return { indexes: planned, notes: [...notes.values()], clearNotes, staleIndexes, moves, skipped };
}
