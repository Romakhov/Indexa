// Dev-only: reproducible large benchmark vault (spec §72) from Wikipedia (CC BY-SA).
//
//   node scripts/make-bench-vault.mjs <outDir> [total=10000]
//
// 20 topics, Russian + English. Includes short notes, long notes (full
// articles), wikilinks between notes, tags (topical and noisy), notes with the
// same file name in different folders. Notes are spread over nested parts so
// one vault serves every size: p1 = 500, p1+p2 = 2 000, +p3 = 5 000, +p4 = 10 000.
// Labels (topic per file) go to bench-manifest.json, never into the notes.

import fs from "node:fs";
import path from "node:path";

const OUT = process.argv[2];
const TOTAL = Number(process.argv[3] ?? 10000);
if (!OUT) throw new Error("usage: make-bench-vault.mjs <outDir> [total]");
const UA = "IndexaBenchBuilder/0.1 (dev benchmark; kdromahov@gmail.com)";

const TOPICS = {
	programming: { en: ["Programming languages", "Software engineering", "Computer programming"], ru: ["Языки программирования", "Программирование", "Разработка программного обеспечения"] },
	productivity: { en: ["Time management", "Project management", "Productivity"], ru: ["Тайм-менеджмент", "Управление проектами", "Планирование"] },
	ai: { en: ["Machine learning", "Artificial intelligence", "Natural language processing"], ru: ["Машинное обучение", "Искусственный интеллект", "Обработка естественного языка"] },
	astrophysics: { en: ["Astrophysics", "Stellar astronomy", "Black holes"], ru: ["Астрофизика", "Звёздная астрономия", "Чёрные дыры"] },
	cooking: { en: ["Cooking techniques", "Baking", "Sauces"], ru: ["Кулинария", "Технология приготовления пищи", "Соусы"] },
	travel: { en: ["Types of tourism", "Tourism", "Hiking"], ru: ["Туризм", "Виды туризма", "Пеший туризм"] },
	finance: { en: ["Investment", "Banking", "Personal finance"], ru: ["Инвестиции", "Банковское дело", "Финансы"] },
	medicine: { en: ["Cardiology", "Infectious diseases", "Medical treatments"], ru: ["Кардиология", "Инфекционные заболевания", "Методы лечения"] },
	history: { en: ["Ancient Rome", "Medieval history", "History of Russia"], ru: ["Древний Рим", "Средние века", "История России"] },
	music: { en: ["Musical instruments", "Music theory", "Rock music genres"], ru: ["Музыкальные инструменты", "Теория музыки", "Жанры рок-музыки"] },
	sports: { en: ["Association football", "Tennis", "Athletics (sport)"], ru: ["Футбол", "Теннис", "Лёгкая атлетика"] },
	biology: { en: ["Genetics", "Cell biology", "Ecology"], ru: ["Генетика", "Цитология", "Экология"] },
	chemistry: { en: ["Organic chemistry", "Chemical reactions", "Chemical elements"], ru: ["Органическая химия", "Химические реакции", "Химические элементы"] },
	law: { en: ["Contract law", "Criminal law", "Constitutional law"], ru: ["Договорное право", "Уголовное право", "Конституционное право"] },
	psychology: { en: ["Cognitive biases", "Cognitive psychology", "Social psychology"], ru: ["Когнитивные искажения", "Когнитивная психология", "Социальная психология"] },
	philosophy: { en: ["Ethics", "Epistemology", "Philosophers"], ru: ["Этика", "Эпистемология", "Философы"] },
	architecture: { en: ["Architectural styles", "Bridges", "Castles"], ru: ["Архитектурные стили", "Мосты", "Замки"] },
	cinema: { en: ["Film genres", "Film directors", "Cinematography"], ru: ["Жанры кино", "Кинорежиссёры", "Кинематограф"] },
	geography: { en: ["Rivers", "Mountains", "Islands"], ru: ["Реки", "Горы", "Острова"] },
	gardening: { en: ["Gardening", "Vegetables", "Horticulture"], ru: ["Садоводство", "Овощи", "Растениеводство"] },
};
const CAT = { en: "Category:", ru: "Категория:" };
const per = Math.ceil(TOTAL / Object.keys(TOPICS).length / 2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(lang, params) {
	const url = `https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({ format: "json", formatversion: "2", ...params });
	for (let attempt = 0; attempt < 5; attempt++) {
		const res = await fetch(url, { headers: { "User-Agent": UA } }).catch(() => null);
		if (res?.ok) return res.json();
		await sleep(2000 * (attempt + 1));
	}
	throw new Error(`API failed: ${url}`);
}

async function categoryPages(lang, cat, limit) {
	const titles = [];
	const queue = [CAT[lang] + cat];
	const seen = new Set();
	while (queue.length && titles.length < limit) {
		const c = queue.shift();
		if (seen.has(c)) continue;
		seen.add(c);
		let cont = {};
		do {
			const j = await api(lang, { action: "query", list: "categorymembers", cmtitle: c, cmlimit: "500", cmtype: "page|subcat", ...cont });
			for (const m of j.query?.categorymembers ?? []) {
				if (m.ns === 14) {
					if (seen.size < 40) queue.push(m.title);
				} else if (m.ns === 0) titles.push(m.title);
			}
			cont = j.continue ?? null;
		} while (cont && titles.length < limit * 2);
	}
	return titles;
}

async function extracts(lang, titles, intro) {
	const out = new Map();
	const step = intro ? 20 : 1;
	for (let i = 0; i < titles.length; i += step) {
		const j = await api(lang, { action: "query", prop: "extracts", ...(intro ? { exintro: "1" } : {}), explaintext: "1", exlimit: String(step), redirects: "1", titles: titles.slice(i, i + step).join("|") });
		for (const p of j.query?.pages ?? []) if (p.extract) out.set(p.title, p.extract);
	}
	return out;
}

function rng(seed) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const rand = rng(7);
const safe = (s) => s.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);

/** Wikipedia plain text: "== Section ==" → Markdown headings */
const toMarkdown = (text) =>
	text
		.replace(/^====\s*(.+?)\s*====$/gm, "#### $1")
		.replace(/^===\s*(.+?)\s*===$/gm, "### $1")
		.replace(/^==\s*(.+?)\s*==$/gm, "## $1")
		.replace(/\n{3,}/g, "\n\n");

const items = [];
const used = new Set();
for (const [topic, langs] of Object.entries(TOPICS)) {
	for (const lang of ["ru", "en"]) {
		const pool = [];
		for (const cat of langs[lang]) pool.push(...(await categoryPages(lang, cat, per)));
		const uniq = [...new Set(pool)].filter((t) => !used.has(t) && !/^(List of|Список)/.test(t));
		// ~4% long notes (full article), the rest intros
		const longCount = Math.max(2, Math.round(per * 0.04));
		const longTitles = uniq.slice(0, longCount);
		const full = await extracts(lang, longTitles, false);
		const intro = await extracts(lang, uniq.slice(longCount, longCount + per * 2), true);
		let n = 0;
		for (const [title, text] of [...full, ...intro]) {
			if (n >= per) break;
			if (used.has(title)) continue;
			const isLong = full.has(title);
			// keep some very short notes on purpose (little own text)
			if (text.length < 60 && rand() > 0.3) continue;
			used.add(title);
			items.push({ title, topic, lang, text: isLong ? toMarkdown(text).slice(0, 60000) : text, long: isLong });
			n++;
		}
		console.log(`${topic}/${lang}: ${n} (long ${[...full.keys()].filter((t) => used.has(t)).length})`);
	}
}

// deterministic shuffle, then cut to TOTAL
for (let i = items.length - 1; i > 0; i--) {
	const j = Math.floor(rand() * (i + 1));
	[items[i], items[j]] = [items[j], items[i]];
}
items.length = Math.min(items.length, TOTAL);

const PARTS = [
	["p1", 500],
	["p2", 2000],
	["p3", 5000],
	["p4", Infinity],
];
const partOf = (i) => PARTS.find(([, upTo]) => i < upTo)[0];

// file names (with deliberate duplicates in different folders)
const names = new Map();
items.forEach((it, i) => {
	it.part = partOf(i);
	it.folder = `${it.part}/${it.topic}`;
	it.name = safe(it.title);
});
// 1% of notes reuse the file name of another note of the same topic, in another part
const byTopic = new Map();
for (const it of items) byTopic.set(it.topic, [...(byTopic.get(it.topic) ?? []), it]);
let dupes = 0;
for (const list of byTopic.values()) {
	for (let k = 0; k + 1 < list.length && dupes < items.length / 100; k += 40) {
		const a = list[k];
		const b = list.find((x) => x.part !== a.part && x !== a);
		if (b) {
			b.name = a.name;
			dupes++;
		}
	}
}

const manifest = [];
for (const it of items) {
	let file = `${it.folder}/${it.name}.md`;
	while (names.has(file.toLowerCase())) file = `${it.folder}/${it.name} (2).md`;
	names.set(file.toLowerCase(), true);
	it.file = file;
}
for (const it of items) {
	const siblings = byTopic.get(it.topic);
	const lines = [];
	const tags = [];
	if (rand() < 0.4) tags.push(`topic/${it.topic}`);
	if (rand() < 0.15) tags.push("note");
	if (tags.length) lines.push("---", "tags:", ...tags.map((t) => `  - ${t}`), "---");
	lines.push(`# ${it.title}`, "", it.text.trim(), "");
	if (rand() < 0.3) {
		const other = siblings[Math.floor(rand() * siblings.length)];
		if (other !== it) lines.push(`См. также: [[${other.file.replace(/\.md$/, "")}|${other.name}]]`);
	}
	if (rand() < 0.04) {
		const all = items[Math.floor(rand() * items.length)];
		if (all !== it) lines.push(`Связано: [[${all.file.replace(/\.md$/, "")}|${all.name}]]`);
	}
	const target = path.join(OUT, it.file);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, lines.join("\n") + "\n");
	manifest.push({ file: it.file, topic: it.topic, lang: it.lang, long: it.long, part: it.part });
}
fs.writeFileSync(path.join(OUT, "bench-manifest.json"), JSON.stringify(manifest));
console.log(`total ${manifest.length} notes, ${manifest.filter((m) => m.long).length} long, ${dupes} duplicate names -> ${OUT}`);
