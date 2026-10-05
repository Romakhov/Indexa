export interface IndexaSettings {
	version: 1;

	// Apply
	indexFolder: string;
	moveNotesAfterApply: boolean;
	moveTargetFolder: string;
	addFrontmatter: boolean;
	addVisibleIndexLinks: boolean;

	// Model
	embeddingModel: string;

	// Scope
	excludedFolders: string[];
	excludedTags: string[];

	// Incremental mode
	autoAnalyzeNewNotes: boolean;
	askBeforeAssigning: boolean;
	debounceMs: number;

	// Proposals
	/** 1 (few broad indexes) … 10 (many narrow ones). */
	detailLevel: number;
	minNotesPerIndex: number;
	maxIndexesPerNote: number;

	// Advanced
	showAdvanced: boolean;
	/** 0–100, relative (rank-based), not a raw cosine value. */
	semanticThreshold: number;
	topK: number;
	/** parallel embedding workers; each holds its own model copy (~300 MB RAM) */
	embeddingWorkers: number;
	debugLogging: boolean;
}

export const DEFAULT_SETTINGS: IndexaSettings = {
	version: 1,
	indexFolder: "Indexes",
	moveNotesAfterApply: false,
	moveTargetFolder: "Zettelkasten",
	addFrontmatter: true,
	addVisibleIndexLinks: false,
	embeddingModel: "multilingual-e5-small",
	excludedFolders: ["Templates"],
	excludedTags: ["zk-ignore"],
	autoAnalyzeNewNotes: true,
	askBeforeAssigning: true,
	debounceMs: 3000,
	detailLevel: 5,
	minNotesPerIndex: 3,
	maxIndexesPerNote: 3,
	showAdvanced: false,
	semanticThreshold: 50,
	topK: 15,
	embeddingWorkers: 2,
	debugLogging: false,
};

const clamp = (v: unknown, min: number, max: number, def: number) =>
	typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;

const stringList = (v: unknown, def: string[]) =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : def;

/** Merges stored data over defaults and repairs invalid values from older versions. */
export function normalizeSettings(raw: unknown): IndexaSettings {
	const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof IndexaSettings, unknown>>;
	const s = { ...DEFAULT_SETTINGS, ...(r as Partial<IndexaSettings>) };
	return {
		...s,
		version: 1,
		indexFolder: typeof s.indexFolder === "string" && s.indexFolder.trim() ? s.indexFolder.trim().replace(/\/+$/, "") : DEFAULT_SETTINGS.indexFolder,
		moveTargetFolder: typeof s.moveTargetFolder === "string" && s.moveTargetFolder.trim() ? s.moveTargetFolder.trim().replace(/\/+$/, "") : DEFAULT_SETTINGS.moveTargetFolder,
		excludedFolders: stringList(r.excludedFolders, DEFAULT_SETTINGS.excludedFolders).map((f) => f.replace(/\/+$/, "")),
		excludedTags: stringList(r.excludedTags, DEFAULT_SETTINGS.excludedTags).map((t) => t.replace(/^#/, "")),
		debounceMs: clamp(s.debounceMs, 500, 60_000, DEFAULT_SETTINGS.debounceMs),
		detailLevel: clamp(s.detailLevel, 1, 10, DEFAULT_SETTINGS.detailLevel),
		minNotesPerIndex: clamp(s.minNotesPerIndex, 2, 50, DEFAULT_SETTINGS.minNotesPerIndex),
		maxIndexesPerNote: clamp(s.maxIndexesPerNote, 1, 10, DEFAULT_SETTINGS.maxIndexesPerNote),
		semanticThreshold: clamp(s.semanticThreshold, 0, 100, DEFAULT_SETTINGS.semanticThreshold),
		topK: clamp(s.topK, 5, 50, DEFAULT_SETTINGS.topK),
		embeddingWorkers: Math.round(clamp(s.embeddingWorkers, 1, 4, DEFAULT_SETTINGS.embeddingWorkers)),
	};
}
