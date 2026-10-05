// Messages exchanged between the plugin (main thread) and the embedding worker.

export interface InitRequest {
	type: "init";
	id: number;
	modelId: string;
	dtype: string;
	device: "wasm" | "webgpu";
	/** Model files keyed by path relative to the model root, e.g. "onnx/model_quantized.onnx". */
	files: Record<string, ArrayBuffer>;
	/** ONNX Runtime WASM binary (decompressed on the main thread, see ortWasm.ts) */
	ortWasm: ArrayBuffer;
}

export interface EmbedRequest {
	type: "embed";
	id: number;
	texts: string[];
}

export interface DisposeRequest {
	type: "dispose";
	id: number;
}

export type WorkerRequest = InitRequest | EmbedRequest | DisposeRequest;

export type WorkerResponse =
	| { type: "init"; id: number; dimensions: number; loadMs: number; backend: string }
	| { type: "embed"; id: number; vectors: Float32Array[]; ms: number }
	| { type: "dispose"; id: number }
	| { type: "error"; id: number; message: string }
	/** Any network access attempt from inside the worker. Always blocked. */
	| { type: "blocked"; url: string }
	| { type: "log"; message: string };
