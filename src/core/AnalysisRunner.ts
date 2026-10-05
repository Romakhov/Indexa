// Orchestrates the analysis pipeline with stage progress and cancellation
// (spec §66–67). Phase 1 implements Scanning + Processing; later phases add
// the remaining stages. Never mutates the vault.

import type { NoteDocument, ProcessedNote } from "../types/NoteDocument";
import type { EmbeddingCache } from "../embeddings/EmbeddingCache";
import type { EmbeddingProvider } from "../embeddings/EmbeddingProvider";
import { EmbeddingCancelled, embedNotes, type NoteToEmbed } from "../embeddings/NoteEmbedder";
import { bodyLines, processNote } from "./MarkdownProcessor";
import { chunkNote, type Chunk } from "./SemanticChunker";
import { detectTemplateLines } from "./TemplateDetector";
import type { ObsidianVaultScanner, ScanResult } from "./VaultScanner";
import { timeSlicer } from "./yieldToUi";

export const STAGES = ["Scanning", "Processing", "Embedding", "Building vector index", "Detecting communities", "Building proposals"] as const;
export type Stage = (typeof STAGES)[number];

export interface Progress {
	stage: Stage;
	stageIndex: number;
	stageCount: number;
	done: number;
	total: number;
}

export interface AnalysisSummary {
	finishedAt: number;
	totalFiles: number;
	analysable: number;
	excluded: ScanResult["excluded"];
	lowContent: number;
	templateLines: number;
	errors: { path: string; message: string }[];
	durationMs: number;
	embedding?: {
		embedded: number;
		fromCache: number;
		notesWithChunks: number;
		chunks: number;
		ms: number;
	};
}

export interface EmbeddingDeps {
	provider: EmbeddingProvider;
	cache: EmbeddingCache;
	/** batches in flight (= worker pool size) */
	parallel: number;
}

export interface AnalysisResult {
	summary: AnalysisSummary;
	notes: NoteDocument[];
	processed: ProcessedNote[];
	chunks: Map<string, Chunk[]>;
}

export class AnalysisCancelled extends Error {
	constructor() {
		super("Analysis cancelled");
	}
}

export class AnalysisRunner {
	/** @param embedding omit to stop after text preparation (e.g. model not installed) */
	constructor(
		private readonly scanner: ObsidianVaultScanner,
		private readonly embedding?: EmbeddingDeps,
	) {}

	async run(onProgress: (p: Progress) => void, signal: AbortSignal): Promise<AnalysisResult> {
		const t0 = performance.now();
		const report = (stage: Stage, done: number, total: number) =>
			onProgress({ stage, stageIndex: STAGES.indexOf(stage), stageCount: STAGES.length, done, total });
		const check = () => {
			if (signal.aborted) throw new AnalysisCancelled();
		};

		report("Scanning", 0, 0);
		let scan: ScanResult;
		try {
			scan = await this.scanner.scanWithStats(signal);
		} catch (e) {
			if (signal.aborted) throw new AnalysisCancelled();
			throw e;
		}
		report("Scanning", scan.total, scan.total);
		check();

		// Processing: corpus-level template detection, then per-note cleanup.
		// One broken note must not stop the analysis (spec §82).
		const errors: AnalysisSummary["errors"] = [];
		const maybeYield = timeSlicer();
		const bodies: string[][] = [];
		for (const n of scan.notes) {
			try {
				bodies.push(bodyLines(n));
			} catch {
				bodies.push([]);
			}
			await maybeYield();
		}
		check();
		const templates = detectTemplateLines(bodies);
		const processed: ProcessedNote[] = [];
		const notes: NoteDocument[] = [];
		for (let i = 0; i < scan.notes.length; i++) {
			check();
			try {
				processed.push(processNote(scan.notes[i], templates));
				notes.push(scan.notes[i]);
			} catch (e) {
				errors.push({ path: scan.notes[i].path, message: e instanceof Error ? e.message : String(e) });
			}
			if (i % 50 === 0) report("Processing", i, scan.notes.length);
			await maybeYield();
		}
		report("Processing", scan.notes.length, scan.notes.length);

		const chunks = new Map<string, Chunk[]>();
		let embeddingSummary: AnalysisSummary["embedding"];
		if (this.embedding) {
			const { provider, cache, parallel } = this.embedding;
			const toEmbed: NoteToEmbed[] = [];
			for (let i = 0; i < notes.length; i++) {
				let c: Chunk[] = [];
				try {
					c = chunkNote(notes[i], templates);
				} catch (e) {
					errors.push({ path: notes[i].path, message: `chunking: ${e instanceof Error ? e.message : e}` });
				}
				chunks.set(processed[i].noteId, c);
				toEmbed.push({ processed: processed[i], chunks: c });
				await maybeYield();
			}
			check();
			const te = performance.now();
			report("Embedding", 0, toEmbed.length);
			await cache.load();
			try {
				const res = await embedNotes(toEmbed, provider, cache, {
					parallel,
					signal,
					onProgress: (p) => report("Embedding", p.done, p.total),
					onCheckpoint: () => cache.save(),
				});
				cache.retainOnly(processed.map((p) => p.noteId));
				embeddingSummary = {
					...res,
					notesWithChunks: toEmbed.filter((n) => n.chunks.length).length,
					chunks: toEmbed.reduce((n, x) => n + x.chunks.length, 0),
					ms: Math.round(performance.now() - te),
				};
			} catch (e) {
				if (e instanceof EmbeddingCancelled || signal.aborted) throw new AnalysisCancelled();
				throw e;
			} finally {
				// finished notes survive a cancel or an error (spec §67)
				await cache.save();
			}
		}

		return {
			notes,
			processed,
			chunks,
			summary: {
				embedding: embeddingSummary,
				finishedAt: Date.now(),
				totalFiles: scan.total,
				analysable: processed.length,
				excluded: scan.excluded,
				lowContent: processed.filter((p) => p.lowContent).length,
				templateLines: templates.size,
				errors,
				durationMs: Math.round(performance.now() - t0),
			},
		};
	}
}
