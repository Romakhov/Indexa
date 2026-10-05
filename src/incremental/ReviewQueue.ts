// Review Queue (spec §61–62): index suggestions for new and changed notes,
// waiting for the user. Persisted in the plugin folder.

import type { DataAdapter } from "obsidian";
import type { IndexSuggestion } from "./IncrementalScorer";

export interface QueueItem {
	noteId: string;
	path: string;
	kind: "new" | "changed";
	suggestions: IndexSuggestion[];
	/** semantically closest notes, for context */
	similar: string[];
	createdAt: number;
}

export class ReviewQueue {
	items: QueueItem[] = [];

	constructor(
		private readonly adapter: DataAdapter,
		private readonly path: string,
	) {}

	async load() {
		if (!(await this.adapter.exists(this.path))) return;
		try {
			this.items = (JSON.parse(await this.adapter.read(this.path)) as { items?: QueueItem[] }).items ?? [];
		} catch {
			this.items = [];
		}
	}

	private async save() {
		await this.adapter.write(this.path, JSON.stringify({ version: 1, items: this.items }));
	}

	get(noteId: string) {
		return this.items.find((i) => i.noteId === noteId);
	}

	async put(item: QueueItem) {
		this.items = [item, ...this.items.filter((i) => i.noteId !== item.noteId)].slice(0, 200);
		await this.save();
	}

	async remove(noteId: string) {
		const before = this.items.length;
		this.items = this.items.filter((i) => i.noteId !== noteId);
		if (this.items.length !== before) await this.save();
	}

	async rename(noteId: string, path: string) {
		const item = this.get(noteId);
		if (!item) return;
		item.path = path;
		await this.save();
	}
}
