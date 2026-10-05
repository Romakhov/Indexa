/**
 * Remaining-time estimate for a long stage (first analysis of a large vault
 * can take tens of minutes). Rate is measured from the stage's first progress
 * report, so work served from the cache at the start does not distort it.
 */
export class StageEta {
	private stage: string | null = null;
	private t0 = 0;
	private done0 = 0;
	private rebased = false;

	/** @returns remaining milliseconds, or null while there is not enough data */
	update(stage: string, done: number, total: number, now = performance.now()): number | null {
		// a stage often starts with a 0 report followed by a jump (work served from the
		// cache): measure from the first non-zero report
		if (stage !== this.stage || (this.done0 === 0 && done > 0 && !this.rebased)) {
			this.rebased = stage === this.stage;
			this.stage = stage;
			this.t0 = now;
			this.done0 = done;
			return null;
		}
		const elapsed = now - this.t0;
		const progressed = done - this.done0;
		if (elapsed < 15000 || progressed <= 0 || total <= done) return null;
		return ((total - done) * elapsed) / progressed;
	}
}

export function formatRemaining(ms: number): string {
	const min = Math.round(ms / 60000);
	if (min < 1) return "less than a minute left";
	if (min < 60) return `about ${min} min left`;
	const h = Math.floor(min / 60);
	return `about ${h} h ${min % 60} min left`;
}
