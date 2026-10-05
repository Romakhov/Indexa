// Review UI (spec §53–54): index cards with rename / merge / split / ignore,
// member lists with add / remove / make-primary, unclassified notes with
// one-click assignment, and the pending-decisions summary.

import { setIcon, setTooltip, type App } from "obsidian";
import type IndexaPlugin from "../main";
import type { EffectiveIndex, EffectiveReview } from "../review/ReviewState";
import { IndexSuggestModal, NoteSuggestModal, RenameModal } from "./modals";

const pct = (x: number) => `${Math.round(x * 100)}%`;

function iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void, cls = "") {
	const b = parent.createEl("button", { cls: `clickable-icon indexa-icon-btn ${cls}`, attr: { "aria-label": label } });
	setIcon(b, icon);
	setTooltip(b, label);
	b.onclick = (e) => {
		e.stopPropagation();
		onClick();
	};
	return b;
}

export class ReviewPanels {
	/** expanded index cards survive re-renders */
	private expanded = new Set<string>();

	constructor(
		private readonly app: App,
		private readonly plugin: IndexaPlugin,
	) {}

	private noteLink(el: HTMLElement, noteId: string) {
		const path = this.plugin.pathOf(noteId);
		const title = path ? path.split("/").pop()!.replace(/\.md$/, "") : "(missing note)";
		const a = el.createEl("a", { cls: "indexa-note-link", text: title, href: "#" });
		if (path) {
			a.setAttr("title", path);
			a.onclick = (e) => {
				e.preventDefault();
				void this.app.workspace.openLinkText(path, "", false);
			};
		}
		return a;
	}

	renderIndexes(el: HTMLElement, review: EffectiveReview) {
		const live = review.indexes.filter((i) => !i.ignored);
		const ignored = review.indexes.filter((i) => i.ignored);
		const topics = live.filter((i) => i.kind === "topic").length;
		el.createDiv({ cls: "indexa-muted", text: `${topics} indexes · ${live.length - topics} collections${ignored.length ? ` · ${ignored.length} ignored` : ""} · nothing is written until Apply` });
		for (const index of live) this.indexCard(el, index, review);
		if (ignored.length) {
			el.createEl("h5", { text: "Ignored", cls: "indexa-section" });
			for (const index of ignored) this.indexCard(el, index, review);
		}
	}

	private indexCard(parent: HTMLElement, index: EffectiveIndex, review: EffectiveReview) {
		const p = this.plugin;
		const primary = index.members.filter((m) => m.primary);
		const secondary = index.members.length - primary.length;
		const card = parent.createDiv({ cls: "indexa-card indexa-index" + (index.ignored ? " is-ignored" : "") });

		const head = card.createDiv({ cls: "indexa-index-head" });
		const title = head.createDiv({ cls: "indexa-index-title" });
		title.createSpan({ cls: "indexa-index-name" + (index.unnamed ? " is-unnamed" : ""), text: index.name });
		if (index.renamed) title.createSpan({ cls: "indexa-badge", text: "renamed" });
		if (index.kind === "collection") title.createSpan({ cls: "indexa-badge", text: "collection" });
		title.createSpan({ cls: "indexa-index-count", text: secondary ? `${primary.length} + ${secondary}` : String(primary.length) });

		const actions = head.createDiv({ cls: "indexa-actions-row" });
		if (index.ignored) {
			iconButton(actions, "undo-2", "Restore", () => void p.review.toggleIgnore(index.id));
		} else {
			iconButton(actions, "pencil", "Rename", () => new RenameModal(this.app, index, (name) => void p.review.rename(index.id, name)).open());
			const targets = review.indexes.filter((i) => !i.ignored && i.id !== index.id);
			iconButton(actions, "merge", "Merge into another index", () =>
				new IndexSuggestModal(this.app, targets, `Merge "${index.name}" into…`, (t) => void p.review.merge(index.id, t.id)).open(),
			);
			if (index.kind === "topic") iconButton(actions, "split", "Split into narrower topics", () => void p.review.split(index.id));
			iconButton(actions, "eye-off", "Ignore this index", () => void p.review.toggleIgnore(index.id));
		}

		if (index.kind === "collection") card.createDiv({ cls: "indexa-muted", text: `Grouped by ${index.signature}` });
		else {
			card.createDiv({ cls: "indexa-keywords", text: index.keywords.slice(0, 6).join(" · ") });
			const meta = [`confidence ${pct(index.confidence)}`];
			if (index.mergedFrom.length) meta.push(`merged ${index.mergedFrom.length}`);
			card.createDiv({ cls: "indexa-muted", text: meta.join(" · ") });
		}

		const isOpen = this.expanded.has(index.id);
		if (!isOpen) {
			const samples = card.createDiv({ cls: "indexa-samples" });
			index.sampleNoteIds.filter((id) => index.members.some((m) => m.noteId === id)).slice(0, 4).forEach((id) => this.noteLink(samples, id));
		}
		const toggle = card.createEl("a", { cls: "indexa-toggle", href: "#", text: isOpen ? "Hide notes" : `Show all ${index.members.length} notes` });
		toggle.onclick = (e) => {
			e.preventDefault();
			if (isOpen) this.expanded.delete(index.id);
			else this.expanded.add(index.id);
			p.refreshViews();
		};
		if (isOpen) this.memberList(card, index);
	}

	private memberList(card: HTMLElement, index: EffectiveIndex) {
		const p = this.plugin;
		const list = card.createDiv({ cls: "indexa-members" });
		const ordered = [...index.members].sort((a, b) => Number(b.primary) - Number(a.primary) || b.score - a.score);
		for (const m of ordered.slice(0, 200)) {
			const row = list.createDiv({ cls: "indexa-member" });
			this.noteLink(row, m.noteId);
			const info = row.createSpan({ cls: "indexa-muted" });
			if (m.manual) info.setText("added by you");
			else if (!m.primary) info.setText(`also here · ${pct(m.score)}${m.via === "chunk" && m.heading ? ` · section "${m.heading.split(" › ").pop()}"` : ""}`);
			const actions = row.createSpan({ cls: "indexa-actions-row" });
			if (!m.primary && !index.ignored) iconButton(actions, "star", "Make this the note's main index", () => void p.review.setPrimary(m.noteId, index.id));
			if (!index.ignored) iconButton(actions, "x", "Remove from this index", () => void p.review.removeNote(index.id, m.noteId));
		}
		if (index.members.length > 200) list.createDiv({ cls: "indexa-muted", text: `… and ${index.members.length - 200} more` });
		if (!index.ignored) {
			const add = card.createEl("button", { cls: "indexa-add", text: "Add note…" });
			add.onclick = () => new NoteSuggestModal(this.app, this.app.vault.getMarkdownFiles(), (f) => void p.review.addNote(index.id, f.path)).open();
		}
	}

	renderUnclassified(el: HTMLElement, review: EffectiveReview) {
		const p = this.plugin;
		el.createDiv({ cls: "indexa-muted", text: `${review.unclassified.length} notes without a confident index. That is fine: not every note has to belong somewhere.` });
		const live = review.indexes.filter((i) => !i.ignored);
		const byId = new Map(live.map((i) => [i.id, i]));
		const suggestions = p.stored?.proposals.suggestions ?? {};
		const list = el.createDiv({ cls: "indexa-members" });
		for (const noteId of review.unclassified.slice(0, 300)) {
			const row = list.createDiv({ cls: "indexa-member" });
			this.noteLink(row, noteId);
			const chips = row.createSpan({ cls: "indexa-chips" });
			const resolved = (suggestions[noteId] ?? []).map((x) => ({ ...x, proposalId: p.review.resolve(x.proposalId) }));
			const unique = resolved.filter((x, i) => byId.has(x.proposalId) && resolved.findIndex((y) => y.proposalId === x.proposalId) === i);
			for (const s of unique.slice(0, 2)) {
				const b = chips.createEl("button", { cls: "indexa-chip", text: s.score >= 0.05 ? `${byId.get(s.proposalId)!.name} ${pct(s.score)}` : byId.get(s.proposalId)!.name });
				setTooltip(b, "Closest index: add the note to it");
				b.onclick = () => void p.review.addNoteById(s.proposalId, noteId);
			}
			iconButton(chips, "plus", "Add to an index…", () => new IndexSuggestModal(this.app, live, "Add to index…", (t) => void p.review.addNoteById(t.id, noteId)).open());
		}
		if (review.unclassified.length > 300) el.createDiv({ cls: "indexa-muted", text: `… and ${review.unclassified.length - 300} more` });
	}

	renderReview(el: HTMLElement, review: EffectiveReview) {
		const p = this.plugin;
		const live = review.indexes.filter((i) => !i.ignored);
		const card = el.createDiv({ cls: "indexa-card" });
		card.createEl("h4", { text: "Review" });
		card.createDiv({ text: `${live.length} indexes will be created · ${live.reduce((n, i) => n + i.members.length, 0)} note links · ${review.unclassified.length} notes stay unclassified` });
		card.createDiv({ cls: "indexa-muted", text: `${review.decisions} change(s) made by you. They are kept when you analyse again.` });
		const actions = card.createDiv({ cls: "indexa-actions" });
		const apply = actions.createEl("button", { cls: "mod-cta", text: "Apply…" });
		apply.onclick = () => void p.applier.confirmAndApply();
		const last = p.applier.lastUndoable;
		if (last) {
			const undo = actions.createEl("button", { text: "Undo last Apply" });
			setTooltip(undo, `Applied ${new Date(last.timestamp).toLocaleString()}`);
			undo.onclick = () => void p.applier.confirmAndUndo();
		}
		if (review.decisions) {
			const reset = actions.createEl("button", { text: "Discard my changes" });
			reset.onclick = () => void p.review.reset();
		}
	}
}
