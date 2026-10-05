// Persists the latest proposals (spec §78) so Review works after a restart.
// No vectors here: names, memberships and the note paths needed to show them.

import type { DataAdapter } from "obsidian";
import type { AnalysisSummary } from "../core/AnalysisRunner";
import type { ProposalSet } from "../indexing/types";

export interface StoredAnalysis {
	version: 1;
	proposals: ProposalSet;
	/** note id -> path at analysis time */
	paths: Record<string, string>;
	/** for single-note processing after a restart */
	templateLines?: string[];
	/** notes with enough own text (define the index mean) */
	contentIds?: string[];
	summary?: AnalysisSummary;
}

export class AnalysisStore {
	constructor(
		private readonly adapter: DataAdapter,
		private readonly path: string,
	) {}

	async load(): Promise<StoredAnalysis | null> {
		if (!(await this.adapter.exists(this.path))) return null;
		try {
			const data = JSON.parse(await this.adapter.read(this.path)) as StoredAnalysis;
			return data.version === 1 ? data : null;
		} catch {
			return null;
		}
	}

	async save(data: StoredAnalysis): Promise<void> {
		await this.adapter.write(this.path, JSON.stringify(data));
	}
}
