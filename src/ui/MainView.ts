import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import { STAGES, type Progress } from "../core/AnalysisRunner";
import { formatRemaining, StageEta } from "../core/eta";
import type IndexaPlugin from "../main";
import { ReviewPanels } from "./ReviewPanels";

export const VIEW_TYPE_INDEXA = "indexa-main";

type Tab = "overview" | "indexes" | "unclassified" | "review";
const TABS: { id: Tab; label: string; icon: string }[] = [
	{ id: "overview", label: "Overview", icon: "layout-dashboard" },
	{ id: "indexes", label: "Indexes", icon: "list-tree" },
	{ id: "unclassified", label: "Unclassified", icon: "circle-help" },
	{ id: "review", label: "Review", icon: "check-check" },
];

const nf = new Intl.NumberFormat();

export class MainView extends ItemView {
	private tab: Tab = "overview";
	private progress: Progress | null = null;
	private eta = new StageEta();
	private remainingMs: number | null = null;
	private panels: ReviewPanels;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: IndexaPlugin,
	) {
		super(leaf);
		this.panels = new ReviewPanels(this.app, plugin);
	}

	getViewType() {
		return VIEW_TYPE_INDEXA;
	}

	getDisplayText() {
		return "Indexa";
	}

	getIcon() {
		return "network";
	}

	async onOpen() {
		this.render();
	}

	setTab(tab: Tab) {
		this.tab = tab;
		this.render();
	}

	/** Called by the plugin whenever analysis state changes. */
	setProgress(p: Progress | null) {
		this.progress = p;
		this.remainingMs = p ? this.eta.update(p.stage, p.done, p.total) : null;
		if (!p) this.eta = new StageEta();
		this.render();
	}

	render() {
		const root = this.contentEl;
		root.empty();
		root.addClass("indexa-view");

		const nav = root.createDiv({ cls: "indexa-tabs" });
		for (const t of TABS) {
			const b = nav.createEl("button", { cls: "indexa-tab" + (t.id === this.tab ? " is-active" : ""), attr: { "aria-label": t.label } });
			setIcon(b.createSpan(), t.icon);
			b.createSpan({ text: t.label });
			b.onclick = () => {
				this.tab = t.id;
				this.render();
			};
		}
		const settingsBtn = nav.createEl("button", { cls: "indexa-tab", attr: { "aria-label": "Settings" } });
		setIcon(settingsBtn, "settings");
		settingsBtn.onclick = () => this.plugin.openSettings();

		const body = root.createDiv({ cls: "indexa-body" });
		if (this.tab === "overview") this.renderOverview(body);
		else {
			const review = this.plugin.review.effective();
			if (!review) this.renderPlaceholder(body);
			else if (this.tab === "indexes") this.panels.renderIndexes(body, review);
			else if (this.tab === "unclassified") this.panels.renderUnclassified(body, review);
			else this.panels.renderReview(body, review);
		}
	}

	private renderOverview(el: HTMLElement) {
		const s = this.plugin.lastSummary;

		el.createDiv({ cls: "indexa-privacy", text: "All semantic analysis runs locally. Your note content is not sent to an external AI service." });

		// Model
		const model = el.createDiv({ cls: "indexa-card" });
		model.createEl("h4", { text: "Local semantic model" });
		if (this.plugin.isModelInstalled()) {
			model.createDiv({ cls: "indexa-ok", text: "Installed" });
		} else {
			model.createDiv({ text: `Required for analysis. Approximate download size: ${this.plugin.modelDownloadMb()} MB. This is the only network request Indexa makes.` });
			const b = model.createEl("button", { cls: "mod-cta", text: "Download" });
			b.onclick = async () => {
				b.disabled = true;
				await this.plugin.downloadModel();
				this.render();
			};
		}

		// Progress or stats
		if (this.progress) {
			this.renderProgress(el, this.progress);
			return;
		}

		const stats = el.createDiv({ cls: "indexa-card indexa-stats" });
		stats.createEl("h4", { text: "Vault" });
		if (!s) {
			stats.createDiv({ cls: "indexa-muted", text: "Not analysed yet." });
		} else {
			const excluded = Object.values(s.excluded).reduce((a, b) => a + b, 0);
			const grid = stats.createDiv({ cls: "indexa-grid" });
			const stat = (label: string, value: number, hint?: string) => {
				const c = grid.createDiv({ cls: "indexa-stat" });
				c.createDiv({ cls: "indexa-stat-value", text: nf.format(value) });
				c.createDiv({ cls: "indexa-stat-label", text: label });
				if (hint) c.setAttr("title", hint);
			};
			stat("notes", s.totalFiles);
			stat("analysable", s.analysable);
			stat("excluded", excluded, Object.entries(s.excluded).filter(([, n]) => n).map(([k, n]) => `${k}: ${n}`).join(", "));
			stat("little own text", s.lowContent, "Grouped by metadata (collections) instead of meaning");
			if (s.proposals) {
				stat("suggested indexes", s.proposals.topics + s.proposals.collections, `${s.proposals.topics} topics, ${s.proposals.collections} collections`);
				stat("unclassified", s.proposals.unclassified);
			}
			stats.createDiv({ cls: "indexa-muted", text: `Template lines ignored: ${s.templateLines} · ${(s.durationMs / 1000).toFixed(1)} s` });
			if (s.errors.length) {
				const err = stats.createDiv({ cls: "indexa-warn", text: `${s.errors.length} note(s) skipped. ` });
				const view = err.createEl("a", { text: "View errors", href: "#" });
				view.onclick = (e) => {
					e.preventDefault();
					console.warn("[indexa] skipped notes", s.errors);
					new Notice(s.errors.map((x) => `${x.path}: ${x.message}`).join("\n"), 10000);
				};
			}
		}

		const actions = el.createDiv({ cls: "indexa-actions" });
		const analyse = actions.createEl("button", { cls: "mod-cta", text: "Analyze vault" });
		analyse.onclick = () => this.plugin.analyzeVault();
		actions.createDiv({ cls: "indexa-muted", text: "Preview only: nothing in your vault changes until you press Apply." });
	}

	private renderProgress(el: HTMLElement, p: Progress) {
		const card = el.createDiv({ cls: "indexa-card" });
		card.createEl("h4", { text: "Analyzing vault" });
		card.createDiv({ text: `Stage ${p.stageIndex + 1} / ${STAGES.length}` });
		card.createDiv({ cls: "indexa-stage", text: p.stage });
		if (p.total > 0) {
			const pct = Math.round((p.done / p.total) * 100);
			card.createDiv({ text: `${nf.format(p.done)} / ${nf.format(p.total)} · ${pct}%` + (this.remainingMs !== null ? ` · ${formatRemaining(this.remainingMs)}` : "") });
			const bar = card.createDiv({ cls: "indexa-bar" });
			bar.createDiv({ cls: "indexa-bar-fill" }).style.width = `${pct}%`;
		}
		if (p.stage === "Embedding") card.createDiv({ cls: "indexa-muted", text: "You can keep working. Cancelling keeps everything computed so far; the next run continues from there." });
		const cancel = card.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.plugin.cancelAnalysis();
	}

	private renderPlaceholder(el: HTMLElement) {
		el.createDiv({ cls: "indexa-muted", text: "Run Analyze vault on the Overview tab first." });
	}
}
