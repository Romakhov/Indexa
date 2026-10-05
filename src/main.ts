import { debounce, Notice, Plugin, TFile } from "obsidian";
import { AnalysisCancelled, AnalysisRunner, type AnalysisSummary } from "./core/AnalysisRunner";
import { NoteIdRegistry } from "./core/NoteIdRegistry";
import { ObsidianVaultScanner } from "./core/VaultScanner";
import { LocalEmbeddingProvider } from "./embeddings/LocalEmbeddingProvider";
import { E5_SMALL, ModelStore } from "./embeddings/ModelStore";
import { normalizeSettings, type IndexaSettings } from "./settings/Settings";
import { registerSpikeCommands } from "./spike/registerSpikeCommands";
import { MainView, VIEW_TYPE_INDEXA } from "./ui/MainView";
import { IndexaSettingTab } from "./ui/SettingsTab";


const NOTE_IDS_FILE = "note-ids.json";

export default class IndexaPlugin extends Plugin {
	declare settings: IndexaSettings;
	modelStore!: ModelStore;
	onloadMs = 0;
	lastSummary: AnalysisSummary | null = null;

	private noteIds = new NoteIdRegistry();
	private provider: LocalEmbeddingProvider | null = null;
	private analysis: AbortController | null = null;
	private readonly saveNoteIdsSoon = debounce(() => void this.saveNoteIds(), 2000, true);

	async onload() {
		// Spec §10: settings, commands, views, ribbon, settings tab — nothing heavy.
		const t0 = performance.now();
		this.settings = normalizeSettings(await this.loadData());
		this.modelStore = new ModelStore();

		this.registerView(VIEW_TYPE_INDEXA, (leaf) => new MainView(leaf, this));
		this.addRibbonIcon("network", "Open Indexa", () => void this.activateView());
		this.addSettingTab(new IndexaSettingTab(this.app, this));

		this.addCommand({ id: "open", name: "Open", callback: () => void this.activateView() });
		this.addCommand({ id: "analyze-vault", name: "Analyze vault", callback: () => void this.analyzeVault() });
		this.addCommand({ id: "download-model", name: "Download local semantic model", callback: () => void this.downloadModel() });
		if (__SPIKE__) registerSpikeCommands(this);

		// Vault events only after the workspace is ready (spec §11); cheap bookkeeping only.
		this.app.workspace.onLayoutReady(() => void this.onLayoutReady());
		this.onloadMs = performance.now() - t0;
	}

	async onunload() {
		this.analysis?.abort();
		await this.saveNoteIds();
		await this.provider?.dispose();
	}

	private async onLayoutReady() {
		await this.loadNoteIds();
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile) {
					this.noteIds.rename(oldPath, file.path);
					this.saveNoteIdsSoon();
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile) {
					this.noteIds.remove(file.path);
					this.saveNoteIdsSoon();
				}
			}),
		);
	}

	// ---- settings -------------------------------------------------------

	async updateSettings(patch: Partial<IndexaSettings>) {
		this.settings = normalizeSettings({ ...this.settings, ...patch });
		await this.saveData(this.settings);
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
		const scanner = new ObsidianVaultScanner(this.app, this.noteIds, () => ({
			excludedFolders: [...this.settings.excludedFolders],
			excludedTags: this.settings.excludedTags,
			configDir: this.app.vault.configDir,
		}));
		try {
			const result = await new AnalysisRunner(scanner).run((p) => this.views().forEach((v) => v.setProgress(p)), controller.signal);
			this.lastSummary = result.summary;
			await this.saveNoteIds();
		} catch (e) {
			if (e instanceof AnalysisCancelled) new Notice("Analysis cancelled. Nothing in your vault was changed.");
			else {
				console.error("[indexa] analysis failed", e);
				new Notice(`Analysis failed: ${e instanceof Error ? e.message : e}`);
			}
		} finally {
			this.analysis = null;
			this.views().forEach((v) => v.setProgress(null));
		}
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

	isModelInstalled() {
		return this.modelStore.isInstalled(E5_SMALL);
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
			notice.setMessage("Local semantic model installed.");
		} catch (e) {
			notice.setMessage(`Model download failed: ${e instanceof Error ? e.message : e}`);
		}
		window.setTimeout(() => notice.hide(), 5000);
	}
}
