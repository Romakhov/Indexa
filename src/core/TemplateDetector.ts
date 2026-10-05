// Finds boilerplate lines that repeat across many notes (spec §16: "повторяющиеся
// template fragments"). Gate 0c showed that without this, template-made notes
// cluster by their template instead of their meaning.

export interface TemplateDetectorOptions {
	/** a line must appear in at least this many notes … */
	minNotes: number;
	/** … and in at least this share of all notes */
	minShare: number;
}

export const DEFAULT_TEMPLATE_OPTIONS: TemplateDetectorOptions = { minNotes: 5, minShare: 0.03 };

/**
 * Lines are compared after lower-casing, collapsing whitespace and replacing
 * digits, so "Оценка: 6/10 · Год: 2015" and "Оценка: 8/10 · Год: 2019" are
 * the same template line.
 */
export function normalizeLine(line: string): string {
	return line.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

export class TemplateLines {
	constructor(private readonly lines: ReadonlySet<string>) {}

	static empty() {
		return new TemplateLines(new Set());
	}

	get size() {
		return this.lines.size;
	}

	has(line: string): boolean {
		return this.lines.has(normalizeLine(line));
	}
}

/** @param bodies per note: its cleaned body lines */
export function detectTemplateLines(bodies: string[][], opts: TemplateDetectorOptions = DEFAULT_TEMPLATE_OPTIONS): TemplateLines {
	const df = new Map<string, number>();
	for (const lines of bodies) {
		for (const l of new Set(lines.map(normalizeLine))) if (l) df.set(l, (df.get(l) ?? 0) + 1);
	}
	const threshold = Math.max(opts.minNotes, Math.ceil(bodies.length * opts.minShare));
	return new TemplateLines(new Set([...df].filter(([, n]) => n >= threshold).map(([l]) => l)));
}
