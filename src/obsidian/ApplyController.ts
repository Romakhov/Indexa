// Apply / Undo flow: plan → confirm → write with progress → record change set.

import { Modal, Notice, Setting, type App } from "obsidian";
import { planApply, type ApplyPlan, type VaultView } from "../indexing/IndexBuilder";
import type IndexaPlugin from "../main";
import { ChangeHistoryStore } from "../storage/ChangeHistoryStore";
import { Applier, summarize, type ChangeSet } from "./Applier";

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly title: string,
		private readonly lines: string[],
		private readonly cta: string,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	onOpen() {
		this.setTitle(this.title);
		const list = this.contentEl.createEl("ul");
		for (const l of this.lines) list.createEl("li", { text: l });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(this.cta)
					.setCta()
					.onClick(() => {
						this.close();
						this.onConfirm();
					}),
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class ApplyController {
	readonly history: ChangeHistoryStore;
	private busy = false;
	lastUndoable: ChangeSet | null = null;

	constructor(private readonly plugin: IndexaPlugin) {
		this.history = new ChangeHistoryStore(plugin.app.vault.adapter, plugin.manifest.dir!);
	}

	async refresh() {
		this.lastUndoable = await this.history.last();
	}

	private vaultView(): VaultView {
		const { app } = this.plugin;
		const fm = (path: string) => {
			const f = app.vault.getFileByPath(path);
			return f ? app.metadataCache.getFileCache(f)?.frontmatter : undefined;
		};
		const files = () => app.vault.getMarkdownFiles();
		return {
			exists: (path) => !!app.vault.getAbstractFileByPath(path),
			isGenerated: (path) => fm(path)?.["zk-generated"] === true,
			notePath: (id) => {
				const p = this.plugin.pathOf(id);
				return p && app.vault.getFileByPath(p) ? p : undefined;
			},
			notesWithOwnKeys: () => files().filter((f) => app.metadataCache.getFileCache(f)?.frontmatter?.["zk-type"] === "note").map((f) => f.path),
			generatedIndexes: () =>
				files()
					.filter((f) => {
						const m = app.metadataCache.getFileCache(f)?.frontmatter;
						return m?.["zk-type"] === "index" && m?.["zk-generated"] === true;
					})
					.map((f) => f.path),
		};
	}

	async plan(): Promise<ApplyPlan | null> {
		const review = this.plugin.review.effective();
		if (!review) return null;
		const s = this.plugin.settings;
		const state = await this.history.state();
		return planApply(review.indexes, this.vaultView(), {
			indexFolder: s.indexFolder,
			moveNotes: s.moveNotesAfterApply,
			moveTarget: s.moveTargetFolder,
			previousIndexFiles: state.indexFiles,
		});
	}

	async confirmAndApply() {
		if (this.busy) return;
		const plan = await this.plan();
		if (!plan) {
			new Notice("Run Analyze vault first.");
			return;
		}
		const create = plan.indexes.filter((i) => i.action === "create").length;
		const update = plan.indexes.length - create;
		const lines = [
			`${create} index notes will be created in "${this.plugin.settings.indexFolder}"` + (update ? `, ${update} updated` : ""),
			`${plan.notes.length} notes get index links${this.plugin.settings.addFrontmatter ? " (zk-indexes in frontmatter)" : ""}${this.plugin.settings.addVisibleIndexLinks ? " and a visible links line" : ""}`,
		];
		if (plan.indexes.some((i) => i.userNote)) lines.push(`${plan.indexes.filter((i) => i.userNote).length} of your existing notes in the index folder get an Indexa section; their own text is kept`);
		if (plan.clearNotes.length) lines.push(`${plan.clearNotes.length} notes no longer in any index lose their Indexa metadata`);
		if (plan.staleIndexes.length) lines.push(`${plan.staleIndexes.length} outdated generated index notes go to the trash`);
		if (plan.moves.length) lines.push(`${plan.moves.length} notes will be moved to "${this.plugin.settings.moveTargetFolder}"`);
		lines.push("Your other frontmatter and note text are not changed. You can undo this Apply.");
		new ConfirmModal(this.plugin.app, "Apply index structure", lines, "Apply", () => void this.apply(plan)).open();
	}

	private async apply(plan: ApplyPlan) {
		this.busy = true;
		const notice = new Notice("Indexa: applying…", 0);
		try {
			const state = await this.history.state();
			const cs = await new Applier(this.plugin.app).apply(
				plan,
				state.indexFiles,
				{ addFrontmatter: this.plugin.settings.addFrontmatter, addVisibleIndexLinks: this.plugin.settings.addVisibleIndexLinks },
				(p) => notice.setMessage(`Indexa: applying… ${p.done} / ${p.total}`),
			);
			await this.history.record(cs);
			this.lastUndoable = cs;
			const s = summarize(cs);
			notice.setMessage(`Indexa: ${s.created} index notes created, ${s.modified} files updated` + (s.renamed ? `, ${s.renamed} renamed` : "") + (cs.errors.length ? `, ${cs.errors.length} skipped (see console)` : "") + ".");
			if (cs.errors.length) console.warn("[indexa] apply errors", cs.errors);
		} catch (e) {
			notice.setMessage(`Indexa: Apply failed: ${e instanceof Error ? e.message : e}`);
		} finally {
			this.busy = false;
			window.setTimeout(() => notice.hide(), 8000);
			this.plugin.refreshViews();
		}
	}

	async confirmAndUndo() {
		if (this.busy) return;
		const cs = await this.history.last();
		if (!cs) {
			new Notice("Nothing to undo.");
			return;
		}
		const when = new Date(cs.timestamp).toLocaleString();
		const s = summarize(cs);
		new ConfirmModal(
			this.plugin.app,
			"Undo last Apply",
			[
				`Apply of ${when}`,
				`${s.created} created index notes go to the trash`,
				`${s.modified} files get their previous content back (if you edited one since, only Indexa's part is removed)`,
				...(s.renamed ? [`${s.renamed} renames / moves are reversed`] : []),
				...(s.deleted ? [`${s.deleted} removed index notes are restored`] : []),
			],
			"Undo",
			() => void this.undo(cs),
		).open();
	}

	private async undo(cs: ChangeSet) {
		this.busy = true;
		const notice = new Notice("Indexa: undoing…", 0);
		try {
			const res = await new Applier(this.plugin.app).undo(cs, (p) => notice.setMessage(`Indexa: undoing… ${p.done} / ${p.total}`));
			await this.history.markUndone(cs);
			this.lastUndoable = null;
			notice.setMessage(
				`Indexa: undone. ${res.restored} files restored exactly` + (res.surgical ? `, ${res.surgical} edited files cleaned of Indexa data` : "") + (res.errors.length ? `, ${res.errors.length} problems (see console)` : "") + ".",
			);
			if (res.errors.length) console.warn("[indexa] undo problems", res.errors);
		} finally {
			this.busy = false;
			window.setTimeout(() => notice.hide(), 8000);
			this.plugin.refreshViews();
		}
	}
}
