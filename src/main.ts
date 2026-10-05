import { debounce, Notice, Plugin, TFile } from "obsidian";
import { AnalysisWorkerClient } from "./analysis/AnalysisWorkerClient";
import { AnalysisCancelled, AnalysisRunner, type AnalysisResult, type AnalysisSummary } from "./core/AnalysisRunner";
import { resolutionForDetail } from "./clustering/clusterNotes";
import { confidenceForThreshold } from "./indexing/IndexClassifier";
import { IncrementalProcessor } from "./incremental/IncrementalProcessor";
import { ApplyController } from "./obsidian/ApplyController";
import { ReviewController } from "./review/ReviewController";
import { reconcileIds } from "./review/ReviewState";
import { AnalysisStore, type StoredAnalysis } from "./storage/AnalysisStore";
import { VectorIndexService } from "./vectors/VectorIndexService";
import { NoteIdRegistry } from "./core/NoteIdRegistry";
import { ObsidianVaultScanner } from "./core/VaultScanner";
import { EmbeddingCache } from "./embeddings/EmbeddingCache";
import { LocalEmbeddingProvider } from "./embeddings/LocalEmbeddingProvider";
import { PooledEmbeddingProvider } from "./embeddings/PooledEmbeddingProvider";
import { AdapterBinaryStore } from "./storage/BinaryStore";
import { E5_SMALL, ModelStore } from "./embeddings/ModelStore";
import { normalizeSettings, type IndexaSettings } from "./settings/Settings";
import { registerSpikeCommands } from "./spike/registerSpikeCommands";
import { MainView, VIEW_TYPE_INDEXA } from "./ui/MainView";
import { IndexaSettingTab } from "./ui/SettingsTab";


const NOTE_IDS_FILE = "note-ids.json";
/** Free the model's memory after this long without semantic work. */
const MODEL_IDLE_MS = 5 * 60_000;

export default class IndexaPlugin extends Plugin {
	declare settings: IndexaSettings;
	modelStore!: ModelStore;
	onloadMs = 0;
	lastSummary: AnalysisSummary | null = null;
	/** dev/benchmark only: observes analysis progress */
	debugProgressHook: ((p: import("./core/AnalysisRunner").Progress) => void) | null = null;
	/** in memory only; proposals built from it arrive in Phase 4–5 */
	lastResult: AnalysisResult | null = null;
	/** latest proposals; survives restarts through AnalysisStore */
	stored: StoredAnalysis | null = null;
	readonly review = new ReviewController(this);
	readonly applier = new ApplyController(this);
	/** created in onload (needs settings) */
	incremental!: IncrementalProcessor;

	private noteIds = new NoteIdRegistry();
	private provider: LocalEmbeddingProvider | null = null;
	private pool: PooledEmbeddingProvider | null = null;
	private poolIdleTimer: number | null = null;
	private cache: EmbeddingCache | null = null;
	private analysisWorker = new AnalysisWorkerClient();
	private vectorIndex: VectorIndexService | null = null;
	private analysis: AbortController | null = null;
	private readonly saveNoteIdsSoon = debounce(() => void this.saveNoteIds(), 2000, true);

	async onload() {
		// Spec §10: settings, commands, views, ribbon, settings tab — nothing heavy.
		const t0 = performance.now();
		this.settings = normalizeSettings(await this.loadData());
		this.modelStore = new ModelStore();
		this.incremental = new IncrementalProcessor(this);

		this.registerView(VIEW_TYPE_INDEXA, (leaf) => new MainView(leaf, this));
		this.addRibbonIcon("network", "Open Indexa", () => void this.activateView());
		this.addSettingTab(new IndexaSettingTab(this.app, this));

		this.addCommand({ id: "open", name: "Open", callback: () => void this.activateView() });
		this.addCommand({ id: "analyze-vault", name: "Analyze vault", callback: () => void this.analyzeVault() });
		this.addCommand({ id: "download-model", name: "Download local semantic model", callback: () => void this.downloadModel() });
		this.addCommand({ id: "apply", name: "Apply index structure", callback: () => void this.applier.confirmAndApply() });
		this.addCommand({
			id: "suggest-current",
			name: "Suggest indexes for the current note",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || f.extension !== "md") return false;
				if (!checking) void this.suggestFor(f);
				return true;
			},
		});
		this.addCommand({ id: "undo-apply", name: "Undo last Apply", callback: () => void this.applier.confirmAndUndo() });
		if (__SPIKE__) registerSpikeCommands(this);

		// Vault events only after the workspace is ready (spec §11); cheap bookkeeping only.
		this.app.workspace.onLayoutReady(() => void this.onLayoutReady());
		this.onloadMs = performance.now() - t0;
	}

	async onunload() {
		this.analysis?.abort();
		this.incremental?.dispose();
		await this.saveNoteIds();
		await this.provider?.dispose();
		await this.disposePool();
		this.analysisWorker.terminate();
	}

	private async onLayoutReady() {
		await this.loadNoteIds();
		this.stored = await this.analysisStore().load();
		this.lastSummary ??= this.stored?.summary ?? null;
		await this.review.load();
		await this.applier.refresh();
		await this.incremental.queue.load();
		this.views().forEach((v) => v.render());
		// spec §11: events only once the workspace is ready; handlers only enqueue work
		this.registerEvent(this.app.vault.on("create", (file) => this.incremental.onCreate(file)));
		this.registerEvent(this.app.vault.on("modify", (file) => this.incremental.onModify(file)));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile) {
					this.noteIds.rename(oldPath, file.path);
					this.saveNoteIdsSoon();
					void this.incremental.onRename(file, oldPath);
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile) {
					const id = this.noteIds.peek(file.path);
					this.noteIds.remove(file.path);
					this.saveNoteIdsSoon();
					void this.incremental.onDelete(file.path, id);
				}
			}),
		);
	}

	// ---- incremental mode helpers --------------------------------------

	scanner() {
		return new ObsidianVaultScanner(this.app, this.noteIds, () => ({
			excludedFolders: [...this.settings.excludedFolders],
			excludedTags: this.settings.excludedTags,
			configDir: this.app.vault.configDir,
		}));
	}

	isAnalysing() {
		return this.analysis !== null;
	}

	/** notes known from the last analysis (plus notes processed since) */
	knownNoteIds(): string[] {
		return Object.keys(this.stored?.paths ?? {});
	}

	contentNoteIds(): string[] {
		return this.stored?.contentIds ?? this.knownNoteIds();
	}

	rememberPath(noteId: string, path: string) {
		if (this.stored && this.stored.paths[noteId] !== path) {
			this.stored.paths[noteId] = path;
			void this.saveStored();
		}
	}

	forgetNote(noteId: string) {
		if (this.stored?.paths[noteId]) {
			delete this.stored.paths[noteId];
			void this.saveStored();
		}
		this.refreshViews();
	}

	async openTab(tab: "overview" | "indexes" | "unclassified" | "review") {
		await this.activateView();
		this.views().forEach((v) => v.setTab(tab));
	}

	async suggestFor(file: TFile) {
		const n = new Notice("Indexa: looking for indexes…", 0);
		try {
			const r = await this.incremental.runNow(file);
			const msg: Record<string, string> = {
				suggested: "suggestions added to Review",
				"no-new-indexes": "no new indexes to suggest",
				excluded: "this note is excluded from analysis",
				skipped: "run Analyze vault first (and install the model)",
				unchanged: "nothing changed",
				assigned: "added to its best index",
			};
			n.setMessage(`Indexa: ${msg[r.status]}`);
			if (r.status === "suggested") void this.openTab("review");
		} finally {
			window.setTimeout(() => n.hide(), 4000);
		}
	}

	// ---- settings -------------------------------------------------------

	async updateSettings(patch: Partial<IndexaSettings>) {
		this.settings = normalizeSettings({ ...this.settings, ...patch });
		await this.saveData(this.settings);
		this.incremental?.setDebounce(this.settings.debounceMs);
	}

	openSettings() {
		// Obsidian has no public API to open a specific settings tab.
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		if (setting) {
			setting.open();
			setting.openTabById(this.manifest.id);
		} else new Notice("Open Settings → Indexa");
	}

	// ---- storage --------------------------------------------------------

	private storePath(name: string) {
		return `${this.manifest.dir}/${name}`;
	}

	private async loadNoteIds() {
		const p = this.storePath(NOTE_IDS_FILE);
		if (await this.app.vault.adapter.exists(p)) {
			try {
				this.noteIds.load(JSON.parse(await this.app.vault.adapter.read(p)));
			} catch (e) {
				console.warn("[indexa] note id map unreadable, starting fresh", e);
			}
		}
	}

	private async saveNoteIds() {
		if (!this.noteIds.isDirty) return;
		await this.app.vault.adapter.write(this.storePath(NOTE_IDS_FILE), JSON.stringify(this.noteIds.serialize()));
	}

	// ---- view -----------------------------------------------------------

	async activateView() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_INDEXA)[0];
		const leaf = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		if (!existing) await leaf.setViewState({ type: VIEW_TYPE_INDEXA, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	private views(): MainView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE_INDEXA)
			.map((l) => l.view)
			.filter((v): v is MainView => v instanceof MainView);
	}

	// ---- analysis -------------------------------------------------------

	async analyzeVault() {
		if (this.analysis) {
			new Notice("Analysis is already running.");
			return;
		}
		// register the controller before any await, so an immediate Cancel is never lost
		const controller = new AbortController();
		this.analysis = controller;
		await this.activateView();
		const scanner = this.scanner();
		const embedding = this.isModelInstalled()
			? {
					provider: this.getPool(),
					cache: this.getCache(),
					parallel: this.settings.embeddingWorkers,
					index: this.getVectorIndex(),
					topK: this.settings.topK,
					clustering: {
						resolution: resolutionForDetail(this.settings.detailLevel),
						weights: this.settings.edgeWeights,
						refineMaxShare: 0.15,
						proposals: {
							minNotes: this.settings.minNotesPerIndex,
							maxIndexesPerNote: this.settings.maxIndexesPerNote,
							minConfidence: confidenceForThreshold(this.settings.semanticThreshold),
							existingIndexNames: this.app.vault
								.getMarkdownFiles()
								.filter((f) => f.path.startsWith(this.settings.indexFolder + "/"))
								.map((f) => f.basename),
						},
					},
				}
			: undefined;
		if (!embedding) new Notice("Local semantic model is not installed: only text preparation will run.");
		try {
			const result = await new AnalysisRunner(scanner, embedding).run((p) => {
				this.debugProgressHook?.(p);
				this.views().forEach((v) => v.setProgress(p));
			}, controller.signal);
			this.lastSummary = result.summary;
			this.lastResult = result;
			if (result.proposals) {
				// keep ids of indexes that mostly kept their notes, so review decisions carry over
				const proposals = reconcileIds(this.stored?.proposals ?? null, result.proposals);
				this.stored = {
					version: 1,
					proposals,
					paths: Object.fromEntries(result.notes.map((n) => [n.id, n.path])),
					templateLines: result.templateLines,
					contentIds: result.processed.filter((p) => !p.lowContent).map((p) => p.noteId),
					summary: result.summary,
				};
				await this.saveStored();
			}
			await this.saveNoteIds();
		} catch (e) {
			if (e instanceof AnalysisCancelled) new Notice("Analysis cancelled. Nothing in your vault was changed.");
			else {
				console.error("[indexa] analysis failed", e);
				new Notice(`Analysis failed: ${e instanceof Error ? e.message : e}`);
			}
		} finally {
			this.schedulePoolDisposal();
			this.analysis = null;
			this.views().forEach((v) => v.setProgress(null));
		}
		if (this.lastResult?.proposals && !this.reapplyingSplits) {
			this.reapplyingSplits = true;
			try {
				await this.review.reapplySplits();
			} finally {
				this.reapplyingSplits = false;
			}
		}
	}

	private reapplyingSplits = false;

	async saveStored() {
		if (this.stored) await this.analysisStore().save(this.stored);
	}

	refreshViews() {
		this.views().forEach((v) => v.render());
	}

	/** current path of a note id (falls back to the path seen at analysis time) */
	pathOf(noteId: string): string | undefined {
		return this.noteIds.pathOf(noteId) ?? this.stored?.paths[noteId];
	}

	noteIdFor(path: string): string {
		const id = this.noteIds.idFor(path);
		if (this.stored) this.stored.paths[id] = path;
		this.saveNoteIdsSoon();
		return id;
	}

	cancelAnalysis() {
		this.analysis?.abort();
	}

	// ---- model ----------------------------------------------------------

	/** Lazily created; the model is loaded only on first use. */
	getProvider(): LocalEmbeddingProvider {
		this.provider ??= new LocalEmbeddingProvider(this.modelStore, E5_SMALL);
		return this.provider;
	}

	/** Worker pool for bulk analysis; recreated if the worker count setting changed. */
	getPool(): PooledEmbeddingProvider {
		if (this.poolIdleTimer !== null) window.clearTimeout(this.poolIdleTimer);
		this.poolIdleTimer = null;
		if (this.pool && this.pool.size !== this.settings.embeddingWorkers) {
			void this.pool.dispose();
			this.pool = null;
		}
		this.pool ??= new PooledEmbeddingProvider(this.modelStore, E5_SMALL, this.settings.embeddingWorkers);
		return this.pool;
	}

	private schedulePoolDisposal() {
		if (!this.pool) return;
		if (this.poolIdleTimer !== null) window.clearTimeout(this.poolIdleTimer);
		this.poolIdleTimer = window.setTimeout(() => void this.disposePool(), MODEL_IDLE_MS);
	}

	private async disposePool() {
		if (this.poolIdleTimer !== null) window.clearTimeout(this.poolIdleTimer);
		this.poolIdleTimer = null;
		const p = this.pool;
		this.pool = null;
		await p?.dispose();
	}

	analysisStore() {
		return new AnalysisStore(this.app.vault.adapter, `${this.manifest.dir}/analysis.json`);
	}

	getVectorIndex(): VectorIndexService {
		this.vectorIndex ??= new VectorIndexService(this.analysisWorker, E5_SMALL.dims);
		return this.vectorIndex;
	}

	getCache(): EmbeddingCache {
		this.cache ??= new EmbeddingCache(
			new AdapterBinaryStore(this.app.vault.adapter, `${this.manifest.dir}/cache`),
			E5_SMALL.id,
			`${E5_SMALL.revision}:${E5_SMALL.dtype}`,
			E5_SMALL.dims,
		);
		return this.cache;
	}

	/** cached: the view asks on every progress update, and the check is synchronous file I/O */
	private modelInstalled: boolean | null = null;

	isModelInstalled() {
		this.modelInstalled ??= this.modelStore.isInstalled(E5_SMALL);
		return this.modelInstalled;
	}

	modelDownloadMb() {
		return Math.round(E5_SMALL.approxBytes / 1e6);
	}

	async downloadModel() {
		if (this.isModelInstalled()) {
			new Notice("Local semantic model is already installed.");
			return;
		}
		const notice = new Notice(`Downloading local semantic model (~${this.modelDownloadMb()} MB)…`, 0);
		try {
			await this.modelStore.download(E5_SMALL, (file, i, n) => notice.setMessage(`Downloading model ${i}/${n}: ${file}`));
			this.modelInstalled = null;
			notice.setMessage("Local semantic model installed.");
		} catch (e) {
			notice.setMessage(`Model download failed: ${e instanceof Error ? e.message : e}`);
		}
		window.setTimeout(() => notice.hide(), 5000);
	}
}
