// Dev evaluation of Phase 5 proposals against the user's manual indexes, and a
// readable report note in the (test) vault.

import type { App } from "obsidian";
import type { AnalysisResult } from "../core/AnalysisRunner";
import { buildProposals } from "../indexing/IndexProposalEngine";
import type { ProposalSet } from "../indexing/types";
import { nmi, purity } from "./metrics";

function goldOf(fm: Record<string, unknown>): string | null {
	const raw = fm["Zettel-link"];
	const first = Array.isArray(raw) ? raw[0] : raw;
	const m = typeof first === "string" ? first.match(/\[\[([^\]|#]+)/) : null;
	return m ? m[1].split("/").pop()!.trim() : null;
}

function evaluate(set: ProposalSet, r: AnalysisResult) {
	const gold = new Map<string, string>();
	for (const n of r.notes) {
		const g = goldOf(n.frontmatter);
		if (g) gold.set(n.id, g);
	}
	const content = r.proposalNotes!.filter((n) => !n.lowContent).map((n) => n.id);
	const contentSet = new Set(content);
	const primary = new Map<string, string>();
	for (const p of set.proposals) {
		if (p.kind !== "topic") continue;
		for (const m of p.members) if (m.primary) primary.set(m.noteId, p.id);
	}
	const kept = content.filter((id) => gold.has(id) && primary.has(id));

	// raw community majority agreement: are the peeled notes the ones raw clustering got wrong?
	const comm = r.communities!;
	const byComm = new Map<number, string[]>();
	for (const id of content) if (gold.has(id) && comm.has(id)) byComm.set(comm.get(id)!, [...(byComm.get(comm.get(id)!) ?? []), gold.get(id)!]);
	const majority = new Map<number, string>();
	for (const [c, ls] of byComm) {
		const counts = ls.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
		majority.set(c, [...counts].sort((a, b) => b[1] - a[1])[0][0]);
	}
	const rawRight = (id: string) => comm.has(id) && majority.get(comm.get(id)!) === gold.get(id);
	const peeled = set.unclassified.filter((id) => gold.has(id) && contentSet.has(id));
	const ids = [...new Set(kept.map((id) => primary.get(id)!))];

	return {
		topics: set.proposals.filter((p) => p.kind === "topic").length,
		collections: set.stats.collections,
		coverage: +(content.filter((id) => primary.has(id)).length / content.length).toFixed(3),
		unclassifiedContent: content.filter((id) => !primary.has(id)).length,
		purity: +purity(kept.map((id) => gold.get(id)!), kept.map((id) => ids.indexOf(primary.get(id)!))).toFixed(3),
		nmi: +nmi(kept.map((id) => gold.get(id)!), kept.map((id) => primary.get(id)!)).toFixed(3),
		rawRightAmongKept: +(kept.filter(rawRight).length / Math.max(1, kept.length)).toFixed(3),
		rawRightAmongUnclassified: +(peeled.filter(rawRight).length / Math.max(1, peeled.length)).toFixed(3),
		multiIndexNotes: set.stats.multiIndexNotes,
		named: set.proposals.filter((p) => p.name.primary).length,
	};
}

export async function proposalsEval(_app: App, r: AnalysisResult, base: Parameters<typeof buildProposals>[3], cuts = [0.2, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6]) {
	if (!r.proposalNotes || !r.communities || !r.keywords) throw new Error("Run Analyze vault first");
	const sweep = cuts.map((minConfidence) => ({ minConfidence, ...evaluate(buildProposals(r.proposalNotes!, r.communities!, r.keywords!, { ...base, minConfidence }), r) }));
	return { sweep };
}

/** Human-readable report of the current proposal set, written into the test vault. */
export async function writeProposalReport(app: App, r: AnalysisResult, path = "Indexa/Phase 5 — предложения.md") {
	const set = r.proposals!;
	const note = new Map(r.notes.map((n) => [n.id, n]));
	const link = (id: string) => {
		const n = note.get(id)!;
		return `[[${n.path.replace(/\.md$/, "")}|${n.title}]]`;
	};
	const nameOf = (id: string) => {
		const p = set.proposals.find((x) => x.id === id)!;
		return p.name.primary ?? `Unnamed (${p.name.keywords.slice(0, 2).join(", ")})`;
	};
	const lines = [
		"# Indexa — Phase 5: предложенные индексы",
		"",
		`Тем: **${set.proposals.filter((p) => p.kind === "topic").length}**, коллекций: **${set.stats.collections}**, без индекса (Unclassified): **${set.unclassified.length}**, заметок с несколькими индексами: **${set.stats.multiIndexNotes}**.`,
		"",
		"Это предпросмотр: в хранилище ничего не изменено.",
		"",
	];
	for (const p of set.proposals) {
		const prim = p.members.filter((m) => m.primary);
		const sec = p.members.filter((m) => !m.primary);
		lines.push(`## ${p.name.primary ?? "Unnamed topic"}${p.kind === "collection" ? " (коллекция)" : ""} — ${prim.length}${sec.length ? ` + ${sec.length} вторично` : ""}`);
		lines.push("");
		if (p.signature) lines.push(`- **Признак коллекции:** \`${p.signature}\``);
		lines.push(`- **Ключевые слова:** ${p.name.keywords.join(", ") || "—"}`);
		if (p.name.alternatives.length) lines.push(`- **Другие варианты имени:** ${p.name.alternatives.join(" · ")}`);
		lines.push(`- **Уверенность имени / связность:** ${p.name.confidence} / ${p.confidence}`);
		lines.push(`- **Центральные заметки:** ${p.sampleNoteIds.map(link).join(", ")}`);
		const rest = prim.filter((m) => !p.sampleNoteIds.includes(m.noteId));
		if (rest.length) lines.push(`- **Ещё:** ${rest.slice(0, 20).map((m) => link(m.noteId)).join(", ")}${rest.length > 20 ? ` … и ещё ${rest.length - 20}` : ""}`);
		if (sec.length)
			lines.push(
				`- **Вторично (мультииндекс):** ${sec
					.slice(0, 12)
					.map((m) => `${link(m.noteId)} (${Math.round(m.score * 100)}%${m.via === "chunk" && m.heading ? `, раздел «${m.heading}»` : ""})`)
					.join(", ")}`,
			);
		if (p.related.length) lines.push(`- **Связанные индексы:** ${p.related.map((x) => nameOf(x.proposalId)).join(", ")}`);
		lines.push("");
	}
	lines.push(`## Unclassified — ${set.unclassified.length}`, "");
	lines.push(set.unclassified.slice(0, 80).map(link).join(", ") + (set.unclassified.length > 80 ? ` … и ещё ${set.unclassified.length - 80}` : ""));
	if (!(await app.vault.adapter.exists("Indexa"))) await app.vault.createFolder("Indexa");
	const f = app.vault.getFileByPath(path);
	if (f) await app.vault.modify(f, lines.join("\n"));
	else await app.vault.create(path, lines.join("\n"));
	return path;
}
