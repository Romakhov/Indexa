import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const prod = process.argv.includes("--production");
const outDir = process.env.PLUGIN_OUT_DIR ?? ".";
// Phase 0 spike commands are compiled in only for dev-vault builds.
const spike = process.argv.includes("--spike") || process.env.INDEXA_SPIKE === "1";
// ORT flavour: "wasm" (CPU only, 14 MB binary) or "webgpu" (CPU + WebGPU, 27 MB binary)
const ort = process.argv.includes("--webgpu") || process.env.INDEXA_ORT === "webgpu" ? "webgpu" : "wasm";
const ORT = {
	wasm: { module: "onnxruntime-web/wasm", binary: "./node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm" },
	webgpu: { module: "onnxruntime-web/webgpu", binary: "./node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm" },
}[ort];

// The ONNX Runtime .wasm binary, unmodified, brotli-compressed to keep main.js
// under Obsidian Sync's 5 MB file limit (see src/embeddings/ortWasm.ts). The
// encoder settings are fixed so the build stays byte-for-byte reproducible.
const ortWasm = fs.readFileSync(ORT.binary);
const ortWasmBr = zlib.brotliCompressSync(ortWasm, {
	params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: ortWasm.length },
});
const ortWasmPlugin = {
	name: "indexa-ort-wasm-br",
	setup(build) {
		build.onResolve({ filter: /^indexa-ort-wasm-br$/ }, () => ({ path: "ort-wasm.br", namespace: "indexa-ort-wasm-br" }));
		build.onLoad({ filter: /.*/, namespace: "indexa-ort-wasm-br" }, () => ({ contents: ortWasmBr, loader: "binary" }));
	},
};

// Step 1: the ML worker. Runs in a Web Worker (no Node), so transformers.js
// takes its browser code path. onnxruntime-web is forced to the CPU-only
// "wasm" bundle (JS glue inlined); the .wasm binary comes from the plugin in
// the init message, so the runtime never fetches anything from a CDN.
const workerResult = await esbuild.build({
	entryPoints: ["src/embeddings/worker/embedding.worker.ts"],
	bundle: true,
	write: false,
	format: "iife",
	platform: "browser",
	target: "es2022",
	minify: prod,
	alias: {
		"onnxruntime-web/webgpu": ORT.module,
		"indexa-ort": ORT.module,
	},
	define: { "import.meta.url": "undefined" },
	logLevel: "warning",
});
const workerCode = workerResult.outputFiles[0].text;

// Step 1b: the analysis worker (vector index, graph, clustering). No ML model.
const analysisResult = await esbuild.build({
	entryPoints: ["src/analysis/analysis.worker.ts"],
	bundle: true,
	write: false,
	format: "iife",
	platform: "browser",
	target: "es2022",
	minify: prod,
	define: { "import.meta.url": "undefined" },
	logLevel: "warning",
});
const analysisWorkerCode = analysisResult.outputFiles[0].text;

// Step 2: the plugin itself. The worker source is injected as a string and
// started from a Blob URL at runtime (lazily, never in onload()).
await esbuild.build({
	entryPoints: ["src/main.ts"],
	bundle: true,
	format: "cjs",
	platform: "browser",
	target: "es2022",
	minify: prod,
	external: ["obsidian", "electron", "zlib"],
	plugins: [ortWasmPlugin],
	define: { __WORKER_CODE__: JSON.stringify(workerCode), __ANALYSIS_WORKER_CODE__: JSON.stringify(analysisWorkerCode), __SPIKE__: String(spike), __ORT_FLAVOUR__: JSON.stringify(ort) },
	outfile: path.join(outDir, "main.js"),
	logLevel: "info",
});

if (outDir !== ".") for (const f of ["manifest.json", "styles.css"]) fs.copyFileSync(f, path.join(outDir, f));

const size = (f) => (fs.statSync(f).size / 1024 / 1024).toFixed(2) + " MB";
console.log(`spike: ${spike}, ort: ${ort} (wasm ${(ortWasm.length / 1024 / 1024).toFixed(2)} MB, brotli ${(ortWasmBr.length / 1024 / 1024).toFixed(2)} MB), worker: ${(workerCode.length / 1024 / 1024).toFixed(2)} MB, analysis worker: ${(analysisWorkerCode.length / 1024 / 1024).toFixed(2)} MB, main.js: ${size(path.join(outDir, "main.js"))}`);
