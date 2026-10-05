// Dev-only: builds a labelled benchmark corpus from Wikipedia (CC BY-SA) into
// dev-vault/corpus/. Eight known topics (spec §74), Russian + English mixed.
// The corpus is generated, not committed. Labels live in corpus/manifest.json,
// never in the notes, so the pipeline cannot see them.
//
//   node scripts/make-corpus.mjs [perTopicPerLang=125]

import fs from "node:fs";
import path from "node:path";

const PER = Number(process.argv[2] ?? 125);
const OUT = "dev-vault/corpus";
const UA = "IndexaCorpusBuilder/0.1 (dev benchmark; kdromahov@gmail.com)";

const TOPICS = {
	programming: { en: ["Software engineering", "Programming languages", "Software design patterns"], ru: ["Программирование", "Языки программирования", "Шаблоны проектирования"] },
	planning: { en: ["Time management", "Project management", "Productivity"], ru: ["Тайм-менеджмент", "Управление проектами", "Планирование"] },
	ai: { en: ["Machine learning", "Artificial neural networks", "Natural language processing"], ru: ["Машинное обучение", "Искусственные нейронные сети", "Обработка естественного языка"] },
	astrophysics: { en: ["Astrophysics", "Black holes", "Stellar astronomy"], ru: ["Астрофизика", "Чёрные дыры", "Звёздная астрономия"] },
	cooking: { en: ["Cooking techniques", "Baking", "Sauces"], ru: ["Кулинария", "Технология приготовления пищи", "Соусы"] },
	ceramics: { en: ["Pottery", "Ceramic glazes", "Ceramic materials"], ru: ["Керамика", "Гончарное ремесло", "Фарфор"] },
	travel: { en: ["Types of tourism", "Tourism", "Hiking"], ru: ["Туризм", "Виды туризма", "Пеший туризм"] },
	finance: { en: ["Investment", "Banking", "Personal finance"], ru: ["Инвестиции", "Банковское дело", "Личные финансы"] },
};
const CAT = { en: "Category:", ru: "Категория:" };

async function api(lang, params) {
	const url = `https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({ format: "json", formatversion: "2", ...params });
	for (let attempt = 0; attempt < 4; attempt++) {
		const res = await fetch(url, { headers: { "User-Agent": UA } });
		if (res.ok) return res.json();
		await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
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
					if (seen.size < 15) queue.push(m.title);
				} else if (m.ns === 0) titles.push(m.title);
			}
			cont = j.continue ?? null;
		} while (cont && titles.length < limit * 2);
	}
	return titles;
}

async function intros(lang, titles) {
	const out = new Map();
	for (let i = 0; i < titles.length; i += 20) {
		const j = await api(lang, { action: "query", prop: "extracts", exintro: "1", explaintext: "1", exlimit: "20", redirects: "1", titles: titles.slice(i, i + 20).join("|") });
		for (const p of j.query?.pages ?? []) if (p.extract) out.set(p.title, p.extract);
	}
	return out;
}

// deterministic shuffle (mulberry32)
function rng(seed) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const safe = (s) => s.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);

fs.mkdirSync(OUT, { recursive: true });
const items = [];
const usedTitles = new Set();
for (const [topic, langs] of Object.entries(TOPICS)) {
	for (const lang of ["en", "ru"]) {
		const pool = [];
		for (const cat of langs[lang]) pool.push(...(await categoryPages(lang, cat, PER)));
		const uniq = [...new Set(pool)].filter((t) => !usedTitles.has(t) && !/^(List of|Список)/.test(t));
		const texts = await intros(lang, uniq.slice(0, PER * 2));
		let n = 0;
		for (const [title, text] of texts) {
			if (n >= PER) break;
			if (text.length < 200 || usedTitles.has(title)) continue;
			usedTitles.add(title);
			items.push({ title, topic, lang, text });
			n++;
		}
		console.log(`${topic}/${lang}: ${n}`);
	}
}

const rand = rng(42);
for (let i = items.length - 1; i > 0; i--) {
	const j = Math.floor(rand() * (i + 1));
	[items[i], items[j]] = [items[j], items[i]];
}

const manifest = [];
const names = new Set();
for (const it of items) {
	let name = safe(it.title);
	while (names.has(name.toLowerCase())) name += " (2)";
	names.add(name.toLowerCase());
	const file = `${name}.md`;
	fs.writeFileSync(path.join(OUT, file), `# ${it.title}\n\n${it.text}\n`);
	manifest.push({ file, topic: it.topic, lang: it.lang });
}
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));
console.log(`total ${manifest.length} notes -> ${OUT}`);
