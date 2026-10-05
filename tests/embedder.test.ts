import { describe, expect, it } from "vitest";
import { EmbeddingCache } from "../src/embeddings/EmbeddingCache";
import type { EmbeddingProvider } from "../src/embeddings/EmbeddingProvider";
import { combineDocumentVector, EmbeddingCancelled, embedNotes, type NoteToEmbed } from "../src/embeddings/NoteEmbedder";
import type { BinaryStore } from "../src/storage/BinaryStore";

const D = 4;
class FakeProvider implements EmbeddingProvider {
	dimensions = D;
	calls = 0;
	texts = 0;
	async initialize() {}
	async dispose() {}
	async embed(t: string) {
		return (await this.embedBatch([t]))[0];
	}
	async embedBatch(texts: string[]) {
		this.calls++;
		this.texts += texts.length;
		await new Promise((r) => setTimeout(r, 1));
		return texts.map((t) => {
			const v = Float32Array.from({ length: D }, (_, i) => ((t.length + i) % 7) + 1);
			const n = Math.hypot(...v);
			return v.map((x) => x / n);
		});
	}
}

const store = (): BinaryStore => {
	const m = new Map<string, ArrayBuffer>();
	return {
		read: async (k) => m.get(k) ?? null,
		write: async (k, d) => void m.set(k, d instanceof Uint8Array ? d.slice().buffer : d),
		remove: async (k) => void m.delete(k),
	};
};

const note = (id: string, text: string, chunks = 0): NoteToEmbed => ({
	processed: { noteId: id, text, headerText: text.split(" ")[0], semanticChars: text.length, lowContent: false },
	chunks: Array.from({ length: chunks }, (_, i) => ({ heading: `H${i}`, start: i, end: i + 1, content: `c${i}`, text: `${text} chunk ${i}` })),
});

describe("embedNotes", () => {
	it("embeds head + chunks, then serves everything from cache", async () => {
		const cache = new EmbeddingCache(store(), "m", "v", D);
		const p = new FakeProvider();
		const notes = [note("a", "alpha"), note("b", "beta text", 3)];
		expect(await embedNotes(notes, p, cache, { parallel: 2 })).toEqual({ embedded: 2, fromCache: 0 });
		expect(p.texts).toBe(1 + 4);
		const b = [...cache.values()].find((e) => e.noteId === "b")!;
		expect(b.chunks?.map((c) => c.heading)).toEqual(["H0", "H1", "H2"]);
		expect(Math.hypot(...b.documentVector)).toBeCloseTo(1, 5);

		const again = new FakeProvider();
		expect(await embedNotes(notes, again, cache)).toEqual({ embedded: 0, fromCache: 2 });
		expect(again.calls).toBe(0);

		// only the changed note is recomputed
		notes[0] = note("a", "alpha changed");
		expect(await embedNotes(notes, again, cache)).toEqual({ embedded: 1, fromCache: 1 });
	});

	it("keeps finished notes in the cache when cancelled", async () => {
		const cache = new EmbeddingCache(store(), "m", "v", D);
		const controller = new AbortController();
		const notes = Array.from({ length: 200 }, (_, i) => note(`n${i}`, `note ${i}`));
		let seen = 0;
		await expect(
			embedNotes(notes, new FakeProvider(), cache, {
				windowNotes: 16,
				signal: controller.signal,
				onProgress: (p) => {
					seen = p.done;
					if (p.done >= 40) controller.abort();
				},
			}),
		).rejects.toBeInstanceOf(EmbeddingCancelled);
		expect(cache.size).toBeGreaterThanOrEqual(40);
		expect(cache.size).toBe(seen);
		expect(cache.size).toBeLessThan(200);
	});
});

describe("combineDocumentVector", () => {
	it("returns the head for short notes and a unit blend otherwise", () => {
		const head = Float32Array.from([1, 0, 0, 0]);
		expect(combineDocumentVector(head, [], 0.5)).toBe(head);
		const v = combineDocumentVector(head, [Float32Array.from([0, 1, 0, 0])], 0.5);
		expect(Math.hypot(...v)).toBeCloseTo(1, 5);
		expect(v[0]).toBeCloseTo(v[1], 5);
	});
});
