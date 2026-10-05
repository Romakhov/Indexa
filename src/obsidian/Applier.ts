// Executes an ApplyPlan through the Obsidian API and records a ChangeSet
// (spec §55–58, §76, §95–96). Every file is changed with vault.process
// (atomic read-modify-write); the original text of every modified file is
// kept so the last Apply can be undone. One failing file never stops the run.
//
// Every operation is appended to an ordered journal; Undo replays it backwards.
//
// Renames do not use fileManager.renameFile: Obsidian's link updater rewrites
// the whole frontmatter of every linking note (e.g. "Links: " → "Links:",
// CRLF → LF), which breaks minimal mutation (spec §58) and exact undo. Files
// are renamed with vault.rename and only the affected link strings are replaced.

import { getLinkpath, normalizePath, TFile, type App } from "obsidian";
import { contentHash } from "../core/hash";
import { timeSlicer } from "../core/yieldToUi";
import type { ApplyPlan } from "../indexing/IndexBuilder";
import { readOwnKeyLines, restoreOwnKeyLines, setOwnKeys } from "./FrontmatterManager";
import { indexSection, newIndexNote, noteIndexSection, readSection, setSection } from "./MarkdownWriter";

export interface FilePatch {
	path: string;
	kind: "note" | "index" | "link";
	before: string;
	afterHash: string;
	/** raw own-key lines before Apply, for undo of files edited afterwards */
	keysBefore: { type: string[] | null; indexes: string[] | null };
	sectionBefore: string | null;
}

export type JournalOp =
	| { op: "mkdir"; path: string }
	| { op: "create"; path: string; afterHash: string }
	| { op: "modify"; patch: FilePatch }
	| { op: "rename"; from: string; to: string }
	| { op: "delete"; path: string; content: string };

export interface ChangeSet {
	id: string;
	timestamp: number;
	/** ordered journal; Undo replays it backwards */
	ops: JournalOp[];
	/** index file per proposal id before this Apply (restored by Undo) */
	previousIndexFiles: Record<string, string>;
	indexFiles: Record<string, string>;
	errors: { path: string; message: string }[];
	undone?: boolean;
}

export function summarize(cs: ChangeSet) {
	const count = (op: JournalOp["op"]) => cs.ops.filter((o) => o.op === op).length;
	return { created: count("create"), modified: new Set(cs.ops.flatMap((o) => (o.op === "modify" ? [o.patch.path] : []))).size, renamed: count("rename"), deleted: count("delete") };
}

export interface ApplySettings {
	addFrontmatter: boolean;
	addVisibleIndexLinks: boolean;
}

export interface ApplyProgress {
	done: number;
	total: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Splits "[[target#sub|alias]]" into parts; null for other link syntaxes. */
function parseWikilink(original: string): { sub: string; alias: string | null; embed: boolean } | null {
	const m = original.match(/^(!?)\[\[([^\]|#]*)(#[^\]|]*)?(?:\|([^\]]*))?\]\]$/);
	return m ? { embed: m[1] === "!", sub: m[3] ?? "", alias: m[4] ?? null } : null;
}

export class Applier {
	constructor(private readonly app: App) {}

	private file(path: string): TFile | null {
		return this.app.vault.getFileByPath(normalizePath(path));
	}

	/** [[link]] from `fromPath` to `target`; shortest unambiguous link text, alias when it is a path. */
	private link(target: TFile, fromPath: string, display?: string): string {
		const text = this.app.metadataCache.fileToLinktext(target, fromPath, true);
		const alias = display ?? target.basename;
		return text === alias ? `[[${text}]]` : `[[${text}|${alias}]]`;
	}

	private async ensureFolder(path: string, cs: ChangeSet) {
		const parts = path.split("/").slice(0, -1);
		for (let i = 1; i <= parts.length; i++) {
			const folder = parts.slice(0, i).join("/");
			if (!this.app.vault.getFolderByPath(folder)) {
				await this.app.vault.createFolder(folder);
				cs.ops.push({ op: "mkdir", path: folder });
			}
		}
	}

	/** Rewrites a file with `edit`, journaling the patch; no write when nothing changes. */
	private async patch(file: TFile, kind: FilePatch["kind"], edit: (text: string) => string, cs: ChangeSet) {
		let before = "";
		let after = "";
		await this.app.vault.process(file, (text) => {
			before = text;
			after = edit(text);
			return after;
		});
		if (after === before) return;
		cs.ops.push({
			op: "modify",
			patch: {
				path: file.path,
				kind,
				before,
				afterHash: contentHash(after),
				keysBefore: { type: readOwnKeyLines(before, "zk-type"), indexes: readOwnKeyLines(before, "zk-indexes") },
				sectionBefore: readSection(before),
			},
		});
	}

	/**
	 * Renames a file without Obsidian's link updater: links that pointed to it
	 * (body, frontmatter, embeds) are rewritten one string at a time.
	 */
	private async renameKeepingLinks(file: TFile, to: string, cs: ChangeSet) {
		const oldPath = file.path;
		const refs = new Map<string, string[]>();
		for (const [src, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
			if (!targets[oldPath] || src === oldPath) continue;
			const srcFile = this.file(src);
			const cache = srcFile && this.app.metadataCache.getFileCache(srcFile);
			if (!cache) continue;
			const originals = [...(cache.links ?? []), ...(cache.embeds ?? []), ...(cache.frontmatterLinks ?? [])]
				.filter((l) => this.app.metadataCache.getFirstLinkpathDest(getLinkpath(l.link), src)?.path === oldPath)
				.map((l) => l.original)
				.filter((o) => parseWikilink(o));
			if (originals.length) refs.set(src, [...new Set(originals)]);
		}
		await this.ensureFolder(to, cs);
		await this.app.vault.rename(file, to);
		cs.ops.push({ op: "rename", from: oldPath, to });
		for (const [src, originals] of refs) {
			const srcFile = this.file(src);
			if (!srcFile) continue;
			const text = this.app.metadataCache.fileToLinktext(file, src, true);
			await this.patch(
				srcFile,
				"link",
				(t) => {
					let out = t;
					for (const o of originals) {
						const w = parseWikilink(o)!;
						// keep the old visible text when the link had none and the name changed
						const alias = w.alias ?? (text !== file.basename ? file.basename : null);
						out = out.split(o).join(`${w.embed ? "!" : ""}[[${text}${w.sub}${alias ? `|${alias}` : ""}]]`);
					}
					return out;
				},
				cs,
			);
		}
	}

	/** @param onlyNotes when set, only these notes' files are written (incremental Apply) */
	async apply(plan: ApplyPlan, previousIndexFiles: Record<string, string>, settings: ApplySettings, onProgress?: (p: ApplyProgress) => void, onlyNotes?: Set<string>): Promise<ChangeSet> {
		const cs: ChangeSet = { id: `apply-${Date.now()}`, timestamp: Date.now(), ops: [], previousIndexFiles, indexFiles: {}, errors: [] };
		const total = plan.indexes.length * 2 + plan.notes.length + plan.clearNotes.length + plan.staleIndexes.length + plan.moves.length;
		let done = 0;
		const maybeYield = timeSlicer();
		const guard = async (path: string, fn: () => Promise<void>) => {
			try {
				await fn();
			} catch (e) {
				cs.errors.push({ path, message: message(e) });
			}
			onProgress?.({ done: ++done, total });
			await maybeYield();
		};

		// 1. index files exist (renamed / created) before anything links to them
		const indexFile = new Map<string, TFile>();
		for (const ix of plan.indexes) {
			await guard(ix.path, async () => {
				if (ix.renameFrom) {
					const from = this.file(ix.renameFrom);
					if (from) await this.renameKeepingLinks(from, ix.path, cs);
				}
				let f = this.file(ix.path);
				if (!f) {
					await this.ensureFolder(ix.path, cs);
					f = await this.app.vault.create(ix.path, newIndexNote({ name: ix.name, notes: [], related: [] }));
					cs.ops.push({ op: "create", path: ix.path, afterHash: "" });
				}
				indexFile.set(ix.proposalId, f);
				cs.indexFiles[ix.proposalId] = ix.path;
			});
		}

		// 2. index contents: only the controlled section (plus zk-type on user notes)
		for (const ix of plan.indexes) {
			const f = indexFile.get(ix.proposalId);
			if (!f) {
				onProgress?.({ done: ++done, total });
				continue;
			}
			await guard(ix.path, async () => {
				const notes = ix.noteIds
					.map((id) => plan.notes.find((n) => n.noteId === id)?.path)
					.map((p) => (p ? this.file(p) : null))
					.filter((x): x is TFile => !!x)
					.map((nf) => this.link(nf, f.path));
				const related = ix.relatedProposalIds.map((id) => indexFile.get(id)).filter((x): x is TFile => !!x).map((rf) => this.link(rf, f.path));
				const section = indexSection({ name: ix.name, notes, related });
				const created = cs.ops.find((o): o is Extract<JournalOp, { op: "create" }> => o.op === "create" && o.path === ix.path);
				if (created) {
					let after = "";
					await this.app.vault.process(f, (text) => (after = setSection(text, section)));
					created.afterHash = contentHash(after);
				} else {
					await this.patch(f, "index", (text) => setSection(ix.userNote ? setOwnKeys(text, { "zk-type": "index" }) : text, section), cs);
				}
			});
		}

		// 3. member notes: zk-type / zk-indexes and the optional visible section
		for (const n of plan.notes) {
			if (onlyNotes && !onlyNotes.has(n.noteId)) continue;
			await guard(n.path, async () => {
				const f = this.file(n.path);
				if (!f) throw new Error("note not found");
				const links = n.indexIds.map((id) => indexFile.get(id)).filter((x): x is TFile => !!x).map((ixf) => this.link(ixf, f.path));
				await this.patch(
					f,
					"note",
					(text) => {
						const t = settings.addFrontmatter ? setOwnKeys(text, { "zk-type": "note", "zk-indexes": links }) : setOwnKeys(text, { "zk-type": undefined, "zk-indexes": undefined });
						return setSection(t, settings.addVisibleIndexLinks && links.length ? noteIndexSection(links) : null);
					},
					cs,
				);
			});
		}

		// 4. notes that left every index: remove Indexa metadata only
		for (const path of plan.clearNotes) {
			await guard(path, async () => {
				const f = this.file(path);
				if (f) await this.patch(f, "note", (text) => setSection(setOwnKeys(text, { "zk-type": undefined, "zk-indexes": undefined }), null), cs);
			});
		}

		// 5. generated index notes no index maps to any more → Obsidian trash (recoverable)
		for (const path of plan.staleIndexes) {
			await guard(path, async () => {
				const f = this.file(path);
				if (!f) return;
				cs.ops.push({ op: "delete", path, content: await this.app.vault.read(f) });
				await this.app.fileManager.trashFile(f);
			});
		}

		// 6. optional moves (spec §55, default off)
		for (const m of plan.moves) {
			await guard(m.from, async () => {
				const f = this.file(m.from);
				if (f) await this.renameKeepingLinks(f, m.to, cs);
			});
		}
		return cs;
	}

	/**
	 * Undo (spec §96): replays the journal backwards. Unchanged files get their
	 * exact original back; files edited after Apply lose only Indexa's keys /
	 * section; created files go to the Obsidian trash; renames are reversed.
	 */
	async undo(cs: ChangeSet, onProgress?: (p: ApplyProgress) => void): Promise<{ restored: number; surgical: number; errors: { path: string; message: string }[] }> {
		const errors: { path: string; message: string }[] = [];
		let restored = 0;
		let surgical = 0;
		let done = 0;
		const maybeYield = timeSlicer();
		for (const o of [...cs.ops].reverse()) {
			const path = o.op === "modify" ? o.patch.path : o.op === "rename" ? o.to : o.path;
			try {
				if (o.op === "modify") {
					const p = o.patch;
					const f = this.file(p.path);
					if (!f) throw new Error("file no longer exists");
					await this.app.vault.process(f, (text) => {
						if (contentHash(text) === p.afterHash) {
							restored++;
							return p.before;
						}
						surgical++;
						if (p.kind === "link") return text; // a link rewrite in a file edited since: leave the user's version
						let t = restoreOwnKeyLines(text, "zk-type", p.keysBefore.type);
						t = restoreOwnKeyLines(t, "zk-indexes", p.keysBefore.indexes);
						return setSection(t, p.sectionBefore);
					});
				} else if (o.op === "rename") {
					const f = this.file(o.to);
					if (!f) throw new Error("renamed file not found");
					if (this.file(o.from)) throw new Error(`cannot rename back: ${o.from} exists`);
					await this.app.vault.rename(f, o.from);
				} else if (o.op === "create") {
					const f = this.file(o.path);
					if (f) await this.app.fileManager.trashFile(f);
				} else if (o.op === "delete") {
					if (this.file(o.path)) throw new Error("a file with this name exists again");
					await this.app.vault.create(o.path, o.content);
				} else if (o.op === "mkdir") {
					const f = this.app.vault.getFolderByPath(o.path);
					if (f && f.children.length === 0) await this.app.vault.delete(f);
				}
			} catch (e) {
				errors.push({ path, message: message(e) });
			}
			onProgress?.({ done: ++done, total: cs.ops.length });
			await maybeYield();
		}
		return { restored, surgical, errors };
	}
}
