// Stores the embedding model outside the vault, in the OS per-user app-data
// directory, so it is shared between vaults and never picked up by vault sync.
// Uses Node APIs (the plugin is isDesktopOnly).

import { requestUrl } from "obsidian";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface ModelSpec {
	/** Hugging Face repo id; also the transformers.js model id. */
	id: string;
	/** Pinned commit, so the downloaded files never change silently. */
	revision: string;
	dtype: string;
	files: string[];
	approxBytes: number;
	license: string;
	dims: number;
}

export const E5_SMALL: ModelSpec = {
	id: "Xenova/multilingual-e5-small",
	revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
	dtype: "q8",
	files: ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"],
	approxBytes: 135_500_000,
	license: "MIT",
	dims: 384,
};

const APP_DIR = "indexa";

export function appDataDir(): string {
	if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), APP_DIR);
	if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", APP_DIR);
	return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), APP_DIR);
}

export class ModelStore {
	constructor(readonly root: string = path.join(appDataDir(), "models")) {}

	dir(spec: ModelSpec): string {
		return path.join(this.root, ...spec.id.split("/"), spec.revision);
	}

	isInstalled(spec: ModelSpec): boolean {
		return spec.files.every((f) => fs.existsSync(path.join(this.dir(spec), f)));
	}

	/** Explicit user action only. The only network request the plugin makes. */
	async download(spec: ModelSpec, onProgress?: (file: string, i: number, n: number) => void): Promise<void> {
		const dir = this.dir(spec);
		for (let i = 0; i < spec.files.length; i++) {
			const file = spec.files[i];
			const target = path.join(dir, file);
			if (fs.existsSync(target)) continue;
			onProgress?.(file, i + 1, spec.files.length);
			const url = `https://huggingface.co/${spec.id}/resolve/${spec.revision}/${file}`;
			const res = await requestUrl({ url, throw: true });
			fs.mkdirSync(path.dirname(target), { recursive: true });
			// write to a temp name first so an interrupted download never looks installed
			fs.writeFileSync(target + ".part", Buffer.from(res.arrayBuffer));
			fs.renameSync(target + ".part", target);
		}
	}

	async readAll(spec: ModelSpec): Promise<Record<string, ArrayBuffer>> {
		const out: Record<string, ArrayBuffer> = {};
		for (const file of spec.files) {
			const buf = await fs.promises.readFile(path.join(this.dir(spec), file));
			out[file] = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
		}
		return out;
	}
}
