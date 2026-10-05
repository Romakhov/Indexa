// Acceptance check for spec §92: a long mixed note must expose several topics
// through its chunk vectors, even where the document vector favours one.

import { chunkNote } from "../core/SemanticChunker";
import { cosine, type EmbeddingProvider } from "../embeddings/EmbeddingProvider";
import { combineDocumentVector } from "../embeddings/NoteEmbedder";

const WEEKLY_REVIEW = `# Weekly Review

## Planning
На этой неделе пересобрал систему планирования. В воскресенье выписываю три главных результата недели, раскладываю задачи по дням и оставляю буфер в 20% времени на непредвиденное. Ежедневно утром сверяюсь со списком приоритетов, вечером переношу незавершённое. Попробовал тайм-блоки для глубокой работы по утрам — помогает не распыляться. На следующую неделю: ограничить количество встреч и заранее заблокировать время на обзор целей квартала. Планирование по методу 12 недель держит фокус лучше, чем годовые цели.

## Kafka project
Разбирался с consumer groups в Kafka: каждая партиция читается ровно одним консьюмером группы, ребалансировка запускается при добавлении инстанса. Настроили retention на 7 дней и включили idempotent producer, чтобы получить exactly-once семантику вместе с транзакциями. Нашли проблему с отставанием консьюмеров (consumer lag) — увеличили число партиций с 6 до 12 и подняли max.poll.records. Следующий шаг — перейти на Kafka Streams для агрегации событий и настроить мониторинг лагов в Grafana.

## Career
Поговорил с руководителем о карьерном росте: обсудили переход на позицию тимлида через полгода. Нужно прокачать навыки управления людьми — делегирование, one-on-one встречи, обратная связь. Составил план развития: курс по менеджменту, менторство двух джунов, участие в найме. Также обновил резюме и профиль, чтобы понимать свою рыночную стоимость. Цель на год — повышение и рост дохода на 30%.
`;

const TOPICS: Record<string, string> = {
	Planning: "Планирование недели, приоритеты задач, тайм-менеджмент и цели",
	Programming: "Программирование, разработка backend-систем, Kafka, базы данных и распределённые системы",
	Career: "Карьерный рост, профессиональное развитие, повышение и переговоры с руководителем",
	Cooking: "Кулинария, рецепты и приготовление еды",
};

export async function longNoteCheck(provider: EmbeddingProvider) {
	const chunks = chunkNote({ title: "Weekly Review", content: WEEKLY_REVIEW }, undefined, { minNoteChars: 600, minChunkChars: 200 });
	const [head, ...rest] = await provider.embedBatch(["Weekly Review\nPlanning; Kafka project; Career", ...chunks.map((c) => c.text)]);
	const topicNames = Object.keys(TOPICS);
	const topicVecs = await provider.embedBatch(Object.values(TOPICS));
	const doc = combineDocumentVector(head, rest, 0.5);

	const rank = (v: Float32Array) =>
		topicNames.map((t, i) => ({ topic: t, score: +cosine(v, topicVecs[i]).toFixed(4) })).sort((a, b) => b.score - a.score);
	const chunkTop = chunks.map((c, i) => ({ heading: c.heading, best: rank(rest[i])[0] }));
	const expected: Record<string, string> = { Planning: "Planning", "Kafka project": "Programming", Career: "Career" };
	const correct = chunkTop.filter((c) => c.heading && expected[c.heading.split(" › ").pop()!] === c.best.topic).length;

	// "best chunk score" per topic (spec §43): max over chunks
	const bestChunkScore = Object.fromEntries(topicNames.map((t, i) => [t, +Math.max(...rest.map((v) => cosine(v, topicVecs[i]))).toFixed(4)]));
	const covered = new Set(chunkTop.map((c) => c.best.topic));
	return {
		passed: chunks.length === 3 && correct === 3 && !covered.has("Cooking"),
		chunks: chunks.length,
		chunkTop,
		documentRanking: rank(doc),
		bestChunkScore,
	};
}
