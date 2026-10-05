// Dev benchmark (spec §73): embedding throughput and memory for different
// worker-pool sizes, on real texts of the open vault, bypassing the cache.

import type { App } from "obsidian";
import { bodyLines, processNote } from "../core/MarkdownProcessor";
import { NoteIdRegistry } from "../core/NoteIdRegistry";
import { chunkNote } from "../core/SemanticChunker";
import { detectTemplateLines } from "../core/TemplateDetector";
import { ObsidianVaultScanner } from "../core/VaultScanner";
import type { ModelSpec, ModelStore } from "../embeddings/ModelStore";
import { headOf } from "../embeddings/NoteEmbedder";
import { PooledEmbeddingProvider } from "../embeddings/PooledEmbeddingProvider";

async function rendererMemoryMb(): Promise<number | null> {
	// Electron: workers are threads of the renderer process, so this includes them
	const proc = (window as unknown as { process?: { getProcessMemoryInfo?: () => Promise<{ private: number }> } }).process;
	if (!proc?.getProcessMemoryInfo) return null;
	return Math.round((await proc.getProcessMemoryInfo()).private / 1024);
}

export interface EmbeddingBenchmarkOptions {
	poolSizes: number[];
	sampleNotes: number;
	batchSize: number;
	device: "wasm" | "webgpu";
}

export async function benchmarkEmbedding(app: App, store: ModelStore, spec: ModelSpec, excludedFolders: string[], options: Partial<EmbeddingBenchmarkOptions> = {}) {
	const o: EmbeddingBenchmarkOptions = { poolSizes: [1, 2, 3, 4], sampleNotes: 160, batchSize: 8, device: "wasm", ...options };
	const scanner = new ObsidianVaultScanner(app, new NoteIdRegistry(), () => ({ excludedFolders, excludedTags: ["zk-ignore"], configDir: app.vault.configDir }));
	const notes = await scanner.scan();
	const templates = detectTemplateLines(notes.map(bodyLines));

	// deterministic sample of notes with real text, spread over the vault
	const candidates = notes.filter((n) => !processNote(n, templates).lowContent);
	const step = Math.max(1, Math.floor(candidates.length / o.sampleNotes));
	const sample = candidates.filter((_, i) => i % step === 0).slice(0, o.sampleNotes);
	const texts = sample.flatMap((n) => {
		const processed = processNote(n, templates);
		const chunks = chunkNote(n, templates);
		return [headOf({ processed, chunks }), ...chunks.map((c) => c.text)];
	});
	texts.sort((a, b) => a.length - b.length);
	const chars = texts.reduce((s, t) => s + t.length, 0);

	const results = [];
	const baseline = await rendererMemoryMb();
	for (const size of o.poolSizes) {
		const pool = new PooledEmbeddingProvider(store, spec, size, o.device);
		const ti = performance.now();
		await pool.initialize();
		const initMs = Math.round(performance.now() - ti);
		const t0 = performance.now();
		let next = 0;
		const lane = async () => {
			while (next < texts.length) {
				const batch = texts.slice(next, next + o.batchSize);
				next += batch.length;
				await pool.embedBatch(batch);
			}
		};
		await Promise.all(Array.from({ length: size }, lane));
		const ms = performance.now() - t0;
		const mem = await rendererMemoryMb();
		await pool.dispose();
		results.push({
			workers: size,
			initMs,
			ms: Math.round(ms),
			textsPerSec: +((texts.length / ms) * 1000).toFixed(1),
			notesPerSec: +((sample.length / ms) * 1000).toFixed(1),
			rendererMemoryMb: mem,
			memoryOverBaselineMb: mem !== null && baseline !== null ? mem - baseline : null,
			blockedRequests: pool.blockedRequests.length,
		});
	}
	return {
		device: o.device,
		cpuThreads: navigator.hardwareConcurrency,
		sampleNotes: sample.length,
		texts: texts.length,
		avgChars: Math.round(chars / texts.length),
		baselineMemoryMb: baseline,
		results,
	};
}
