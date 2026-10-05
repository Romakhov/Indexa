// Dev-only Phase 0 spike commands. Compiled in only when __SPIKE__ is true
// (npm run build:vault); release builds leave this module out entirely.

import { Notice } from "obsidian";
import { benchmarkEmbedding, type EmbeddingBenchmarkOptions } from "../benchmark/BenchmarkRunner";
import { clusteringBenchmark } from "../benchmark/ClusteringBenchmark";
import { cosine } from "../embeddings/EmbeddingProvider";
import { E5_SMALL } from "../embeddings/ModelStore";
import { PooledEmbeddingProvider } from "../embeddings/PooledEmbeddingProvider";
import type IndexaPlugin from "../main";
import { AdapterBinaryStore } from "../storage/BinaryStore";
import { runGate0a } from "./gate0a";
import { runGate0b } from "./gate0b";
import { runGate0c, type Gate0cOptions } from "./gate0c";
import { hubnessExperiment } from "./hubness";
import { indexScale } from "./indexScale";
import { labelBankExperiment } from "./labelBank";
import { longNoteCheck } from "./longNote";
import { proposalsEval, writeProposalReport } from "./proposalsEval";

export function registerSpikeCommands(plugin: IndexaPlugin) {
	const store = () => new AdapterBinaryStore(plugin.app.vault.adapter, `${plugin.manifest.dir}/spike-data`);
	const writeReport = async (name: string, report: unknown) => {
		const dir = `${plugin.manifest.dir}/reports`;
		if (!(await plugin.app.vault.adapter.exists(dir))) await plugin.app.vault.adapter.mkdir(dir);
		await plugin.app.vault.adapter.write(`${dir}/${name}`, JSON.stringify(report, null, 2));
		console.log(`[indexa] ${name}`, report);
	};

	const spike = {
		async gate0a() {
			const report = await runGate0a(plugin.getProvider(), {
				pluginOnloadMs: +plugin.onloadMs.toFixed(2),
				modelDir: plugin.modelStore.dir(E5_SMALL),
			});
			await writeReport("gate0a.json", report);
			new Notice(`Gate 0a: ${report.passed ? "PASSED" : "FAILED"}`);
			return report;
		},
		async gate0b(sizes?: number[], scaleN?: number) {
			const report = await runGate0b(plugin.app, plugin.getProvider(), store(), sizes, scaleN);
			await writeReport("gate0b.json", report);
			new Notice(`Gate 0b: ${report.passed ? "PASSED" : "FAILED"}`);
			return report;
		},
		async gate0c(options: Partial<Gate0cOptions> = {}) {
			const report = await runGate0c(plugin.app, plugin.getProvider(), store(), options);
			await writeReport(`gate0c-${report.variant.variant.split(" ")[0]}.json`, report);
			new Notice(`Gate 0c: report written to ${report.reportNote}`);
			return report;
		},
		/** Same texts on CPU and WebGPU: are the vectors interchangeable? */
		async compareDevices(texts = ["Как планировать рабочую неделю", "Kafka consumer groups and partitions", "Как образуются черные дыры", "Рецепт борща с говядиной"]) {
			const cpu = new PooledEmbeddingProvider(plugin.modelStore, E5_SMALL, 1, "wasm");
			const gpu = new PooledEmbeddingProvider(plugin.modelStore, E5_SMALL, 1, "webgpu");
			try {
				const a = await cpu.embedBatch(texts);
				const b = await gpu.embedBatch(texts);
				const sims = a.map((v, i) => +cosine(v, b[i]).toFixed(5));
				return { flavour: __ORT_FLAVOUR__, sims, min: Math.min(...sims) };
			} finally {
				await cpu.dispose();
				await gpu.dispose();
			}
		},
		/**
		 * Labels: corpus/manifest.json topics in the dev vault, otherwise the
		 * user's manual index (frontmatter Zettel-link).
		 */
		async benchClustering(resolutions?: number[]) {
			const r = plugin.lastResult;
			if (!r?.neighbors) throw new Error("Run Analyze vault first");
			const labels = new Map<string, string>();
			const manifestPath = "corpus/manifest.json";
			if (await plugin.app.vault.adapter.exists(manifestPath)) {
				const manifest = JSON.parse(await plugin.app.vault.adapter.read(manifestPath)) as { file: string; topic: string }[];
				const topic = new Map(manifest.map((m) => ["corpus/" + m.file, m.topic]));
				r.notes.forEach((n) => topic.has(n.path) && labels.set(n.id, topic.get(n.path)!));
			} else {
				for (const n of r.notes) {
					const raw = n.frontmatter["Zettel-link"];
					const first = Array.isArray(raw) ? raw[0] : raw;
					const m = typeof first === "string" ? first.match(/\[\[([^\]|#]+)/) : null;
					if (m) labels.set(n.id, m[1].split("/").pop()!.trim());
				}
			}
			const vectors = new Map<string, Float32Array>();
			for (const id of r.neighbors.ids) {
				const e = plugin.getCache().peek(id);
				const c = e && plugin.getVectorIndex().centre(e.documentVector);
				if (c) vectors.set(id, c);
			}
			const report = await clusteringBenchmark({ notes: r.notes, processed: r.processed, table: r.neighbors, vectors, labels }, resolutions);
			await writeReport("bench-clustering.json", report);
			return report;
		},
		async proposals(cuts?: number[], extra: Record<string, unknown> = {}) {
			const r = plugin.lastResult;
			if (!r) throw new Error("Run Analyze vault first");
			const base = {
				minNotes: plugin.settings.minNotesPerIndex,
				maxIndexesPerNote: plugin.settings.maxIndexesPerNote,
				existingIndexNames: [] as string[],
				...extra,
			};
			const report = await proposalsEval(plugin.app, r, base, cuts);
			await writeReport("proposals-eval.json", report);
			return { ...report, note: await writeProposalReport(plugin.app, r) };
		},
		labelBank: () => labelBankExperiment(plugin),
		async hubness(k = 5) {
			if (!plugin.lastResult) throw new Error("Run Analyze vault first");
			const report = hubnessExperiment(plugin.app, plugin.lastResult, plugin.getCache(), k);
			await writeReport("hubness.json", report);
			return report;
		},
		async indexScale(n = 10000) {
			const report = await indexScale(plugin.getVectorIndex(), n);
			await writeReport(`index-scale-${n}.json`, report);
			return report;
		},
		async longNote() {
			const report = await longNoteCheck(plugin.getProvider());
			await writeReport("long-note.json", report);
			return report;
		},
		async benchEmbedding(options: Partial<EmbeddingBenchmarkOptions> = {}) {
			new Notice("Benchmark: embedding throughput…");
			const report = await benchmarkEmbedding(plugin.app, plugin.modelStore, E5_SMALL, plugin.settings.excludedFolders, options);
			await writeReport("bench-embedding.json", report);
			return report;
		},
	};
	// reachable from the dev console / CDP: app.plugins.plugins.indexa.spike
	(plugin as unknown as { spike: typeof spike }).spike = spike;

	plugin.addCommand({ id: "spike-gate-0a", name: "Spike: run Gate 0a self-test", callback: () => spike.gate0a() });
	plugin.addCommand({ id: "spike-gate-0b", name: "Spike: run Gate 0b pipeline benchmark", callback: () => spike.gate0b() });
	plugin.addCommand({ id: "bench-embedding", name: "Benchmark: embedding throughput", callback: () => spike.benchEmbedding() });
	plugin.addCommand({ id: "spike-gate-0c", name: "Spike: run Gate 0c on this vault", callback: () => spike.gate0c() });
}
