// Review actions (spec §54). Every action records a decision in ReviewState,
// persists it and refreshes the view; the vault itself is never touched here.

import { Notice } from "obsidian";
import { buildProposals } from "../indexing/IndexProposalEngine";
import type { ProposalSet } from "../indexing/types";
import type IndexaPlugin from "../main";
import { applyReview, emptyReview, type EffectiveReview, type ReviewState } from "./ReviewState";

const FILE = "review.json";

export class ReviewController {
	state: ReviewState = emptyReview();

	constructor(private readonly plugin: IndexaPlugin) {}

	private get path() {
		return `${this.plugin.manifest.dir}/${FILE}`;
	}

	async load() {
		const adapter = this.plugin.app.vault.adapter;
		if (!(await adapter.exists(this.path))) return;
		try {
			const data = JSON.parse(await adapter.read(this.path)) as (Partial<ReviewState> & { version?: number }) | null;
			if (data?.version === 1) this.state = { ...emptyReview(), ...data };
		} catch (e) {
			console.warn("[indexa] review state unreadable, starting fresh", e);
		}
	}

	private async commit() {
		await this.plugin.app.vault.adapter.write(this.path, JSON.stringify(this.state));
		this.plugin.refreshViews();
	}

	effective(): EffectiveReview | null {
		const set = this.plugin.stored?.proposals;
		if (!set) return null;
		const r = applyReview(set, this.state);
		// notes deleted since the analysis disappear from indexes and from Unclassified
		const exists = (id: string) => this.plugin.pathOf(id) !== undefined;
		for (const i of r.indexes) i.members = i.members.filter((m) => exists(m.noteId));
		r.unclassified = r.unclassified.filter(exists);
		return r;
	}

	/** follows merges: the index a (possibly merged-away) proposal id ends up in */
	resolve(id: string): string {
		const seen = new Set<string>();
		let cur = id;
		while (this.state.mergedInto[cur] && !seen.has(cur)) {
			seen.add(cur);
			cur = this.state.mergedInto[cur];
		}
		return cur;
	}

	async rename(id: string, name: string) {
		this.state.names[id] = name;
		await this.commit();
	}

	async toggleIgnore(id: string) {
		const i = this.state.ignored.indexOf(id);
		if (i >= 0) this.state.ignored.splice(i, 1);
		else this.state.ignored.push(id);
		await this.commit();
	}

	async merge(source: string, target: string) {
		// refuse cycles (target already folded into source)
		let cur: string | undefined = target;
		const seen = new Set<string>();
		while (cur && !seen.has(cur)) {
			if (cur === source) return;
			seen.add(cur);
			cur = this.state.mergedInto[cur];
		}
		this.state.mergedInto[source] = target;
		await this.commit();
	}

	async addNote(id: string, path: string) {
		const noteId = this.plugin.noteIdFor(path);
		await this.addNoteById(id, noteId);
	}

	async addNoteById(id: string, noteId: string) {
		const removed = this.state.removed[id];
		if (removed?.includes(noteId)) this.state.removed[id] = removed.filter((n) => n !== noteId);
		else this.state.added[id] = [...new Set([...(this.state.added[id] ?? []), noteId])];
		await this.commit();
	}

	async removeNote(id: string, noteId: string) {
		const added = this.state.added[id];
		if (added?.includes(noteId)) this.state.added[id] = added.filter((n) => n !== noteId);
		else this.state.removed[id] = [...new Set([...(this.state.removed[id] ?? []), noteId])];
		if (this.state.primary[noteId] === id) delete this.state.primary[noteId];
		await this.commit();
	}

	async setPrimary(noteId: string, id: string) {
		this.state.primary[noteId] = id;
		await this.commit();
	}

	async reset() {
		this.state = emptyReview();
		await this.commit();
	}

	/** Split/re-run (spec §54): re-cluster one index's notes at a finer resolution. */
	async split(id: string, quiet = false): Promise<boolean> {
		const p = this.plugin;
		if (!p.lastResult?.proposalNotes) {
			if (!quiet) new Notice("Re-analysing to split (uses the cache, takes a moment)…");
			await p.analyzeVault();
		}
		const r = p.lastResult;
		const set = p.stored?.proposals;
		const index = this.effective()?.indexes.find((i) => i.id === id);
		if (!r?.proposalNotes || !r.keywords || !set || !index) return false;

		const memberIds = index.members.filter((m) => m.primary).map((m) => m.noteId);
		const members = new Set(memberIds);
		// the induced subgraph of one index is sparse: start low and take the first
		// resolution that yields >= 2 real subtopics covering most of the notes
		const minNotes = p.settings.minNotesPerIndex;
		let communities: Map<string, number> | null = null;
		for (const resolution of [0.5, 1, 2, 3, 4.5]) {
			const res = await p.getVectorIndex().cluster({
				k: p.settings.topK,
				noteIds: [],
				features: [],
				include: memberIds,
				weights: p.settings.edgeWeights,
				resolution,
				seed: 1,
				refineMaxShare: null,
			});
			const map = new Map<string, number>();
			res.ids.forEach((nid, i) => res.community[i] >= 0 && map.set(nid, res.community[i]));
			const sizes = new Map<number, number>();
			for (const c of map.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
			const real = [...sizes.values()].filter((n) => n >= minNotes);
			if (real.length >= 2 && real.reduce((a, b) => a + b, 0) >= 0.6 * memberIds.length) {
				communities = map;
				break;
			}
		}
		const sub: ProposalSet | null = communities
			? await buildProposals(
					r.proposalNotes.filter((n) => members.has(n.id)),
					communities,
					r.keywords,
					{ minNotes: p.settings.minNotesPerIndex, maxIndexesPerNote: 1, minConfidence: 0.2 },
				)
			: null;
		const parts = sub?.proposals.filter((x) => x.kind === "topic") ?? [];
		if (parts.length < 2) {
			if (!quiet) new Notice(`"${index.name}" has no clear subtopics to split into.`);
			return false;
		}
		const existing = new Set(set.proposals.map((x) => x.id));
		for (const part of parts) {
			if (existing.has(part.id)) part.id = `${part.id}-s`;
			part.members = part.members.filter((m) => m.primary);
			part.splitFrom = id;
		}
		set.proposals = [...set.proposals.filter((x) => x.id !== id), ...parts];
		set.unclassified = [...new Set([...set.unclassified, ...(sub?.unclassified ?? []).filter((n) => members.has(n))])];
		// decisions about the old index no longer have a target
		delete this.state.names[id];
		this.state.ignored = this.state.ignored.filter((x) => x !== id);
		if (!this.state.splits.includes(id)) this.state.splits.push(id);
		await p.saveStored();
		await this.commit();
		if (!quiet) new Notice(`Split "${index.name}" into ${parts.length} indexes.`);
		return true;
	}

	/** After a fresh analysis: indexes the user split before are split again. */
	async reapplySplits() {
		const ids = new Set(this.plugin.stored?.proposals.proposals.map((x) => x.id) ?? []);
		for (const id of [...this.state.splits]) if (ids.has(id)) await this.split(id, true);
	}
}
