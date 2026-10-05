export interface VectorSearchResult {
	id: string;
	/** Cosine similarity, higher is closer. */
	score: number;
}

export interface VectorIndex {
	readonly kind: string;
	readonly size: number;

	initialize(dimensions: number): Promise<void>;
	add(id: string, vector: Float32Array): Promise<void>;
	update(id: string, vector: Float32Array): Promise<void>;
	remove(id: string): Promise<void>;
	has(id: string): boolean;
	search(vector: Float32Array, k: number): Promise<VectorSearchResult[]>;
	save(): Promise<void>;
	load(): Promise<boolean>;
	clear(): Promise<void>;
}
