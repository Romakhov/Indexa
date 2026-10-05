import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			// the package only declares "module", which Node-side resolution ignores
			"hnswlib-wasm-core": fileURLToPath(new URL("./node_modules/hnswlib-wasm-core/dist/hnswlib.js", import.meta.url)),
		},
	},
	test: { include: ["tests/**/*.test.ts"] },
});
