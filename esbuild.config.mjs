import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const prod = process.argv.includes("--production");
const outDir = process.env.PLUGIN_OUT_DIR ?? ".";

// Step 1: the ML worker. Runs in a Web Worker (no Node), so transformers.js
// takes its browser code path. onnxruntime-web is forced to the CPU-only
// "wasm" bundle (JS glue inlined) and the .wasm binary is embedded, so the
// runtime never fetches anything from a CDN.
const workerResult = await esbuild.build({
	entryPoints: ["src/embeddings/worker/embedding.worker.ts"],
	bundle: true,
	write: false,
	format: "iife",
	platform: "browser",
	target: "es2022",
	minify: prod,
	alias: {
		"onnxruntime-web/webgpu": "onnxruntime-web/wasm",
	},
	loader: { ".wasm": "binary" },
	define: { "import.meta.url": "undefined" },
	logLevel: "warning",
});
const workerCode = workerResult.outputFiles[0].text;

// Step 2: the plugin itself. The worker source is injected as a string and
// started from a Blob URL at runtime (lazily, never in onload()).
await esbuild.build({
	entryPoints: ["src/main.ts"],
	bundle: true,
	format: "cjs",
	platform: "browser",
	target: "es2022",
	minify: prod,
	external: ["obsidian", "electron", "fs", "path", "os", "crypto"],
	define: { __WORKER_CODE__: JSON.stringify(workerCode) },
	outfile: path.join(outDir, "main.js"),
	logLevel: "info",
});

if (outDir !== ".") fs.copyFileSync("manifest.json", path.join(outDir, "manifest.json"));

const size = (f) => (fs.statSync(f).size / 1024 / 1024).toFixed(2) + " MB";
console.log(`worker: ${(workerCode.length / 1024 / 1024).toFixed(2)} MB, main.js: ${size(path.join(outDir, "main.js"))}`);
