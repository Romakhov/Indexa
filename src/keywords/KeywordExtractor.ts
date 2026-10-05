// Statistical keyword extraction (spec §49): tokenise, crude stemming, TF-IDF.
// No generative model. Pure: no Obsidian imports.

const STOPWORDS = new Set(
	(
		// ru
		"это этот эта эти того тому также такой такие такая когда чтобы потому если тоже только можно нужно надо очень более менее после перед через между которые который которая которое которых были было быть будет будут есть себя свой свои своих своей всех всего весь вся может могут ваш наш мной меня тебя него неё нему ними чего чему кого кому сейчас здесь потом даже теперь просто всегда никогда где куда откуда почему зачем один одна одно два три для или как что так все уже еще ещё при без над под про его ее её они она оно мы вы ты них нас вас вам нам кто чем там тут вот этом этой этих тем том той всё весь сам сама сами самый либо ли бы же ни не да нет раз два также однако поэтому почти лишь иметь имеет является являются например вообще своё свою свое моя мой мои мою мне " +
		// en
		"that this with from have will what when your they them their there then than into about which would could should these those also just like more most some such only other being been were where while after before because does make many much very each over the and for are but not you all any can had her was one our out has him his how its may new now old see two way who did get got let put say she too use via per yet"
	).split(/\s+/),
);

const WORD = /\p{L}[\p{L}\d-]{2,}/gu;

export function tokenize(text: string): string[] {
	return (text.toLowerCase().replace(/ё/g, "е").match(WORD) ?? []).filter((t) => !STOPWORDS.has(t) && !/^\d/.test(t));
}

/** Crude prefix stemming: collapses most Russian inflections ("планирование", "планировании"). */
export const stem = (token: string) => (token.length > 6 ? token.slice(0, 6) : token);

export interface KeywordDoc {
	id: string;
	text: string;
}

export class KeywordExtractor {
	private tf = new Map<string, Map<string, number>>();
	private df = new Map<string, number>();
	private surface = new Map<string, Map<string, number>>();
	private readonly docCount: number;

	constructor(docs: KeywordDoc[]) {
		this.docCount = docs.length;
		for (const d of docs) {
			const counts = new Map<string, number>();
			for (const t of tokenize(d.text)) {
				const s = stem(t);
				counts.set(s, (counts.get(s) ?? 0) + 1);
				const sf = this.surface.get(s) ?? new Map<string, number>();
				sf.set(t, (sf.get(t) ?? 0) + 1);
				this.surface.set(s, sf);
			}
			this.tf.set(d.id, counts);
			for (const s of counts.keys()) this.df.set(s, (this.df.get(s) ?? 0) + 1);
		}
	}

	private idf(s: string) {
		return Math.log((1 + this.docCount) / (1 + (this.df.get(s) ?? 0))) + 1;
	}

	/** Top stems of one note by TF-IDF; terms present in one note only are skipped (no shared meaning). */
	noteKeywords(id: string, n = 10): string[] {
		const counts = this.tf.get(id);
		if (!counts) return [];
		const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
		return [...counts]
			.filter(([s]) => (this.df.get(s) ?? 0) >= 2 && (this.df.get(s) ?? 0) < this.docCount * 0.5)
			.map(([s, c]) => [s, (c / total) * this.idf(s)] as const)
			.sort((a, b) => b[1] - a[1])
			.slice(0, n)
			.map(([s]) => s);
	}

	/** c-TF-IDF over a group of notes (a cluster); returns readable surface forms. */
	groupKeywords(ids: string[], n = 8): string[] {
		const counts = new Map<string, number>();
		const docsWith = new Map<string, number>();
		for (const id of ids) {
			for (const [s, c] of this.tf.get(id) ?? []) {
				counts.set(s, (counts.get(s) ?? 0) + c);
				docsWith.set(s, (docsWith.get(s) ?? 0) + 1);
			}
		}
		const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
		const minDocs = ids.length >= 4 ? 2 : 1;
		return [...counts]
			.filter(([s]) => (docsWith.get(s) ?? 0) >= minDocs)
			.map(([s, c]) => [s, (c / total) * this.idf(s)] as const)
			.sort((a, b) => b[1] - a[1])
			.slice(0, n)
			.map(([s]) => this.readable(s));
	}

	readable(s: string): string {
		const sf = this.surface.get(s);
		return sf ? [...sf].sort((a, b) => b[1] - a[1])[0][0] : s;
	}
}
