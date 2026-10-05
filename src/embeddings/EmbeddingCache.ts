// Embedding cache (spec §28–29, §70–71, §78).
//
// Valid entry = same contentHash + same modelId/modelVersion. Stored in 16
// binary shards (by noteId) so a save rewrites only shards that changed, and
// vectors stay Float32 end to end.
//
// Shard file layout: [u32 headerBytes][header JSON, utf8][pad to 4][float32 data]

import type { BinaryStore } from "../storage/BinaryStore";

export interface CachedChunk {
	heading?: string;
	start: number;
	end: number;
	vector: Float32Array;
}

export interface CachedEmbedding {
	noteId: string;
	contentHash: string;
	modelId: string;
	modelVersion: string;
	documentVector: Float32Array;
	chunks?: CachedChunk[];
}

interface HeaderEntry {
	noteId: string;
	contentHash: string;
	modelId: string;
	modelVersion: string;
	/** offset in floats of the document vector; chunk vectors follow */
	offset: number;
	chunks?: { heading?: string; start: number; end: number }[];
}

interface ShardHeader {
	version: 1;
	dims: number;
	entries: HeaderEntry[];
}

const SHARDS = 16;

function shardOf(noteId: string): number {
	let h = 0;
	for (let i = 0; i < noteId.length; i++) h = (Math.imul(h, 31) + noteId.charCodeAt(i)) | 0;
	return (h >>> 0) % SHARDS;
}

export class EmbeddingCache {
	private entries = new Map<string, CachedEmbedding>();
	private dirtyShards = new Set<number>();
	private loaded = false;

	constructor(
		private readonly store: BinaryStore,
		private readonly modelId: string,
		private readonly modelVersion: string,
		private readonly dims: number,
		private readonly prefix = "embeddings",
	) {}

	get size() {
		return this.entries.size;
	}

	get isDirty() {
		return this.dirtyShards.size > 0;
	}

	/** Returns the entry only if it is still valid for this content and model. */
	get(noteId: string, contentHash: string): CachedEmbedding | undefined {
		const e = this.entries.get(noteId);
		if (!e || e.contentHash !== contentHash || e.modelId !== this.modelId || e.modelVersion !== this.modelVersion) return undefined;
		return e;
	}

	/** Entry regardless of content hash (still model-checked). */
	peek(noteId: string): CachedEmbedding | undefined {
		const e = this.entries.get(noteId);
		return e && e.modelId === this.modelId && e.modelVersion === this.modelVersion ? e : undefined;
	}

	set(entry: Omit<CachedEmbedding, "modelId" | "modelVersion">) {
		this.entries.set(entry.noteId, { ...entry, modelId: this.modelId, modelVersion: this.modelVersion });
		this.dirtyShards.add(shardOf(entry.noteId));
	}

	delete(noteId: string) {
		if (this.entries.delete(noteId)) this.dirtyShards.add(shardOf(noteId));
	}

	/** Drops entries whose note no longer exists. */
	retainOnly(noteIds: Iterable<string>) {
		const keep = new Set(noteIds);
		for (const id of [...this.entries.keys()]) if (!keep.has(id)) this.delete(id);
	}

	*values(): IterableIterator<CachedEmbedding> {
		yield* this.entries.values();
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		this.entries.clear();
		for (let s = 0; s < SHARDS; s++) {
			const buf = await this.store.read(`${this.prefix}-${s.toString(16)}.bin`);
			if (!buf) continue;
			try {
				this.readShard(buf);
			} catch (e) {
				// a corrupt shard only costs re-embedding its notes
				console.warn(`[indexa] embedding cache shard ${s} unreadable, ignoring`, e);
			}
		}
		this.loaded = true;
		this.dirtyShards.clear();
	}

	private readShard(buf: ArrayBuffer) {
		const headerBytes = new DataView(buf).getUint32(0, true);
		const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerBytes))) as ShardHeader;
		if (header.version !== 1 || header.dims !== this.dims) return; // other model/dims → invalid
		const dataStart = 4 + headerBytes + ((4 - ((4 + headerBytes) % 4)) % 4);
		const data = new Float32Array(buf, dataStart);
		const d = header.dims;
		for (const e of header.entries) {
			let off = e.offset;
			const documentVector = data.slice(off, off + d);
			off += d;
			const chunks = e.chunks?.map((c) => {
				const vector = data.slice(off, off + d);
				off += d;
				return { ...c, vector };
			});
			this.entries.set(e.noteId, { noteId: e.noteId, contentHash: e.contentHash, modelId: e.modelId, modelVersion: e.modelVersion, documentVector, chunks });
		}
	}

	async save(): Promise<void> {
		const dirty = [...this.dirtyShards];
		if (!dirty.length) return;
		const byShard = new Map<number, CachedEmbedding[]>();
		for (const e of this.entries.values()) {
			const s = shardOf(e.noteId);
			if (this.dirtyShards.has(s)) byShard.set(s, [...(byShard.get(s) ?? []), e]);
		}
		for (const s of dirty) {
			const list = byShard.get(s) ?? [];
			const name = `${this.prefix}-${s.toString(16)}.bin`;
			if (!list.length) {
				await this.store.remove(name);
				continue;
			}
			await this.store.write(name, this.encodeShard(list));
		}
		this.dirtyShards.clear();
	}

	private encodeShard(list: CachedEmbedding[]): Uint8Array {
		const d = this.dims;
		const floats = list.reduce((n, e) => n + d * (1 + (e.chunks?.length ?? 0)), 0);
		const data = new Float32Array(floats);
		let off = 0;
		const entries: HeaderEntry[] = list.map((e) => {
			const entry: HeaderEntry = {
				noteId: e.noteId,
				contentHash: e.contentHash,
				modelId: e.modelId,
				modelVersion: e.modelVersion,
				offset: off,
				chunks: e.chunks?.map(({ heading, start, end }) => ({ heading, start, end })),
			};
			data.set(e.documentVector, off);
			off += d;
			for (const c of e.chunks ?? []) {
				data.set(c.vector, off);
				off += d;
			}
			return entry;
		});
		const header = new TextEncoder().encode(JSON.stringify({ version: 1, dims: d, entries } satisfies ShardHeader));
		const pad = (4 - ((4 + header.length) % 4)) % 4;
		const out = new Uint8Array(4 + header.length + pad + data.byteLength);
		new DataView(out.buffer).setUint32(0, header.length, true);
		out.set(header, 4);
		out.set(new Uint8Array(data.buffer), 4 + header.length + pad);
		return out;
	}
}
