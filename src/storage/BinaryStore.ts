import type { DataAdapter } from "obsidian";

/** Minimal blob storage used by persistent indexes and caches. */
export interface BinaryStore {
	read(name: string): Promise<ArrayBuffer | null>;
	write(name: string, data: ArrayBuffer | Uint8Array): Promise<void>;
	remove(name: string): Promise<void>;
}

/** Stores files in a folder through Obsidian's DataAdapter (e.g. the plugin directory). */
export class AdapterBinaryStore implements BinaryStore {
	constructor(
		private readonly adapter: DataAdapter,
		private readonly dir: string,
	) {}

	private path(name: string) {
		return `${this.dir}/${name}`;
	}

	async read(name: string): Promise<ArrayBuffer | null> {
		const p = this.path(name);
		return (await this.adapter.exists(p)) ? this.adapter.readBinary(p) : null;
	}

	async write(name: string, data: ArrayBuffer | Uint8Array): Promise<void> {
		if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
		const buf = data instanceof Uint8Array ? data.slice().buffer : data;
		await this.adapter.writeBinary(this.path(name), buf);
	}

	async remove(name: string): Promise<void> {
		const p = this.path(name);
		if (await this.adapter.exists(p)) await this.adapter.remove(p);
	}
}
