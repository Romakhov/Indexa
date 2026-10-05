/** spec §50 */
export interface IndexNameSuggestion {
	primary?: string;
	alternatives: string[];
	keywords: string[];
	/** 0–1 */
	confidence: number;
}

export type MembershipVia = "community" | "centroid" | "chunk" | "collection";

export interface IndexMember {
	noteId: string;
	/** similarity-based confidence 0–1 (collections: 1) */
	score: number;
	/** primary index of the note, or a secondary one (multi-index, spec §42) */
	primary: boolean;
	via: MembershipVia;
	/** chunk heading that matched, for chunk-based secondary memberships (spec §43) */
	heading?: string;
}

export interface IndexProposal {
	/** stable across re-runs with the same core members */
	id: string;
	kind: "topic" | "collection";
	name: IndexNameSuggestion;
	members: IndexMember[];
	/** mean member confidence (cohesion) */
	confidence: number;
	/** most central notes first */
	sampleNoteIds: string[];
	related: { proposalId: string; similarity: number }[];
	/** collections: the metadata that defines them, e.g. "type: фильм" */
	signature?: string;
}

export interface ProposalSet {
	createdAt: number;
	proposals: IndexProposal[];
	/** notes without a confident place (spec §48) */
	unclassified: string[];
	stats: {
		contentNotes: number;
		lowContentNotes: number;
		classified: number;
		multiIndexNotes: number;
		collections: number;
		dissolvedSmall: number;
	};
}
