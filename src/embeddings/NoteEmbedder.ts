// Turns processed notes into cached document + chunk embeddings (spec §21–29).
// Cache first; only new/changed notes reach the model. Work is flattened
// into length-sorted batches (less padding) with several batches in flight.

import { contentHash } from "../core/hash";
import type { Chunk } from "../core/SemanticChunker";
import type { ProcessedNote } from "../types/NoteDocument";
import type { CachedEmbedding, EmbeddingCache } from "./EmbeddingCache";
import type { EmbeddingProvider } from "./EmbeddingProvider";

/** Bump when text preparation changes in a way that should invalidate the cache. */
export const PIPELINE_VERSION = "p2.2";

export interface NoteToEmbed {
	processed: ProcessedNote;
	chunks: Chunk[];
}

export interface EmbedProgress {
	done: number;
	total: number;
	fromCache: number;
}

export interface EmbedOptions {
	batchSize: number;
	/** batches in flight; match the worker pool size */
	parallel: number;
	/** weight of the head text (title, headings, beginning) vs the chunk mean for long notes */
	headWeight: number;
	signal?: AbortSignal;
	onProgress?: (p: EmbedProgress) => void;
	/** called every `checkpointEvery` embedded notes, e.g. to persist the cache */
	onCheckpoint?: () => Promise<void>;
	checkpointEvery: number;
	/**
	 * Notes are embedded window by window: texts are length-sorted inside a
	 * window (less padding) while notes still finish steadily, so a cancelled
	 * run keeps most of its work in the cache (spec §67).
	 */
	windowNotes: number;
}

const DEFAULTS: EmbedOptions = { batchSize: 8, parallel: 1, headWeight: 0.5, checkpointEvery: 200, windowNotes: 64 };

/** Short notes: the full processed text. Chunked notes: header only (body is in the chunks). */
export function headOf(n: NoteToEmbed): string {
	return n.chunks.length ? n.processed.headerText : n.processed.text;
}

export function noteHash(n: NoteToEmbed): string {
	return contentHash([PIPELINE_VERSION, headOf(n), ...n.chunks.map((c) => c.text)].join("\u0001"));
}

function normalize(v: Float32Array): Float32Array {
	let s = 0;
	for (const x of v) s += x * x;
	const n = Math.sqrt(s) || 1;
	for (let i = 0; i < v.length; i++) v[i] /= n;
	return v;
}

/** Long notes: blend the head vector with the mean of chunk vectors. */
export function combineDocumentVector(head: Float32Array, chunks: Float32Array[], headWeight: number): Float32Array {
	if (!chunks.length) return head;
	const out = new Float32Array(head.length);
	for (const c of chunks) for (let i = 0; i < c.length; i++) out[i] += c[i] / chunks.length;
	normalize(out);
	for (let i = 0; i < out.length; i++) out[i] = headWeight * head[i] + (1 - headWeight) * out[i];
	return normalize(out);
}

interface Job {
	note: number;
	/** -1 = head text, otherwise chunk index */
	part: number;
	text: string;
}

export class EmbeddingCancelled extends Error {
	constructor() {
		super("Embedding cancelled");
	}
}

export async function embedNotes(
	notes: NoteToEmbed[],
	provider: EmbeddingProvider,
	cache: EmbeddingCache,
	options: Partial<EmbedOptions> = {},
): Promise<{ embedded: number; fromCache: number }> {
	const o = { ...DEFAULTS, ...options };
	const hashes = notes.map(noteHash);
	const pending: number[] = [];
	let fromCache = 0;
	notes.forEach((n, i) => (cache.get(n.processed.noteId, hashes[i]) ? fromCache++ : pending.push(i)));

	const total = notes.length;
	let done = fromCache;
	o.onProgress?.({ done, total, fromCache });

	const remaining = new Map(pending.map((i) => [i, 1 + notes[i].chunks.length]));
	const heads = new Map<number, Float32Array>();
	const chunkVecs = new Map<number, Float32Array[]>();
	let sinceCheckpoint = 0;
	let embedded = 0;

	const complete = async (i: number) => {
		const n = notes[i];
		const cv = chunkVecs.get(i) ?? [];
		const entry: Omit<CachedEmbedding, "modelId" | "modelVersion"> = {
			noteId: n.processed.noteId,
			contentHash: hashes[i],
			documentVector: combineDocumentVector(heads.get(i)!, cv, o.headWeight),
			chunks: n.chunks.length ? n.chunks.map((c, k) => ({ heading: c.heading, start: c.start, end: c.end, vector: cv[k] })) : undefined,
		};
		cache.set(entry);
		heads.delete(i);
		chunkVecs.delete(i);
		embedded++;
		o.onProgress?.({ done: ++done, total, fromCache });
		if (o.onCheckpoint && ++sinceCheckpoint >= o.checkpointEvery) {
			sinceCheckpoint = 0;
			await o.onCheckpoint();
		}
	};

	let jobs: Job[] = [];
	let next = 0;
	const runLane = async () => {
		while (next < jobs.length) {
			if (o.signal?.aborted) throw new EmbeddingCancelled();
			const batch = jobs.slice(next, next + o.batchSize);
			next += batch.length;
			const vectors = await provider.embedBatch(batch.map((j) => j.text));
			for (let k = 0; k < batch.length; k++) {
				const { note, part } = batch[k];
				if (part < 0) heads.set(note, vectors[k]);
				else {
					const arr = chunkVecs.get(note) ?? new Array<Float32Array>(notes[note].chunks.length);
					arr[part] = vectors[k];
					chunkVecs.set(note, arr);
				}
				const left = remaining.get(note)! - 1;
				remaining.set(note, left);
				if (left === 0) await complete(note);
			}
		}
	};

	for (let w = 0; w < pending.length; w += o.windowNotes) {
		jobs = pending.slice(w, w + o.windowNotes).flatMap((note) => [
			{ note, part: -1, text: headOf(notes[note]) },
			...notes[note].chunks.map((c, part) => ({ note, part, text: c.text })),
		]);
		jobs.sort((a, b) => a.text.length - b.text.length);
		next = 0;
		await Promise.all(Array.from({ length: Math.max(1, o.parallel) }, runLane));
	}
	return { embedded, fromCache };
}
