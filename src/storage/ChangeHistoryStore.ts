// Change history (spec §76, §78): one JSON file per Apply in the plugin folder,
// plus a small state file with the index file of every proposal.

import type { DataAdapter } from "obsidian";
import type { ChangeSet } from "../obsidian/Applier";

interface ApplyState {
	version: 1;
	/** index file per proposal id, from the last (not undone) Apply */
	indexFiles: Record<string, string>;
	/** change set ids, oldest first */
	history: string[];
}

const KEEP = 10;

export class ChangeHistoryStore {
	constructor(
		private readonly adapter: DataAdapter,
		private readonly dir: string,
	) {}

	private get statePath() {
		return `${this.dir}/apply-state.json`;
	}

	private setPath(id: string) {
		return `${this.dir}/history/${id}.json`;
	}

	async state(): Promise<ApplyState> {
		if (!(await this.adapter.exists(this.statePath))) return { version: 1, indexFiles: {}, history: [] };
		try {
			return JSON.parse(await this.adapter.read(this.statePath)) as ApplyState;
		} catch {
			return { version: 1, indexFiles: {}, history: [] };
		}
	}

	private async writeState(s: ApplyState) {
		await this.adapter.write(this.statePath, JSON.stringify(s));
	}

	async record(cs: ChangeSet) {
		if (!(await this.adapter.exists(`${this.dir}/history`))) await this.adapter.mkdir(`${this.dir}/history`);
		await this.adapter.write(this.setPath(cs.id), JSON.stringify(cs));
		const s = await this.state();
		s.history.push(cs.id);
		s.indexFiles = { ...cs.indexFiles };
		// keep the last few change sets: undo works as a stack over them
		for (const old of s.history.splice(0, Math.max(0, s.history.length - KEEP))) await this.adapter.remove(this.setPath(old)).catch(() => undefined);
		await this.writeState(s);
	}

	/** The most recent Apply that has not been undone (undo works as a stack, newest first). */
	async last(): Promise<ChangeSet | null> {
		const s = await this.state();
		for (const id of [...s.history].reverse()) {
			const p = this.setPath(id);
			if (!(await this.adapter.exists(p))) continue;
			const cs = JSON.parse(await this.adapter.read(p)) as ChangeSet;
			if (!cs.undone) return cs;
		}
		return null;
	}

	async markUndone(cs: ChangeSet) {
		await this.adapter.write(this.setPath(cs.id), JSON.stringify({ ...cs, undone: true }));
		const s = await this.state();
		s.indexFiles = { ...cs.previousIndexFiles };
		await this.writeState(s);
	}
}
