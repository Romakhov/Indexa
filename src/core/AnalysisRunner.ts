// Orchestrates the analysis pipeline with stage progress and cancellation
// (spec §66–67). Phase 1 implements Scanning + Processing; later phases add
// the remaining stages. Never mutates the vault.

import type { NoteDocument, ProcessedNote } from "../types/NoteDocument";
import { bodyLines, processNote } from "./MarkdownProcessor";
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
}

export interface AnalysisResult {
	summary: AnalysisSummary;
	notes: NoteDocument[];
	processed: ProcessedNote[];
}

export class AnalysisCancelled extends Error {
	constructor() {
		super("Analysis cancelled");
	}
}

export class AnalysisRunner {
	constructor(private readonly scanner: ObsidianVaultScanner) {}

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

		return {
			notes,
			processed,
			summary: {
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
