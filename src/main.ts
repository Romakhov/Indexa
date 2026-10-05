import { Notice, Plugin } from "obsidian";
import { LocalEmbeddingProvider } from "./embeddings/LocalEmbeddingProvider";
import { E5_SMALL, ModelStore } from "./embeddings/ModelStore";
import { runGate0a } from "./spike/gate0a";

export default class StructureTreePlugin extends Plugin {
	onloadMs = 0;
	modelStore!: ModelStore;
	private provider: LocalEmbeddingProvider | null = null;

	async onload() {
		// Keep onload cheap: no model, no scanning, no worker.
		const t0 = performance.now();
		this.modelStore = new ModelStore();

		this.addCommand({
			id: "download-model",
			name: "Download local semantic model",
			callback: () => this.downloadModel(),
		});
		this.addCommand({
			id: "spike-gate-0a",
			name: "Spike: run Gate 0a self-test",
			callback: () => this.runGate0a(),
		});

		this.onloadMs = performance.now() - t0;
	}

	async onunload() {
		await this.provider?.dispose();
	}

	/** Lazily created; the model is loaded only on first use. */
	getProvider(): LocalEmbeddingProvider {
		this.provider ??= new LocalEmbeddingProvider(this.modelStore, E5_SMALL);
		return this.provider;
	}

	async downloadModel() {
		if (this.modelStore.isInstalled(E5_SMALL)) {
			new Notice("Local semantic model is already installed.");
			return;
		}
		const mb = Math.round(E5_SMALL.approxBytes / 1e6);
		const notice = new Notice(`Downloading local semantic model (~${mb} MB)…`, 0);
		try {
			await this.modelStore.download(E5_SMALL, (file, i, n) => notice.setMessage(`Downloading model ${i}/${n}: ${file}`));
			notice.setMessage("Local semantic model installed.");
		} catch (e) {
			notice.setMessage(`Model download failed: ${e instanceof Error ? e.message : e}`);
		}
		window.setTimeout(() => notice.hide(), 5000);
	}

	async runGate0a() {
		new Notice("Gate 0a: running…");
		try {
			const report = await runGate0a(this.getProvider(), {
				pluginOnloadMs: +this.onloadMs.toFixed(2),
				modelDir: this.modelStore.dir(E5_SMALL),
			});
			const dir = `${this.manifest.dir}/reports`;
			if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
			await this.app.vault.adapter.write(`${dir}/gate0a.json`, JSON.stringify(report, null, 2));
			console.log("[structure-tree] Gate 0a report", report);
			new Notice(`Gate 0a: ${report.passed ? "PASSED" : "FAILED"} (see console)`);
			return report;
		} catch (e) {
			console.error("[structure-tree] Gate 0a error", e);
			new Notice(`Gate 0a error: ${e instanceof Error ? e.message : e}`);
			throw e;
		}
	}
}
