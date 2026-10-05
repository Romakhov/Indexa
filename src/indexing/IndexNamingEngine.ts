// Index name suggestions without a generative model (spec §50–51).
//
// Candidates, strongest first:
//   1. a title phrase (1–2 words) that several member notes share and the rest
//      of the vault rarely uses — the user's own vocabulary, in the form they
//      write it (taken from a title that starts with it, usually nominative)
//   2. a tag concentrated in this group (not one spread over the whole vault)
//   3. the top c-TF-IDF keyword, in a title form if a member title uses it
// Generic names are never proposed; low confidence → "Unnamed topic" + keywords.
// Pure.

import { stem, tokenize } from "../keywords/KeywordExtractor";
import type { IndexNameSuggestion } from "./types";

const GENERIC = new Set(
	"notes note things thing general misc miscellaneous other others ideas idea stuff inbox untitled index scan book video draft заметки заметка разное прочее другое общее идеи идея мысли входящие черновики черновик без названия".split(
		" ",
	),
);

export function isGenericName(name: string): boolean {
	const n = name.trim().toLowerCase();
	// dates and serial numbers ("scan-2026-09-17", "PABO-C3-2026") are file names, not topics
	const digits = (n.match(/\d/g) ?? []).length;
	return !n || GENERIC.has(n) || /^\d+$/.test(n) || n.length < 3 || digits >= 4 || /\d{4}-\d{2}/.test(n);
}

/** Stem-keyed phrase statistics over all note titles of the vault. */
export class TitleVocabulary {
	private df = new Map<string, number>();
	readonly titleCount: number;

	constructor(titles: string[]) {
		this.titleCount = titles.length;
		for (const t of titles) for (const key of new Set(phrases(t).map((p) => p.key))) this.df.set(key, (this.df.get(key) ?? 0) + 1);
	}

	docFreq(key: string) {
		return this.df.get(key) ?? 0;
	}
}

interface Phrase {
	key: string;
	words: string[];
	/** starts the title (likely nominative) */
	atStart: boolean;
}

/** unigrams and bigrams of meaningful words, keyed by stems */
function phrases(title: string): Phrase[] {
	const words = title
		.replace(/[_]+/g, " ")
		.split(/[^\p{L}\d-]+/u)
		.filter(Boolean);
	const meaningful = words.map((w) => (tokenize(w).length ? w : null));
	const out: Phrase[] = [];
	for (let i = 0; i < meaningful.length; i++) {
		const w = meaningful[i];
		if (!w) continue;
		out.push({ key: stem(w.toLowerCase()), words: [w], atStart: i === 0 });
		const n = meaningful[i + 1];
		if (n) out.push({ key: `${stem(w.toLowerCase())} ${stem(n.toLowerCase())}`, words: [w, n], atStart: i === 0 });
	}
	return out;
}

export interface NamingInput {
	/** member titles, most central first */
	centralTitles: string[];
	/** c-TF-IDF keywords of the group, best first (readable forms) */
	keywords: string[];
	/** tags with the share of members carrying them */
	tagShares: { tag: string; share: number }[];
	/** share of all analysed notes carrying each tag */
	vaultTagShare?: Map<string, number>;
	vocabulary?: TitleVocabulary;
	/** names already used by other proposals in this run */
	taken: Set<string>;
}

const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const tagLabel = (tag: string) => capitalise(tag.split("/").pop()!.replace(/[-_]+/g, " "));

/** The keyword in the form the user writes it in titles, if any title uses that stem. */
function titleForm(keyword: string, titles: string[]): string {
	const s = stem(keyword.toLowerCase());
	for (const t of titles) for (const p of phrases(t)) if (p.words.length === 1 && p.key === s) return p.words[0];
	return keyword;
}

export function suggestIndexName(input: NamingInput): IndexNameSuggestion {
	const candidates: { name: string; confidence: number }[] = [];
	const push = (name: string, confidence: number) => {
		const n = capitalise(name.trim());
		if (isGenericName(n) || input.taken.has(n.toLowerCase())) return;
		const same = candidates.find((c) => c.name.toLowerCase() === n.toLowerCase());
		if (same) same.confidence = Math.max(same.confidence, confidence);
		else candidates.push({ name: n, confidence });
	};

	// 1. shared title phrases
	const titles = input.centralTitles.slice(0, 25);
	const keyStems = new Set(input.keywords.slice(0, 8).map((k) => stem(k.toLowerCase())));
	const stats = new Map<string, { titles: number; weight: number; forms: Map<string, { n: number; atStart: number }>; bigram: boolean }>();
	titles.forEach((t, rank) => {
		const seen = new Set<string>();
		for (const p of phrases(t)) {
			if (seen.has(p.key)) continue;
			seen.add(p.key);
			const s = stats.get(p.key) ?? { titles: 0, weight: 0, forms: new Map(), bigram: p.words.length === 2 };
			s.titles++;
			s.weight += 1 / (1 + rank * 0.15); // central titles count more
			const form = p.words.join(" ");
			const f = s.forms.get(form) ?? { n: 0, atStart: 0 };
			f.n++;
			if (p.atStart) f.atStart++;
			s.forms.set(form, f);
			stats.set(p.key, s);
		}
	});
	const minTitles = Math.max(2, Math.ceil(titles.length * 0.15));
	const phraseConfidence = new Map<string, number>();
	for (const [key, s] of stats) {
		if (s.titles < minTitles) continue;
		const vaultDf = input.vocabulary?.docFreq(key) ?? s.titles;
		const concentration = s.titles / Math.max(s.titles, vaultDf); // 1 = only in this group
		const inKeywords = key.split(" ").some((k) => keyStems.has(k));
		const form = [...s.forms].sort((a, b) => b[1].atStart - a[1].atStart || b[1].n - a[1].n)[0][0];
		const confidence = Math.min(0.95, 0.35 + 0.25 * concentration + 0.08 * Math.min(4, s.titles) + (inKeywords ? 0.1 : 0) + (s.bigram ? 0.05 : 0));
		phraseConfidence.set(key, confidence);
		push(form, confidence);
	}
	// a two-word phrase that covers most titles of its head word is the more precise name
	// ("Манипуляция сознанием" over "Манипуляция")
	for (const [key, s] of stats) {
		// only when some title starts with it: otherwise the form is usually oblique ("заметок Zettelkasten")
		if (!s.bigram || !phraseConfidence.has(key) || ![...s.forms.values()].some((f) => f.atStart > 0)) continue;
		for (const part of key.split(" ")) {
			const uni = stats.get(part);
			const uniConf = phraseConfidence.get(part);
			if (!uni || uniConf === undefined || s.titles < 0.6 * uni.titles) continue;
			const form = [...s.forms].sort((a, b) => b[1].atStart - a[1].atStart || b[1].n - a[1].n)[0][0];
			push(form, Math.min(0.96, uniConf + 0.02));
		}
	}

	// 2. concentrated tag
	for (const t of input.tagShares) {
		if (t.share < 0.6 || isGenericName(t.tag.split("/").pop()!)) continue;
		const vaultShare = input.vaultTagShare?.get(t.tag) ?? 0;
		const lift = vaultShare > 0 ? t.share / vaultShare : 5;
		if (lift < 3) continue; // the tag is everywhere: says nothing about this group
		push(tagLabel(t.tag), 0.5 + 0.3 * t.share);
	}

	// 3. top keyword in title form
	if (input.keywords.length) {
		push(titleForm(input.keywords[0], titles), 0.5);
		if (input.keywords.length > 1) push(`${capitalise(titleForm(input.keywords[0], titles))} и ${titleForm(input.keywords[1], titles)}`, 0.35);
	}

	candidates.sort((a, b) => b.confidence - a.confidence);
	const best = candidates[0];
	const named = best && best.confidence >= 0.5;
	return {
		primary: named ? best.name : undefined,
		alternatives: candidates.slice(named ? 1 : 0, named ? 4 : 3).map((c) => c.name),
		keywords: input.keywords,
		confidence: best ? +best.confidence.toFixed(2) : 0,
	};
}
