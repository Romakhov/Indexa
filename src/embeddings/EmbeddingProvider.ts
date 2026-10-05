export interface EmbeddingProvider {
	initialize(): Promise<void>;
	embed(text: string): Promise<Float32Array>;
	embedBatch(texts: string[]): Promise<Float32Array[]>;
	dispose(): Promise<void>;
	readonly dimensions: number;
}

/** Cosine similarity for L2-normalized vectors (= dot product). */
export function cosine(a: Float32Array, b: Float32Array): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] * b[i];
	return s;
}
