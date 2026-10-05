// Builds straight into the dev vault's plugin folder.
import fs from "node:fs";
process.env.PLUGIN_OUT_DIR = "dev-vault/.obsidian/plugins/structure-tree";
fs.mkdirSync(process.env.PLUGIN_OUT_DIR, { recursive: true });
process.argv.push("--production");
await import("../esbuild.config.mjs");
