// Builds index proposals from the analysis (spec §41–51, §59): confident topic
// indexes with multi-index membership, metadata collections, names, related
// indexes, and the unclassified rest. Pure: no Obsidian imports.

import { contentHash } from "../core/hash";
import type { KeywordExtractor } from "../keywords/KeywordExtractor";
import { detectCollections, type CollectionNote } from "./CollectionDetector";
import { classify, type ClassifierNote, type ClassifierOptions } from "./IndexClassifier";
import { suggestIndexName, TitleVocabulary } from "./IndexNamingEngine";
import type { IndexMember, IndexProposal, ProposalSet } from "./types";

export interface ProposalNote extends CollectionNote {
	title: string;
	/** centred document vector (content notes only) */
	vector?: Float32Array;
	chunks?: { heading?: string; vector: Float32Array }[];
	neighbors: string[];
}

export interface ProposalOptions extends ClassifierOptions {
	/** existing note titles in the index folder: proposals avoid duplicating them */
	existingIndexNames: string[];
	relatedPerIndex: number;
}

const dot = (a: Float32Array, b: Float32Array) => {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] * b[i];
	return s;
};

const stableId = (prefix: string, ids: string[]) => `${prefix}-${contentHash([...ids].sort().slice(0, 50).join("|")).slice(0, 10)}`;

export function buildProposals(
	notes: ProposalNote[],
	communities: Map<string, number>,
	keywords: KeywordExtractor,
	options: Partial<ProposalOptions> & Pick<ProposalOptions, "minNotes" | "maxIndexesPerNote">,
): ProposalSet {
	const relatedPerIndex = options.relatedPerIndex ?? 3;
	const byId = new Map(notes.map((n) => [n.id, n]));
	const content = notes.filter((n) => !n.lowContent && n.vector);
	// existing index names are welcome as names (Apply links to them); only avoid duplicates within a run
	const taken = new Set<string>();
	const vocabulary = new TitleVocabulary(notes.map((n) => n.title));
	const tagCount = new Map<string, number>();
	for (const n of notes) for (const t of new Set(n.tags)) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
	const vaultTagShare = new Map([...tagCount].map(([t, c]) => [t, c / Math.max(1, notes.length)]));

	// collections first: they own their notes as primary index
	const collections = detectCollections(notes, { minNotes: options.minNotes, minLowContentShare: 0.5, minFolderNotes: 5, minFolderLowContentShare: 0.8 });
	const inCollection = new Map<string, number>();
	collections.forEach((c, i) => c.noteIds.forEach((id) => inCollection.set(id, i)));

	// topics from the content notes
	const cls = classify(
		content.map<ClassifierNote>((n) => ({ id: n.id, vector: n.vector!, chunks: n.chunks, neighbors: n.neighbors })),
		communities,
		options,
	);

	const members: IndexMember[][] = cls.indexes.map(() => []);
	let multi = 0;
	for (const [noteId, ms] of cls.memberships) {
		const collection = inCollection.get(noteId);
		ms.forEach((m, i) => {
			// a note owned by a collection keeps topic indexes only as secondary
			members[m.index].push({ noteId, score: +m.score.toFixed(3), primary: m.primary && collection === undefined, via: m.via, heading: m.heading });
			if (i === 1) multi++;
		});
	}

	const tagShares = (ids: string[]) => {
		const counts = new Map<string, number>();
		for (const id of ids) for (const t of new Set(byId.get(id)?.tags ?? [])) counts.set(t, (counts.get(t) ?? 0) + 1);
		return [...counts].map(([tag, n]) => ({ tag, share: n / ids.length }));
	};

	const proposals: IndexProposal[] = [];
	/** centroid of each topic proposal, by position in `proposals` */
	const topicCentroids: Float32Array[] = [];
	cls.indexes.forEach((_, k) => {
		const ms = members[k].sort((a, b) => Number(b.primary) - Number(a.primary) || b.score - a.score);
		const primaryIds = ms.filter((m) => m.primary).map((m) => m.noteId);
		if (primaryIds.length < options.minNotes) return; // lost its notes to collections
		const central = primaryIds.slice().sort((a, b) => dot(byId.get(b)!.vector!, cls.centroids[k]) - dot(byId.get(a)!.vector!, cls.centroids[k]));
		const name = suggestIndexName({
			centralTitles: central.map((id) => byId.get(id)!.title),
			keywords: keywords.groupKeywords(primaryIds, 8),
			tagShares: tagShares(primaryIds),
			vaultTagShare,
			vocabulary,
			taken,
		});
		if (name.primary) taken.add(name.primary.toLowerCase());
		proposals.push({
			id: stableId("ix", central.slice(0, 20)),
			kind: "topic",
			name,
			members: ms,
			confidence: +(ms.filter((m) => m.primary).reduce((s, m) => s + m.score, 0) / primaryIds.length).toFixed(3),
			sampleNoteIds: central.slice(0, 5),
			related: [],
		});
		topicCentroids.push(cls.centroids[k]);
	});

	// related topics by centroid similarity (spec §59): only clearly related pairs
	const pairSims: number[] = [];
	for (let i = 0; i < proposals.length; i++) for (let j = i + 1; j < proposals.length; j++) pairSims.push(dot(topicCentroids[i], topicCentroids[j]));
	pairSims.sort((a, b) => a - b);
	const relatedCut = pairSims.length ? pairSims[Math.floor(0.9 * (pairSims.length - 1))] : 1;
	// candidates: clearly similar pairs; kept only when each is in the other's top list (mutual)
	const top = topicCentroids.map((ci, i) =>
		topicCentroids
			.map((cj, j) => ({ j, s: i === j ? -1 : dot(ci, cj) }))
			.filter((r) => r.s >= relatedCut && r.s > 0)
			.sort((a, b) => b.s - a.s)
			.slice(0, relatedPerIndex),
	);
	proposals.forEach((p, i) => {
		if (p.kind !== "topic") return;
		p.related = top[i]
			.filter((r) => top[r.j].some((x) => x.j === i))
			.map((r) => ({ proposalId: proposals[r.j].id, similarity: +r.s.toFixed(3) }));
	});

	// collections as proposals
	for (const c of collections) {
		const name = suggestIndexName({ centralTitles: [], keywords: [c.label], tagShares: [{ tag: c.label, share: 1 }], taken });
		if (name.primary) taken.add(name.primary.toLowerCase());
		proposals.push({
			id: stableId("col", [c.signature]),
			kind: "collection",
			name: { ...name, confidence: 1 },
			members: c.noteIds.map((noteId) => ({ noteId, score: 1, primary: true, via: "collection" })),
			confidence: 1,
			sampleNoteIds: c.noteIds.slice(0, 5),
			related: [],
			signature: c.signature,
		});
	}

	const placed = new Set<string>();
	for (const p of proposals) for (const m of p.members) placed.add(m.noteId);
	const unclassified = notes.filter((n) => !placed.has(n.id)).map((n) => n.id);

	return {
		createdAt: Date.now(),
		proposals,
		unclassified,
		stats: {
			contentNotes: content.length,
			lowContentNotes: notes.length - content.length,
			classified: placed.size,
			multiIndexNotes: multi,
			collections: collections.length,
			dissolvedSmall: cls.dissolved,
		},
	};
}
