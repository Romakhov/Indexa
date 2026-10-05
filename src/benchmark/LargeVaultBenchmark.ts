// Dev benchmark (spec §68–75, §93) on the reproducible bench vault built by
// scripts/make-bench-vault.mjs: one vault, nested parts p1..p4, sizes selected
// by excluding parts. Measures every metric of spec §73 plus UI blocking.

import type IndexaPlugin from "../main";
import { nmi, purity } from "../spike/metrics";
import { stallMonitor } from "../spike/stall";
import { MainView } from "../ui/MainView";

const PARTS: Record<number, string[]> = { 500: ["p1"], 2000: ["p1", "p2"], 5000: ["p1", "p2", "p3"], 10000: ["p1", "p2", "p3", "p4"] };
const ALL_PARTS = ["p1", "p2", "p3", "p4"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Obsidian's internal plugin manager (dev-only use: reload the plugin to measure startup). */
export function pluginManager(app: IndexaPlugin["app"]) {
	return (app as unknown as { plugins: { disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<void>; plugins: Record<string, unknown> } }).plugins;
}

async function memoryMb(): Promise<number | null> {
	const proc = (globalThis as { process?: { getProcessMemoryInfo?: () => Promise<{ private: number }> } }).process;
	return proc?.getProcessMemoryInfo ? Math.round((await proc.getProcessMemoryInfo()).private / 1024) : null;
}

async function dirSize(plugin: IndexaPlugin, dir: string): Promise<number> {
	const a = plugin.app.vault.adapter;
	if (!(await a.exists(dir))) return 0;
	const list = await a.list(dir);
	let total = 0;
	for (const f of list.files) total += (await a.stat(f))?.size ?? 0;
	for (const d of list.folders) total += await dirSize(plugin, d);
	return total;
}

export interface LargeVaultOptions {
	sizes: number[];
	/** at this size, cancel the analysis during embedding and resume (spec §93) */
	cancelAt?: number;
	/** run Apply + Undo at the largest size */
	applyUndo?: boolean;
}

export async function largeVaultBenchmark(plugin: IndexaPlugin, o: LargeVaultOptions) {
	const manifest = JSON.parse(await plugin.app.vault.adapter.read("bench-manifest.json")) as { file: string; topic: string }[];
	const topicOf = new Map(manifest.map((m) => [m.file, m.topic]));
	const results: Record<string, unknown>[] = [];
	const dir = plugin.manifest.dir!;

	// memory is sampled and stage spans recorded from the analysis progress
	// (timers are throttled in hidden windows); set again after each plugin reload
	let peak = 0;
	let lastSample = 0;
	let spans: { stage: string; start: number; end: number }[] = [];
	const hook = (p: { stage: string }) => {
		const now = performance.now();
		const last = spans[spans.length - 1];
		if (!last || last.stage !== p.stage) spans.push({ stage: p.stage, start: now, end: now });
		else last.end = now;
		if (now - lastSample > 1500) {
			lastSample = now;
			void memoryMb().then((m) => m !== null && (peak = Math.max(peak, m)));
		}
	};

	try {
		for (const size of o.sizes) {
			await plugin.updateSettings({ excludedFolders: ["Templates", "Indexes", ...ALL_PARTS.filter((p) => !PARTS[size].includes(p))] });
			const row: Record<string, unknown> = { size };
			peak = (await memoryMb()) ?? 0;
			row.memoryBeforeMb = peak;

			if (o.cancelAt === size) {
				const run = plugin.analyzeVault();
				// wait until embedding has started, then a minute more
				for (let i = 0; i < 600 && plugin.lastSummary?.totalFiles === undefined; i++) await sleep(100);
				await sleep(60000);
				plugin.cancelAnalysis();
				await run;
				row.cancelled = true;
			}

			plugin.debugProgressHook = hook;
			spans = [];
			const stall = stallMonitor();
			const t0 = performance.now();
			await plugin.analyzeVault();
			const tEnd = performance.now();
			const s = plugin.lastSummary!;
			const longTasks = stall();
			row.analysisMs = Math.round(performance.now() - t0);
			row.notes = s.analysable;
			row.stageMs = s.stageMs;
			row.embedding = s.embedding;
			row.vectorIndex = s.vectorIndex;
			row.communities = s.communities && { count: s.communities.count, edges: s.communities.edges, ms: s.communities.ms };
			row.proposals = s.proposals;
			// attribute each long task to the stage running at that moment (the rest: after the last report)
			spans.forEach((sp, i) => (sp.end = spans[i + 1]?.start ?? tEnd));
			row.mainThreadLongTasks = {
				worstMs: longTasks.worstMs,
				totalMs: longTasks.totalMs,
				count: longTasks.count,
				byStage: longTasks.entries.map((e) => ({ ms: e.duration, stage: spans.find((sp) => e.start >= sp.start - 1 && e.start <= sp.end)?.stage ?? "other" })),
			};
			row.peakMemoryMb = peak;
			row.edgesVsPairs = s.communities ? +(s.communities.edges / ((s.analysable * (s.analysable - 1)) / 2)).toFixed(6) : null;

			// quality against the known topics (primary index per note)
			const eff = plugin.review.effective();
			if (eff) {
				const gold: string[] = [];
				const pred: string[] = [];
				for (const ix of eff.indexes.filter((i) => !i.ignored && i.kind === "topic"))
					for (const m of ix.members.filter((x) => x.primary)) {
						const t = topicOf.get(plugin.pathOf(m.noteId) ?? "");
						if (t) {
							gold.push(t);
							pred.push(ix.id);
						}
					}
				const ids = [...new Set(pred)];
				row.quality = { classified: gold.length, nmi: +nmi(gold, pred).toFixed(3), purity: +purity(gold, pred.map((p) => ids.indexOf(p))).toFixed(3) };
			}

			// ANN latency (single query in the worker)
			const index = plugin.getVectorIndex();
			const cache = plugin.getCache();
			const sample = [...cache.values()].slice(0, 50);
			const tq = performance.now();
			for (const e of sample) await index.search(e.documentVector, 15, e.noteId);
			row.annSearchMs = +((performance.now() - tq) / Math.max(1, sample.length)).toFixed(2);

			// Review UI: effective view + rendering the tabs
			// the view may belong to a previous load of the plugin bundle: duck-type it
			const views = plugin.app.workspace.getLeavesOfType("indexa-main").map((l) => l.view as unknown as MainView).filter((v) => typeof v.setTab === "function");
			const tr = performance.now();
			plugin.review.effective();
			const effectiveMs = performance.now() - tr;
			const ui: Record<string, number> = { effectiveMs: Math.round(effectiveMs) };
			for (const tab of ["indexes", "unclassified", "review"] as const) {
				const t = performance.now();
				views.forEach((v) => v.setTab(tab));
				ui[`${tab}RenderMs`] = Math.round(performance.now() - t);
			}
			row.ui = ui;

			// storage (spec §73: cache size)
			row.storageKb = {
				cache: Math.round((await dirSize(plugin, `${dir}/cache`)) / 1024),
				analysis: Math.round(((await plugin.app.vault.adapter.stat(`${dir}/analysis.json`))?.size ?? 0) / 1024),
			};

			// incremental: one new note → suggestion, without re-analysis (spec §94)
			const path = `${PARTS[size][0]}/bench-incremental-${size}.md`;
			const existing = plugin.app.vault.getFileByPath(path);
			if (existing) await plugin.app.vault.delete(existing);
			const f = await plugin.app.vault.create(path, "# Чёрная дыра в центре галактики\n\nСверхмассивная чёрная дыра в центре Млечного Пути имеет массу около четырёх миллионов солнечных масс; её окружает аккреционный диск, а звёзды вокруг неё движутся по вытянутым орбитам.\n");
			const ti = performance.now();
			const ir = await plugin.incremental.runNow(f);
			row.incremental = { status: ir.status, processingMs: ir.ms, wallMs: Math.round(performance.now() - ti), suggestions: ir.suggestions?.length ?? 0 };
			await plugin.app.vault.delete(f);

			// startup: reload the plugin with this vault's stored state
			const ts = performance.now();
			await pluginManager(plugin.app).disablePlugin("indexa");
			await pluginManager(plugin.app).enablePlugin("indexa");
			row.pluginReloadMs = Math.round(performance.now() - ts);
			plugin = pluginManager(plugin.app).plugins.indexa as IndexaPlugin;
			for (let i = 0; i < 100 && !plugin.stored; i++) await sleep(100);
			row.storedRestoredMs = Math.round(performance.now() - ts);
			row.memoryAfterMb = await memoryMb();
			results.push(row);
			console.log("[indexa bench]", row);
		}

		if (o.applyUndo) {
			const before = await memoryMb();
			const ta = performance.now();
			const plan = await plugin.applier.plan();
			const planMs = performance.now() - ta;
			await plugin.applier.confirmAndApply();
			await sleep(400);
			[...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Apply")?.click();
			for (let i = 0; i < 3000 && !plugin.applier.lastUndoable; i++) await sleep(200);
			const applyMs = performance.now() - ta;
			const ops = plugin.applier.lastUndoable?.ops.length ?? 0;
			const tu = performance.now();
			await plugin.applier.confirmAndUndo();
			await sleep(400);
			[...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Undo")?.click();
			for (let i = 0; i < 3000 && plugin.applier.lastUndoable; i++) await sleep(200);
			results.push({
				applyUndo: {
					notes: plan?.notes.length,
					indexes: plan?.indexes.length,
					planMs: Math.round(planMs),
					applyMs: Math.round(applyMs),
					ops,
					undoMs: Math.round(performance.now() - tu),
					memoryBeforeMb: before,
					memoryAfterMb: await memoryMb(),
				},
			});
		}
	} finally {
		plugin.debugProgressHook = null;
	}
	return { results };
}
