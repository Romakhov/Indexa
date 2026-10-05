// The ONNX Runtime WebAssembly binary ships inside main.js, compressed.
//
// It is the unmodified ort-wasm-simd-threaded.wasm of the onnxruntime-web
// version pinned in package.json, compressed with brotli at build time
// (esbuild.config.mjs) only to keep main.js under Obsidian Sync's 5 MB file
// limit: 14.3 MB raw, 2.3 MB compressed. Nothing is downloaded at runtime.
// The browser's DecompressionStream has no brotli in Obsidian's Chromium, so
// Node's zlib (available on desktop) decompresses it, off the main thread.

import compressed from "indexa-ort-wasm-br";
import { brotliDecompress } from "zlib";

/** A fresh copy of the WASM binary, ready to be transferred to a worker. */
export function ortWasmBinary(): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		brotliDecompress(compressed, (err, out) => {
			if (err) reject(err);
			else resolve(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
		});
	});
}
