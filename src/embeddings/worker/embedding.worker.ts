/// <reference lib="webworker" />
// Embedding worker. The only module that knows the transformers.js / ONNX API.
//
// Network policy: this worker never touches the network. Model files arrive
// from the main thread as ArrayBuffers, the ONNX wasm binary is embedded in the
// bundle, and every fetch / importScripts / XHR is blocked and reported.

import type { WorkerRequest, WorkerResponse } from "./protocol";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// Obsidian enables Node integration even inside Web Workers. transformers.js
// and the emscripten glue of onnxruntime-web would then pick their Node code
// paths (native onnxruntime-node, fs-based wasm loading). This worker needs
// none of Node, so hide it before any library is evaluated.
for (const name of ["process", "require", "module", "global", "Buffer"]) {
	try {
		Object.defineProperty(ctx, name, { value: undefined, configurable: true, writable: true });
	} catch {
		/* non-configurable: leave as is, checked in init() */
	}
}
const post = (msg: WorkerResponse, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);

const LOCAL_ROOT = "/models/";
let modelFiles = new Map<string, ArrayBuffer>();
let modelRoot = "";

function blocked(url: string): never {
	post({ type: "blocked", url });
	throw new Error(`Network access is disabled in the embedding worker: ${url}`);
}

const guardedFetch = async (input: RequestInfo | URL): Promise<Response> => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	const path = url.startsWith(LOCAL_ROOT) ? url : new URL(url, "http://local").pathname;
	if (url.startsWith(LOCAL_ROOT) && path.startsWith(modelRoot)) {
		const name = path.slice(modelRoot.length);
		const buf = modelFiles.get(name);
		if (buf) {
			// config/tokenizer files may be read more than once; the large ONNX
			// weights are read once, so hand them over without a copy
			if (!name.endsWith(".onnx")) return new Response(buf.slice(0), { status: 200 });
			modelFiles.delete(name);
			return new Response(buf, { status: 200 });
		}
		post({ type: "log", message: `model file not provided: ${path}` });
		return new Response(null, { status: 404, statusText: "Not Found" });
	}
	return blocked(url);
};

// Install the guard before transformers.js / ORT are evaluated.
Object.assign(ctx, {
	fetch: guardedFetch,
	importScripts: (...urls: string[]) => blocked(urls.join(", ")),
	XMLHttpRequest: class {
		open(_m: string, url: string) {
			blocked(url);
		}
	},
});

// transformers.js is loaded lazily in init(), i.e. strictly after the guard
// above is installed.

type Extractor = (texts: string[], opts: Record<string, unknown>) => Promise<{ data: Float32Array; dims: number[] }>;
let extractor: (Extractor & { dispose?: () => Promise<void> }) | null = null;
let dimensions = 0;

async function init(modelId: string, dtype: string, files: Record<string, ArrayBuffer>, device: "wasm" | "webgpu", wasmBinary: ArrayBuffer) {
	const t0 = performance.now();
	modelFiles = new Map(Object.entries(files));
	modelRoot = `${LOCAL_ROOT}${modelId}/`;

	if ((ctx as unknown as Record<string, unknown>).process !== undefined) throw new Error("Node globals could not be hidden in the worker");
	const { env, pipeline } = await import("@huggingface/transformers");
	env.allowRemoteModels = false;
	env.allowLocalModels = true;
	env.localModelPath = LOCAL_ROOT;
	env.useBrowserCache = false;
	env.useFSCache = false;
	env.useWasmCache = false;
	env.useFS = false;
	env.fetch = guardedFetch;

	// transformers.js shallow-copies the ORT env into env.backends.onnx and the
	// `wasm` section is lost, so configure ORT's own env. The build aliases
	// transformers' "onnxruntime-web/webgpu" import to this same module.
	const ort = await import("indexa-ort");
	ort.env.wasm.wasmBinary = wasmBinary;
	ort.env.wasm.wasmPaths = undefined; // drop transformers' CDN default; glue is inlined in the bundle
	ort.env.wasm.numThreads = 1; // Obsidian is not cross-origin isolated: no SharedArrayBuffer
	ort.env.wasm.proxy = false;

	// transformers' overloads for pipeline() are too wide to infer here; this is the shape we use
	const createPipeline = pipeline as unknown as (task: "feature-extraction", model: string, opts: { device: string; dtype: string }) => Promise<NonNullable<typeof extractor>>;
	extractor = await createPipeline("feature-extraction", modelId, { device, dtype });
	modelFiles.clear(); // the session holds its own copy now
	const probe = await extractor(["probe"], { pooling: "mean", normalize: true });
	dimensions = probe.dims[probe.dims.length - 1];
	return { loadMs: performance.now() - t0, backend: device === "webgpu" ? "webgpu" : "wasm-cpu" };
}

async function embed(texts: string[]): Promise<Float32Array[]> {
	if (!extractor) throw new Error("Model is not initialized");
	const out = await extractor(texts, { pooling: "mean", normalize: true });
	const result: Float32Array[] = [];
	for (let i = 0; i < texts.length; i++) {
		result.push(out.data.slice(i * dimensions, (i + 1) * dimensions));
	}
	return result;
}

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
	const req = ev.data;
	try {
		if (req.type === "init") {
			const { loadMs, backend } = await init(req.modelId, req.dtype, req.files, req.device, req.ortWasm);
			post({ type: "init", id: req.id, dimensions, loadMs, backend });
		} else if (req.type === "embed") {
			const t0 = performance.now();
			const vectors = await embed(req.texts);
			post({ type: "embed", id: req.id, vectors, ms: performance.now() - t0 }, vectors.map((v) => v.buffer));
		} else if (req.type === "dispose") {
			await extractor?.dispose?.();
			extractor = null;
			modelFiles.clear();
			post({ type: "dispose", id: req.id });
		}
	} catch (e) {
		post({ type: "error", id: req.id, message: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) });
	}
};
