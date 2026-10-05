import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentHash } from "../src/core/hash";
import { KeyedDebouncer, ProcessingQueue } from "../src/core/ProcessingQueue";
import { chunkNote } from "../src/core/SemanticChunker";
import { EmbeddingCache } from "../src/embeddings/EmbeddingCache";
import type { BinaryStore } from "../src/storage/BinaryStore";

const para = (word: string, n: number) => Array.from({ length: n }, (_, i) => `${word} sentence number ${i} explains one more detail about ${word}.`).join(" ");

describe("SemanticChunker", () => {
	it("gives short notes no chunks", () => {
		expect(chunkNote({ title: "Short", content: "# Short\nJust a few words." })).toEqual([]);
	});

	it("splits along headings and adds document/section context", () => {
		const content = ["---", "tags: [x]", "---", "# Weekly Review", "## Planning", para("planning", 8), "## Kafka project", para("kafka", 8), "## Career", para("career", 8)].join("\n");
		const chunks = chunkNote({ title: "Weekly Review", content });
		expect(chunks.map((c) => c.heading)).toEqual(["Weekly Review › Planning", "Weekly Review › Kafka project", "Weekly Review › Career"]);
		expect(chunks[1].text.startsWith("Document: Weekly Review\nSection: Weekly Review › Kafka project\n\n")).toBe(true);
		expect(chunks[1].content).toContain("kafka sentence");
		expect(chunks[1].content).not.toContain("planning sentence");
		// offsets point into the original content
		expect(content.slice(chunks[1].start, chunks[1].end)).toContain("kafka sentence number 0");
	});

	it("splits an overlong section and merges tiny ones", () => {
		const content = ["## A", para("alpha", 60), "## B", "tiny", "## C", "small too", "## D", para("delta", 6)].join("\n");
		const chunks = chunkNote({ title: "T", content }, undefined, { maxChunkChars: 1500, minChunkChars: 300 });
		expect(chunks.filter((c) => c.heading === "A").length).toBeGreaterThan(1);
		expect(chunks.every((c) => c.content.length <= 1500)).toBe(true);
		// "tiny" and "small too" do not survive as their own chunks
		expect(chunks.some((c) => c.content === "tiny" || c.content === "small too")).toBe(false);
	});

	it("never treats a heading inside a code fence as a section", () => {
		const content = ["## Real", para("real", 30), "```md", "## Not a heading", "```", para("more", 30)].join("\n");
		expect(chunkNote({ title: "T", content }).some((c) => c.heading?.includes("Not a heading"))).toBe(false);
	});

	it("caps chunks per note", () => {
		const content = Array.from({ length: 60 }, (_, i) => `## S${i}\n${para("s" + i, 4)}`).join("\n");
		expect(chunkNote({ title: "Huge", content }, undefined, { maxChunksPerNote: 20 }).length).toBe(20);
	});
});

describe("contentHash", () => {
	it("is stable and sensitive to small changes", () => {
		expect(contentHash("abc")).toBe(contentHash("abc"));
		expect(contentHash("abc")).not.toBe(contentHash("abd"));
		expect(contentHash("")).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("KeyedDebouncer + ProcessingQueue", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("collapses a burst of modify events into one job", () => {
		const fired: string[] = [];
		const d = new KeyedDebouncer<string>(3000, (k) => fired.push(k));
		for (let i = 0; i < 4; i++) {
			d.trigger("note.md");
			vi.advanceTimersByTime(1000);
		}
		expect(fired).toEqual([]);
		vi.advanceTimersByTime(3000);
		expect(fired).toEqual(["note.md"]);
	});

	it("respects concurrency and lets the latest job for a key win", async () => {
		vi.useRealTimers();
		let active = 0;
		let maxActive = 0;
		const seen: string[] = [];
		const q = new ProcessingQueue<string, string>(async (k, job) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((r) => setTimeout(r, 5));
			seen.push(`${k}:${job}`);
			active--;
		}, 2);
		q.enqueue("a", "v1");
		q.enqueue("b", "v1");
		q.enqueue("c", "v1");
		q.enqueue("c", "v2"); // replaces the waiting c:v1
		await q.onIdle();
		expect(maxActive).toBe(2);
		expect(seen.sort()).toEqual(["a:v1", "b:v1", "c:v2"]);
		expect(q.getStats()).toMatchObject({ queued: 0, running: 0, done: 3 });
	});

	it("isolates failures", async () => {
		vi.useRealTimers();
		const errors: string[] = [];
		const q = new ProcessingQueue<string, number>(
			async (k) => {
				if (k === "bad") throw new Error("boom");
			},
			1,
			(k) => errors.push(k),
		);
		q.enqueue("bad", 1);
		q.enqueue("good", 1);
		await q.onIdle();
		expect(errors).toEqual(["bad"]);
		expect(q.getStats()).toMatchObject({ done: 1, failed: 1 });
	});
});

class MemoryStore implements BinaryStore {
	files = new Map<string, ArrayBuffer>();
	writes = 0;
	async read(name: string) {
		const b = this.files.get(name);
		return b ? b.slice(0) : null;
	}
	async write(name: string, data: ArrayBuffer | Uint8Array) {
		this.writes++;
		this.files.set(name, data instanceof Uint8Array ? data.slice().buffer : data.slice(0));
	}
	async remove(name: string) {
		this.files.delete(name);
	}
}

const vec = (seed: number, d = 4) => Float32Array.from({ length: d }, (_, i) => seed + i / 10);

describe("EmbeddingCache", () => {
	it("round-trips document and chunk vectors through shards", async () => {
		const store = new MemoryStore();
		const c = new EmbeddingCache(store, "m", "v1", 4);
		c.set({ noteId: "n1", contentHash: "h1", documentVector: vec(1) });
		c.set({ noteId: "n2", contentHash: "h2", documentVector: vec(2), chunks: [{ heading: "A", start: 0, end: 10, vector: vec(3) }] });
		await c.save();

		const c2 = new EmbeddingCache(store, "m", "v1", 4);
		await c2.load();
		expect(c2.size).toBe(2);
		expect([...c2.get("n2", "h2")!.chunks![0].vector]).toEqual([...vec(3)]);
		expect(c2.get("n2", "h2")!.chunks![0].heading).toBe("A");
		expect([...c2.get("n1", "h1")!.documentVector]).toEqual([...vec(1)]);
	});

	it("invalidates on content change and on model change", async () => {
		const store = new MemoryStore();
		const c = new EmbeddingCache(store, "m", "v1", 4);
		c.set({ noteId: "n1", contentHash: "h1", documentVector: vec(1) });
		await c.save();
		expect(c.get("n1", "other")).toBeUndefined();
		const newer = new EmbeddingCache(store, "m", "v2", 4);
		await newer.load();
		expect(newer.get("n1", "h1")).toBeUndefined();
		const otherDims = new EmbeddingCache(store, "m", "v1", 8);
		await otherDims.load();
		expect(otherDims.size).toBe(0);
	});

	it("rewrites only dirty shards and drops deleted notes", async () => {
		const store = new MemoryStore();
		const c = new EmbeddingCache(store, "m", "v1", 4);
		for (let i = 0; i < 64; i++) c.set({ noteId: `note-${i}`, contentHash: "h", documentVector: vec(i) });
		await c.save();
		const full = store.writes;
		c.set({ noteId: "note-5", contentHash: "h2", documentVector: vec(99) });
		await c.save();
		expect(store.writes - full).toBe(1);
		c.retainOnly(["note-1"]);
		await c.save();
		const c2 = new EmbeddingCache(store, "m", "v1", 4);
		await c2.load();
		expect(c2.size).toBe(1);
	});
});
