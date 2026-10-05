// Incremental mode (spec §11–13, §60–63, §94): vault events → per-note
// debounce → bounded queue → single-note embedding → vector index update →
// index suggestions, without re-analysing the vault.

import { Notice, TFile, type TAbstractFile } from "obsidian";
import { contentHash } from "../core/hash";
import { processNote } from "../core/MarkdownProcessor";
import { KeyedDebouncer, ProcessingQueue } from "../core/ProcessingQueue";
import { chunkNote } from "../core/SemanticChunker";
import { TemplateLines } from "../core/TemplateDetector";
import { embedNotes } from "../embeddings/NoteEmbedder";
import type IndexaPlugin from "../main";
import { IncrementalScorer, significantChange, type IndexSuggestion } from "./IncrementalScorer";
import { ReviewQueue, type QueueItem } from "./ReviewQueue";

type Kind = "new" | "changed";
interface Job {
	kind: Kind;
	/** started by the user (command), runs even with auto-analysis off */
	manual?: boolean;
}

export interface ProcessResult {
	status: "suggested" | "unchanged" | "no-new-indexes" | "excluded" | "skipped" | "assigned";
	suggestions?: IndexSuggestion[];
	ms?: number;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export class IncrementalProcessor {
	readonly queue: ReviewQueue;
	private readonly debouncer: KeyedDebouncer<string>;
	private readonly jobs: ProcessingQueue<string, Job>;
	private kinds = new Map<string, Kind>();
	/** >0 while Indexa itself writes to the vault (Apply / Undo) */
	private suppress = 0;
	/**
	 * path -> hash of the text Indexa itself wrote there. A later event for that
	 * path is skipped only while the file still has exactly that text, so a user
	 * edit right after an Apply is never lost (no time window).
	 */
	private ownWrites = new Map<string, string>();
	lastResult: (ProcessResult & { path: string }) | null = null;

	constructor(private readonly plugin: IndexaPlugin) {
		this.queue = new ReviewQueue(plugin.app.vault.adapter, `${plugin.manifest.dir}/queue.json`);
		this.debouncer = new KeyedDebouncer(plugin.settings.debounceMs, (path) => this.jobs.enqueue(path, { kind: this.kinds.get(path) ?? "changed" }));
		this.jobs = new ProcessingQueue<string, Job>(
			async (path, job) => {
				this.kinds.delete(path);
				const r = await this.process(path, job);
				this.lastResult = { ...r, path };
			},
			1,
			(path, e) => console.warn(`[indexa] incremental processing failed for ${path}`, e),
		);
	}

	/** Runs `fn` while ignoring the vault events it causes (Indexa's own writes). */
	async quietly<T>(fn: () => Promise<T>): Promise<T> {
		this.suppress++;
		try {
			return await fn();
		} finally {
			this.suppress--;
		}
	}

	/** Remember what Indexa wrote, so late events for these files are recognised as its own. */
	recordOwnWrites(writes: { path: string; hash: string }[]) {
		for (const w of writes) this.ownWrites.set(w.path, w.hash);
		if (this.ownWrites.size > 5000) this.ownWrites = new Map([...this.ownWrites].slice(-2000));
	}

	private ignored(file: TAbstractFile): file is TFile {
		return !(file instanceof TFile) || file.extension !== "md" || this.suppress > 0;
	}

	setDebounce(ms: number) {
		this.debouncer.setDelay(ms);
	}

	onCreate(file: TAbstractFile) {
		if (this.ignored(file)) return;
		this.kinds.set(file.path, "new");
		this.debouncer.trigger(file.path);
	}

	onModify(file: TAbstractFile) {
		if (this.ignored(file)) return;
		if (!this.kinds.has(file.path)) this.kinds.set(file.path, "changed");
		this.debouncer.trigger(file.path);
	}

	/** Rename: ids follow the file (NoteIdRegistry); content unchanged → no re-embedding (spec §63). */
	async onRename(file: TAbstractFile, oldPath: string) {
		if (!(file instanceof TFile)) return;
		const kind = this.kinds.get(oldPath);
		if (kind) {
			this.debouncer.cancel(oldPath);
			this.kinds.delete(oldPath);
			this.kinds.set(file.path, kind);
			this.debouncer.trigger(file.path);
		}
		const id = this.plugin.noteIdFor(file.path);
		await this.queue.rename(id, file.path);
	}

	/** Delete: vector, cache entry, queue item and memberships go (spec §63). */
	async onDelete(path: string, noteId: string | undefined) {
		this.debouncer.cancel(path);
		this.kinds.delete(path);
		this.jobs.remove(path);
		if (!noteId) return;
		const cache = this.plugin.getCache();
		await cache.load();
		cache.delete(noteId);
		await cache.save();
		await this.plugin.getVectorIndex().remove([noteId]);
		await this.queue.remove(noteId);
		this.plugin.forgetNote(noteId);
	}

	/** Command: suggest indexes for one note now. */
	async runNow(file: TFile): Promise<ProcessResult> {
		this.debouncer.cancel(file.path);
		const r = await this.process(file.path, { kind: this.kinds.get(file.path) ?? "changed", manual: true });
		this.lastResult = { ...r, path: file.path };
		return r;
	}

	idle() {
		return this.jobs.onIdle();
	}

	dispose() {
		this.debouncer.cancelAll();
		this.jobs.clear();
	}

	private async process(path: string, job: Job): Promise<ProcessResult> {
		const t0 = performance.now();
		const p = this.plugin;
		if (!job.manual && !p.settings.autoAnalyzeNewNotes) return { status: "skipped" };
		if (!p.stored || !p.isModelInstalled() || p.isAnalysing()) return { status: "skipped" };
		const file = p.app.vault.getFileByPath(path);
		if (!file) return { status: "skipped" };
		const own = this.ownWrites.get(path);
		if (own !== undefined) {
			this.ownWrites.delete(path);
			if (own === contentHash(await p.app.vault.read(file))) return { status: "skipped" };
		}

		const doc = await p.scanner().scanFile(file);
		if (!doc) {
			// now excluded (folder, tag, zk-ignore, generated index): forget its vector
			const id = p.noteIdFor(path);
			await p.getVectorIndex().remove([id]);
			await this.queue.remove(id);
			return { status: "excluded" };
		}
		const templates = TemplateLines.fromArray(p.stored.templateLines);
		const processed = processNote(doc, templates);
		const chunks = chunkNote(doc, templates);
		const cache = p.getCache();
		await cache.load();
		const before = cache.peek(doc.id)?.documentVector;
		await embedNotes([{ processed, chunks }], p.getProvider(), cache);
		await cache.save();
		const entry = cache.peek(doc.id);
		if (!entry) return { status: "skipped" };
		p.rememberPath(doc.id, doc.path);

		const index = p.getVectorIndex();
		await index.ensureBuilt(cache, p.knownNoteIds(), p.contentNoteIds());
		await index.upsertOne(entry);
		if (job.kind === "changed" && !job.manual && !significantChange(before, entry.documentVector)) return { status: "unchanged", ms: Math.round(performance.now() - t0) };

		const review = p.review.effective();
		if (!review) return { status: "skipped" };
		const live = review.indexes.filter((i) => !i.ignored);
		const scorer = new IncrementalScorer(
			live.map((i) => ({ id: i.id, kind: i.kind, signature: i.signature, memberIds: i.members.filter((m) => m.primary && m.noteId !== doc.id).map((m) => m.noteId) })),
			(id) => {
				const e = cache.peek(id);
				return e ? (index.centre(e.documentVector) ?? undefined) : undefined;
			},
		);
		const vector = index.centre(entry.documentVector)!;
		const suggestions = scorer.suggest(
			{
				vector,
				chunks: entry.chunks?.map((c) => ({ heading: c.heading, vector: index.centre(c.vector)! })),
				path: doc.path,
				tags: doc.tags,
				frontmatter: doc.frontmatter,
				lowContent: processed.lowContent,
			},
			{ max: p.settings.maxIndexesPerNote, minPercentile: 0.1 },
		);
		const current = new Set(live.filter((i) => i.members.some((m) => m.noteId === doc.id)).map((i) => i.id));
		const fresh = suggestions.filter((s) => !current.has(s.indexId));
		const ms = Math.round(performance.now() - t0);
		if (!fresh.length) {
			await this.queue.remove(doc.id);
			p.refreshViews();
			return { status: "no-new-indexes", suggestions, ms };
		}

		// a note that has no index yet gets its best suggestion right away when asking is off
		if (!p.settings.askBeforeAssigning && current.size === 0) {
			await this.accept(doc.id, fresh[0].indexId);
			return { status: "assigned", suggestions: fresh, ms };
		}
		const similar = (await index.search(entry.documentVector, 4, doc.id)).map((r) => r.id);
		const item: QueueItem = { noteId: doc.id, path: doc.path, kind: job.kind, suggestions: fresh, similar, createdAt: Date.now() };
		await this.queue.put(item);
		p.refreshViews();
		if (!job.manual && job.kind === "new") this.notify(item);
		return { status: "suggested", suggestions: fresh, ms };
	}

	/** Adds a note to an index: a review decision, written to the vault if the structure is applied. */
	async accept(noteId: string, indexId: string) {
		await this.plugin.review.addNoteById(indexId, noteId);
		await this.queue.remove(noteId);
		await this.plugin.applier.applyNotes([noteId]);
		this.plugin.refreshViews();
	}

	async dismiss(noteId: string) {
		await this.queue.remove(noteId);
		this.plugin.refreshViews();
	}

	private notify(item: QueueItem) {
		const p = this.plugin;
		const names = new Map((p.review.effective()?.indexes ?? []).map((i) => [i.id, i.name]));
		const frag = createFragment((f) => {
			f.createDiv({ text: `Indexa: indexes for "${item.path.split("/").pop()!.replace(/\.md$/, "")}"` });
			const list = f.createDiv({ cls: "indexa-notice-list" });
			for (const s of item.suggestions) list.createDiv({ text: `${names.get(s.indexId) ?? "?"} ${s.via === "collection" ? "" : pct(s.score)}`.trim() });
			const row = f.createDiv({ cls: "indexa-notice-actions" });
			const add = row.createEl("button", { cls: "mod-cta", text: "Add" });
			add.onclick = () => {
				notice.hide();
				void this.accept(item.noteId, item.suggestions[0].indexId);
			};
			const review = row.createEl("button", { text: "Review" });
			review.onclick = () => {
				notice.hide();
				void p.openTab("review");
			};
			const ignore = row.createEl("button", { text: "Ignore" });
			ignore.onclick = () => {
				notice.hide();
				void this.dismiss(item.noteId);
			};
		});
		const notice = new Notice(frag, 20000);
	}
}
