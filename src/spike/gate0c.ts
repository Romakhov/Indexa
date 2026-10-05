// Gate 0c: does the pipeline produce clusters that make sense on a real vault?
// Runs on a copy of the user's vault. Compares clusters with the user's own
// manual index assignment (frontmatter "Zettel-link") where it exists, and
// writes a human-readable report note into the (copy) vault.
//
// The report note contains note titles, so it stays in the test vault only.
// The JSON written to the plugin's reports/ folder contains aggregates only.

import { Notice, type App, type TFile } from "obsidian";
import type { ClusterResult } from "../clustering/ClusterEngine";
import { CommunityClusterEngine } from "../clustering/CommunityClusterEngine";
import { refineCommunities } from "../clustering/ClusterRefinement";
import { prepareNote } from "../core/MarkdownProcessor";
import { timeSlicer } from "../core/yieldToUi";
import type { LocalEmbeddingProvider } from "../embeddings/LocalEmbeddingProvider";
import { buildSemanticGraph, type SemanticGraph } from "../graph/SemanticGraphBuilder";
import type { BinaryStore } from "../storage/BinaryStore";
import { HnswVectorIndex } from "../vectors/HnswVectorIndex";
import type { VectorSearchResult } from "../vectors/VectorIndex";
import { SpikeEmbeddingCache } from "./gate0b";
import { nmi, purity } from "./metrics";

const EXCLUDED_FOLDERS = ["Templates/", "Indexes/", "Indexa/"];
export interface Gate0cOptions {
	variant: string;
	/** extra path prefixes to leave out (e.g. a metadata-defined collection) */
	excludePrefixes: string[];
	/** drop lines that repeat across many notes (template boilerplate, spec §16) */
	stripTemplates: boolean;
	/** recursive refinement of too-broad communities (spec §45–46); null = off */
	refineMaxShare: number | null;
}

const DEFAULT_OPTS: Gate0cOptions = { variant: "raw", excludePrefixes: [], stripTemplates: false, refineMaxShare: null };

/**
 * Removes lines that occur in many notes. Lines are compared after
 * lower-casing and replacing digits, so "Оценка: 6/10 · Год: 2015" and
 * "Оценка: 8/10 · Год: 2019" count as the same template line.
 */
function stripTemplateLines(rows: NoteRow[]): number {
	const norm = (l: string) => l.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
	const df = new Map<string, number>();
	const bodies = rows.map((r) => r.text.split("\n").slice(1));
	for (const lines of bodies) for (const l of new Set(lines.map(norm))) df.set(l, (df.get(l) ?? 0) + 1);
	const threshold = Math.max(5, Math.ceil(rows.length * 0.03));
	const template = new Set([...df].filter(([, n]) => n >= threshold).map(([l]) => l));
	rows.forEach((r, i) => {
		const kept = bodies[i].filter((l) => !template.has(norm(l)));
		const title = r.text.split("\n")[0];
		r.text = [title, ...kept].join("\n");
		r.short = kept.join(" ").length < 40;
	});
	return template.size;
}

const RESOLUTIONS = [0.5, 0.75, 1, 1.5, 2];
const PRIMARY_RESOLUTION = 1;

const STOPWORDS = new Set(
	(
		"это этот эта эти того тому того также такой такие когда чтобы потому если тоже только можно нужно очень более менее после перед через между которые который которая которое которых были было быть будет есть нету себя свой свои своих всех всего весь вся может могут ваш наш мной меня тебя него неё нему ними чего чему кого кому сейчас здесь потом даже теперь просто всегда никогда где куда откуда почему зачем есть один одна одно два три " +
		"that this with from have will what when your they them their there then than into about which would could should these those also just like more most some such only other being been were where while after before because does make many much very each over"
	).split(/\s+/),
);

interface NoteRow {
	file: TFile;
	text: string;
	short: boolean;
	gold: string | null;
}

function goldLabel(app: App, file: TFile): string | null {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	const raw = fm?.["Zettel-link"];
	const first = Array.isArray(raw) ? raw[0] : raw;
	if (typeof first !== "string") return null;
	const m = first.match(/\[\[([^\]|#]+)/);
	return m ? m[1].split("/").pop()!.trim() : null;
}

function tokens(text: string): string[] {
	return (text.toLowerCase().replace(/ё/g, "е").match(/\p{L}[\p{L}\d-]{3,}/gu) ?? []).filter((t) => !STOPWORDS.has(t));
}

/**
 * c-TF-IDF keywords per cluster. Counts by crude prefix stem (first 6 chars)
 * so Russian inflections collapse, displays the most frequent surface form.
 */
function clusterKeywords(members: Map<number, NoteRow[]>, top = 8): Map<number, string[]> {
	const stem = (t: string) => t.slice(0, 6);
	const tf = new Map<number, Map<string, number>>();
	const docFreq = new Map<number, Map<string, number>>();
	const surface = new Map<string, Map<string, number>>();
	const total = new Map<string, number>();
	let allTokens = 0;
	for (const [c, rows] of members) {
		const m = new Map<string, number>();
		const df = new Map<string, number>();
		for (const r of rows) {
			const seen = new Set<string>();
			for (const t of tokens(r.text)) {
				const s = stem(t);
				m.set(s, (m.get(s) ?? 0) + 1);
				total.set(s, (total.get(s) ?? 0) + 1);
				const sf = surface.get(s) ?? new Map<string, number>();
				sf.set(t, (sf.get(t) ?? 0) + 1);
				surface.set(s, sf);
				seen.add(s);
				allTokens++;
			}
			for (const s of seen) df.set(s, (df.get(s) ?? 0) + 1);
		}
		tf.set(c, m);
		docFreq.set(c, df);
	}
	const avg = allTokens / Math.max(1, members.size);
	const out = new Map<number, string[]>();
	for (const [c, m] of tf) {
		const size = members.get(c)!.length;
		const clusterTotal = [...m.values()].reduce((a, b) => a + b, 0) || 1;
		const scored = [...m]
			.filter(([s]) => size < 4 || (docFreq.get(c)!.get(s) ?? 0) >= 2)
			.map(([s, n]) => [s, (n / clusterTotal) * Math.log(1 + avg / total.get(s)!)] as const)
			.sort((a, b) => b[1] - a[1])
			.slice(0, top)
			.map(([s]) => [...surface.get(s)!].sort((a, b) => b[1] - a[1])[0][0]);
		out.set(c, scored);
	}
	return out;
}

/** Sum of edge weights from a node to members of its own community. */
function centrality(graph: SemanticGraph, id: string, comm: Map<string, number>): number {
	let s = 0;
	const c = comm.get(id);
	graph.forEachEdge(id, (_e, attr, src, dst) => {
		const other = src === id ? dst : src;
		if (comm.get(other) === c) s += attr.weight;
	});
	return s;
}

const linkPlain = (f: TFile) => `[[${f.path.replace(/\.md$/, "")}|${f.basename}]]`;

export async function runGate0c(app: App, provider: LocalEmbeddingProvider, store: BinaryStore, options: Partial<Gate0cOptions> = {}) {
	const opts = { ...DEFAULT_OPTS, ...options };
	const REPORT_PATH = `Indexa/Gate 0c — ${opts.variant}.md`;
	const t: Record<string, number> = {};
	let mark = performance.now();
	const lap = (k: string) => {
		const now = performance.now();
		t[k] = Math.round(now - mark);
		mark = now;
	};
	const notice = new Notice("Gate 0c: scanning…", 0);

	// 1. scan + prepare
	const files = app.vault
		.getMarkdownFiles()
		.filter((f) => ![...EXCLUDED_FOLDERS, ...opts.excludePrefixes].some((p) => f.path.startsWith(p)) && !f.path.endsWith(".excalidraw.md"))
		.filter((f) => app.metadataCache.getFileCache(f)?.frontmatter?.["zk-ignore"] !== true)
		.sort((a, b) => a.path.localeCompare(b.path));
	const rows: NoteRow[] = [];
	for (const f of files) {
		const p = prepareNote(await app.vault.cachedRead(f), f.basename);
		rows.push({ file: f, text: p.text, short: p.bodyChars < 40, gold: goldLabel(app, f) });
	}
	const templateLines = opts.stripTemplates ? stripTemplateLines(rows) : 0;
	lap("scanMs");

	// 2. embeddings (cached)
	await provider.initialize();
	const cache = new SpikeEmbeddingCache(store, provider.dimensions);
	await cache.load();
	const vectors: Float32Array[] = new Array(rows.length);
	const misses: number[] = [];
	rows.forEach((r, i) => {
		const v = cache.get(cache.key(r.file.path, r.text));
		if (v) vectors[i] = v;
		else misses.push(i);
	});
	misses.sort((a, b) => rows[a].text.length - rows[b].text.length);
	for (let i = 0; i < misses.length; i += 8) {
		const batch = misses.slice(i, i + 8);
		const out = await provider.embedBatch(batch.map((j) => rows[j].text));
		batch.forEach((j, n) => {
			vectors[j] = out[n];
			cache.set(cache.key(rows[j].file.path, rows[j].text), out[n]);
		});
		notice.setMessage(`Gate 0c: embedding ${Math.min(i + 8, misses.length)} / ${misses.length}`);
	}
	if (misses.length) await cache.save();
	lap("embedMs");

	// 3. ANN + graph
	notice.setMessage("Gate 0c: building graph…");
	const K = Math.min(15, rows.length - 1);
	const maybeYield = timeSlicer();
	const ids = rows.map((r) => r.file.path);
	const hnsw = new HnswVectorIndex(store, "gate0c");
	await hnsw.initialize(provider.dimensions, rows.length * 2);
	for (let i = 0; i < rows.length; i++) {
		await hnsw.add(ids[i], vectors[i]);
		await maybeYield();
	}
	const neighbours = new Map<string, VectorSearchResult[]>();
	for (let i = 0; i < rows.length; i++) {
		neighbours.set(ids[i], (await hnsw.search(vectors[i], K + 1)).filter((r) => r.id !== ids[i]).slice(0, K));
		await maybeYield();
	}
	const graph = await buildSemanticGraph(neighbours, { rescale: true });
	lap("graphMs");

	// 4. communities at several resolutions
	const engine = new CommunityClusterEngine();
	const labeled = rows.map((r, i) => [r, i] as const).filter(([r]) => r.gold);
	const goldLabels = labeled.map(([r]) => r.gold!);
	const sweep: Record<string, unknown>[] = [];
	let primary: ClusterResult | null = null;
	for (const resolution of RESOLUTIONS) {
		const res = await engine.cluster(graph, { resolution, seed: 1 });
		if (resolution === PRIMARY_RESOLUTION) primary = res;
		const part = labeled.map(([, i]) => res.communities.get(ids[i])!);
		const sizes = [...res.communities.values()].reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map<number, number>());
		const sorted = [...sizes.values()].sort((a, b) => b - a);
		sweep.push({
			resolution,
			communities: res.count,
			atLeast3: sorted.filter((s) => s >= 3).length,
			largest: sorted[0],
			largestShare: +(sorted[0] / rows.length).toFixed(3),
			modularity: +res.modularity.toFixed(3),
			nmiVsManual: +nmi(goldLabels, part).toFixed(3),
			purityVsManual: +purity(goldLabels, part).toFixed(3),
		});
	}
	let refinedSplits = 0;
	if (opts.refineMaxShare !== null) {
		const refined = await refineCommunities(graph, primary!, engine, { resolution: PRIMARY_RESOLUTION, seed: 1 }, { maxShare: opts.refineMaxShare, minSizeToSplit: 30, maxDepth: 2 });
		refinedSplits = refined.splits;
		primary = refined;
		const part = labeled.map(([, i]) => refined.communities.get(ids[i])!);
		const sizes = [...refined.communities.values()].reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map<number, number>());
		const sorted = [...sizes.values()].sort((a, b) => b - a);
		sweep.push({
			resolution: `${PRIMARY_RESOLUTION} + refine`,
			communities: refined.count,
			atLeast3: sorted.filter((x) => x >= 3).length,
			largest: sorted[0],
			largestShare: +(sorted[0] / rows.length).toFixed(3),
			modularity: NaN,
			nmiVsManual: +nmi(goldLabels, part).toFixed(3),
			purityVsManual: +purity(goldLabels, part).toFixed(3),
		});
	}
	lap("clusterMs");

	// 5. report note
	const comm = primary!.communities;
	const members = new Map<number, NoteRow[]>();
	rows.forEach((r) => {
		const c = comm.get(r.file.path)!;
		members.set(c, [...(members.get(c) ?? []), r]);
	});
	const keywords = clusterKeywords(members);
	const order = [...members.keys()].sort((a, b) => members.get(b)!.length - members.get(a)!.length);

	const lines: string[] = [
		"---",
		"indexa-report: gate-0c",
		"---",
		`# Indexa — Gate 0c: предложенные кластеры (${opts.variant})`,
		"",
		`Вариант: исключено ${opts.excludePrefixes.join(", ") || "ничего дополнительно"}; шаблонные строки ${opts.stripTemplates ? `удалены (${templateLines})` : "не удалялись"}; дробление крупных кластеров ${opts.refineMaxShare !== null ? `> ${opts.refineMaxShare * 100}%` : "выкл."}.`,
		"",
		`Заметок проанализировано: **${rows.length}** (исключены ${EXCLUDED_FOLDERS.join(", ")}, Excalidraw). Коротких (<40 символов текста): ${rows.filter((r) => r.short).length}. С ручным индексом (Zettel-link): ${labeled.length}.`,
		"",
		"Это **сырые сообщества графа** без доработки: без дробления больших кластеров, без мультииндексов, без названий. Цель — понять, видна ли в них смысловая структура.",
		"",
		"## Сравнение разрешений",
		"",
		"| resolution | кластеров | ≥3 заметок | крупнейший | NMI с ручными индексами | purity |",
		"|---|---|---|---|---|---|",
		...sweep.map((s) => `| ${s.resolution} | ${s.communities} | ${s.atLeast3} | ${s.largest} (${Math.round((s.largestShare as number) * 100)}%) | ${s.nmiVsManual} | ${s.purityVsManual} |`),
		"",
		`## Кластеры при resolution = ${PRIMARY_RESOLUTION}${opts.refineMaxShare !== null ? " + дробление" : ""}`,
		"",
	];
	order.forEach((c, n) => {
		const rs = members.get(c)!;
		const byCentrality = [...rs].sort((a, b) => centrality(graph, b.file.path, comm) - centrality(graph, a.file.path, comm));
		const goldCounts = rs.filter((r) => r.gold).reduce((m, r) => m.set(r.gold!, (m.get(r.gold!) ?? 0) + 1), new Map<string, number>());
		const gold = [...goldCounts].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([g, k]) => `${g} (${k})`).join(", ");
		const folders = rs.reduce((m, r) => m.set(r.file.parent?.path ?? "/", (m.get(r.file.parent?.path ?? "/") ?? 0) + 1), new Map<string, number>());
		const topFolders = [...folders].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, k]) => `${f} (${k})`).join(", ");
		lines.push(`### ${n + 1}. ${keywords.get(c)!.slice(0, 3).join(" · ") || "—"} — ${rs.length} заметок`);
		lines.push("");
		lines.push(`- **Ключевые слова:** ${keywords.get(c)!.join(", ")}`);
		lines.push(`- **Ваши индексы среди них:** ${gold || "нет размеченных"}`);
		lines.push(`- **Папки:** ${topFolders}`);
		lines.push(`- **Центральные заметки:** ${byCentrality.slice(0, 5).map((r) => linkPlain(r.file)).join(", ")}`);
		const rest = byCentrality.slice(5, 30);
		if (rest.length) lines.push(`- **Ещё:** ${rest.map((r) => linkPlain(r.file)).join(", ")}${rs.length > 30 ? ` … и ещё ${rs.length - 30}` : ""}`);
		lines.push("");
	});
	if (!(await app.vault.adapter.exists("Indexa"))) await app.vault.createFolder("Indexa");
	const existing = app.vault.getFileByPath(REPORT_PATH);
	if (existing) await app.vault.modify(existing, lines.join("\n"));
	else await app.vault.create(REPORT_PATH, lines.join("\n"));
	lap("reportMs");
	notice.hide();

	return {
		gate: "0c",
		variant: opts,
		templateLines,
		refinedSplits,
		notes: rows.length,
		shortNotes: rows.filter((r) => r.short).length,
		labeledNotes: labeled.length,
		manualIndexes: new Set(goldLabels).size,
		newlyEmbedded: misses.length,
		timingsMs: t,
		graph: { edges: graph.size, k: K },
		sweep,
		reportNote: REPORT_PATH,
	};
}
