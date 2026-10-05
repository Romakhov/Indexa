import type { App, TFile } from "obsidian";
import { getAllTags, parseFrontMatterAliases } from "obsidian";
import type { NoteDocument } from "../types/NoteDocument";
import { exclusionReason, type ExclusionReason, type ExclusionRules } from "./exclusion";
import type { NoteIdRegistry } from "./NoteIdRegistry";
import { timeSlicer } from "./yieldToUi";

export interface VaultScanner {
	scan(): Promise<NoteDocument[]>;
}

export interface ScanResult {
	notes: NoteDocument[];
	excluded: Record<ExclusionReason, number>;
	total: number;
}

/** Reads notes through Vault + MetadataCache only (no direct filesystem access). */
export class ObsidianVaultScanner implements VaultScanner {
	constructor(
		private readonly app: App,
		private readonly ids: NoteIdRegistry,
		private readonly rules: () => ExclusionRules,
	) {}

	async scan(): Promise<NoteDocument[]> {
		return (await this.scanWithStats()).notes;
	}

	async scanWithStats(signal?: AbortSignal): Promise<ScanResult> {
		const rules = this.rules();
		const files = this.app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path));
		const excluded: Record<ExclusionReason, number> = { folder: 0, frontmatter: 0, tag: 0, "generated-index": 0, drawing: 0, config: 0 };
		const notes: NoteDocument[] = [];
		const maybeYield = timeSlicer();

		for (const file of files) {
			signal?.throwIfAborted();
			await maybeYield();
			const cache = this.app.metadataCache.getFileCache(file);
			const tags = (cache ? (getAllTags(cache) ?? []) : []).map((t) => t.replace(/^#/, ""));
			const reason = exclusionReason({ path: file.path, frontmatter: cache?.frontmatter, tags }, rules);
			if (reason) {
				excluded[reason]++;
				continue;
			}
			notes.push(await this.toDocument(file, tags));
		}
		this.ids.retainOnly(files.map((f) => f.path));
		return { notes, excluded, total: files.length };
	}

	/** One file, with the same exclusion rules as a full scan (null = excluded). */
	async scanFile(file: TFile): Promise<NoteDocument | null> {
		const cache = this.app.metadataCache.getFileCache(file);
		const tags = (cache ? (getAllTags(cache) ?? []) : []).map((t) => t.replace(/^#/, ""));
		if (exclusionReason({ path: file.path, frontmatter: cache?.frontmatter, tags }, this.rules())) return null;
		return this.toDocument(file, tags);
	}

	private async toDocument(file: TFile, tags: string[]): Promise<NoteDocument> {
		const cache = this.app.metadataCache.getFileCache(file);
		const links = [...(cache?.links ?? []), ...(cache?.frontmatterLinks ?? [])].map(
			(l) => this.app.metadataCache.getFirstLinkpathDest(l.link.split("#")[0], file.path)?.path ?? l.link,
		);
		return {
			id: this.ids.idFor(file.path),
			path: file.path,
			title: file.basename,
			content: await this.app.vault.cachedRead(file),
			headings: (cache?.headings ?? []).map((h) => h.heading),
			tags: [...new Set(tags)],
			links: [...new Set(links)],
			aliases: parseFrontMatterAliases(cache?.frontmatter) ?? [],
			frontmatter: { ...(cache?.frontmatter ?? {}) },
			modifiedAt: file.stat.mtime,
		};
	}
}
