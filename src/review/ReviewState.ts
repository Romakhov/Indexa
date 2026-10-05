// User review decisions (spec §52–54), kept separately from the proposals:
// proposals are recomputed on every analysis, decisions are layered on top and
// survive re-analysis because proposal ids are reconciled by member overlap.
// Pure: no Obsidian imports.

import type { IndexMember, IndexProposal, ProposalSet } from "../indexing/types";

export interface ReviewState {
	version: 1;
	/** proposal id -> user-chosen name */
	names: Record<string, string>;
	ignored: string[];
	/** proposal id -> proposal id it was merged into */
	mergedInto: Record<string, string>;
	/** proposal id -> notes added by the user */
	added: Record<string, string[]>;
	/** proposal id -> notes removed by the user */
	removed: Record<string, string[]>;
	/** note id -> proposal id that must be its primary index */
	primary: Record<string, string>;
	/** proposal ids the user split; re-applied after each analysis */
	splits: string[];
}

export const emptyReview = (): ReviewState => ({ version: 1, names: {}, ignored: [], mergedInto: {}, added: {}, removed: {}, primary: {}, splits: [] });

export interface EffectiveMember extends IndexMember {
	/** added by the user */
	manual?: boolean;
}

export interface EffectiveIndex {
	id: string;
	kind: IndexProposal["kind"];
	name: string;
	/** the user renamed it (name is pinned) */
	renamed: boolean;
	unnamed: boolean;
	/** name candidates: proposal suggestion + alternatives */
	nameOptions: string[];
	keywords: string[];
	confidence: number;
	members: EffectiveMember[];
	sampleNoteIds: string[];
	related: string[];
	ignored: boolean;
	/** ids of proposals merged into this one */
	mergedFrom: string[];
	signature?: string;
}

export interface EffectiveReview {
	indexes: EffectiveIndex[];
	/** notes without any index after the user's decisions */
	unclassified: string[];
	/** how many decisions are recorded (for the Review tab) */
	decisions: number;
}

const resolveTarget = (id: string, mergedInto: Record<string, string>) => {
	const seen = new Set<string>();
	let cur = id;
	while (mergedInto[cur] && !seen.has(cur)) {
		seen.add(cur);
		cur = mergedInto[cur];
	}
	return cur;
};

export function countDecisions(r: ReviewState): number {
	const lists = (o: Record<string, string[]>) => Object.values(o).reduce((n, l) => n + l.length, 0);
	return Object.keys(r.names).length + r.ignored.length + Object.keys(r.mergedInto).length + lists(r.added) + lists(r.removed) + Object.keys(r.primary).length + r.splits.length;
}

/** Applies the user's decisions to a proposal set. */
export function applyReview(set: ProposalSet, review: ReviewState): EffectiveReview {
	const byId = new Map(set.proposals.map((p) => [p.id, p]));
	const ignored = new Set(review.ignored);
	const out = new Map<string, EffectiveIndex>();

	for (const p of set.proposals) {
		const target = resolveTarget(p.id, review.mergedInto);
		if (target !== p.id && byId.has(target)) continue; // folded into its target below
		const name = review.names[p.id] ?? p.name.primary;
		out.set(p.id, {
			id: p.id,
			kind: p.kind,
			name: name ?? "Unnamed topic",
			renamed: review.names[p.id] !== undefined,
			unnamed: name === undefined,
			nameOptions: [...new Set([p.name.primary, ...p.name.alternatives].filter((x): x is string => !!x))],
			keywords: p.name.keywords,
			confidence: p.confidence,
			members: p.members.map((m) => ({ ...m })),
			sampleNoteIds: p.sampleNoteIds,
			related: p.related.map((r) => r.proposalId),
			ignored: ignored.has(p.id),
			mergedFrom: [],
			signature: p.signature,
		});
	}
	// merges: union of members, the target keeps its name
	for (const p of set.proposals) {
		const target = resolveTarget(p.id, review.mergedInto);
		if (target === p.id || !out.has(target)) continue;
		const t = out.get(target)!;
		t.mergedFrom.push(p.id);
		const have = new Map(t.members.map((m) => [m.noteId, m]));
		for (const m of p.members) {
			const existing = have.get(m.noteId);
			if (!existing) {
				t.members.push({ ...m });
				have.set(m.noteId, t.members[t.members.length - 1]);
			} else existing.primary = existing.primary || m.primary;
		}
		t.keywords = [...new Set([...t.keywords, ...p.name.keywords])].slice(0, 10);
	}
	// manual additions and removals (decisions on merged-away ids apply to their target)
	for (const [pid, notes] of Object.entries(review.added)) {
		const t = out.get(resolveTarget(pid, review.mergedInto));
		if (!t) continue;
		for (const noteId of notes) if (!t.members.some((m) => m.noteId === noteId)) t.members.push({ noteId, score: 1, primary: true, via: "community", manual: true });
	}
	for (const [pid, notes] of Object.entries(review.removed)) {
		const t = out.get(resolveTarget(pid, review.mergedInto));
		if (t) t.members = t.members.filter((m) => !notes.includes(m.noteId));
	}

	// one primary index per note: user override, else the best-scoring primary membership
	const live = [...out.values()].filter((i) => !i.ignored);
	const memberships = new Map<string, { index: EffectiveIndex; member: EffectiveMember }[]>();
	for (const index of live) for (const member of index.members) memberships.set(member.noteId, [...(memberships.get(member.noteId) ?? []), { index, member }]);
	for (const [noteId, ms] of memberships) {
		const forced = review.primary[noteId] ? resolveTarget(review.primary[noteId], review.mergedInto) : undefined;
		const chosen = ms.find((x) => x.index.id === forced) ?? ms.filter((x) => x.member.primary).sort((a, b) => b.member.score - a.member.score)[0] ?? ms[0];
		for (const x of ms) x.member.primary = x === chosen;
	}

	const placed = new Set(memberships.keys());
	const allNotes = new Set([...set.unclassified, ...set.proposals.flatMap((p) => p.members.map((m) => m.noteId))]);
	const unclassified = [...allNotes].filter((id) => !placed.has(id));
	const indexes = [...out.values()].sort((a, b) => Number(a.ignored) - Number(b.ignored) || Number(a.kind === "collection") - Number(b.kind === "collection") || b.members.length - a.members.length);
	return { indexes, unclassified, decisions: countDecisions(review) };
}

/**
 * Carries proposal ids over from the previous analysis: a new proposal that
 * shares enough members with an old one takes over its id, so the user's
 * decisions keep applying after re-analysis. Greedy by overlap.
 */
export function reconcileIds(prev: ProposalSet | null, next: ProposalSet, minJaccard = 0.4): ProposalSet {
	if (!prev) return next;
	// parts of a split index count as the original index: a fresh analysis
	// re-forms the original group, which must get the original id back
	const parts = new Map<string, IndexProposal[]>();
	const whole: IndexProposal[] = [];
	for (const p of prev.proposals) {
		if (p.splitFrom) parts.set(p.splitFrom, [...(parts.get(p.splitFrom) ?? []), p]);
		else whole.push(p);
	}
	for (const [id, ps] of parts) whole.push({ ...ps[0], id, splitFrom: undefined, members: ps.flatMap((x) => x.members) });
	prev = { ...prev, proposals: whole };
	const primaryOf = (p: IndexProposal) => new Set(p.members.filter((m) => m.primary).map((m) => m.noteId));
	const pairs: { a: IndexProposal; b: IndexProposal; j: number }[] = [];
	for (const b of next.proposals) {
		const nb = primaryOf(b);
		for (const a of prev.proposals) {
			if (a.kind !== b.kind) continue;
			const na = primaryOf(a);
			let inter = 0;
			for (const x of nb) if (na.has(x)) inter++;
			const j = inter / (na.size + nb.size - inter || 1);
			if (j >= minJaccard) pairs.push({ a, b, j });
		}
	}
	pairs.sort((x, y) => y.j - x.j);
	const rename = new Map<string, string>();
	const usedOld = new Set<string>();
	for (const { a, b } of pairs) {
		if (rename.has(b.id) || usedOld.has(a.id)) continue;
		rename.set(b.id, a.id);
		usedOld.add(a.id);
	}
	// a new id must not collide with an old id taken over by another proposal
	const taken = new Set(rename.values());
	const fix = (id: string) => rename.get(id) ?? (taken.has(id) ? `${id}-n` : id);
	return {
		...next,
		proposals: next.proposals.map((p) => ({ ...p, id: fix(p.id), related: p.related.map((r) => ({ ...r, proposalId: fix(r.proposalId) })) })),
		suggestions: Object.fromEntries(Object.entries(next.suggestions ?? {}).map(([n, s]) => [n, s.map((x) => ({ ...x, proposalId: fix(x.proposalId) }))])),
	};
}
