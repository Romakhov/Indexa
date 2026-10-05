// Stable internal note ids (spec §79): a note keeps its id across renames and
// moves, and duplicate file names in different folders get different ids.
// Pure: persistence goes through load()/serialize().

export class NoteIdRegistry {
	private byPath = new Map<string, string>();
	/** reverse index: id -> path (pathOf() is called for every member when rendering Review) */
	private byId = new Map<string, string>();
	private dirty = false;

	constructor(private readonly newId: () => string = () => crypto.randomUUID()) {}

	get size() {
		return this.byPath.size;
	}

	get isDirty() {
		return this.dirty;
	}

	idFor(path: string): string {
		let id = this.byPath.get(path);
		if (!id) {
			id = this.newId();
			this.byPath.set(path, id);
			this.byId.set(id, path);
			this.dirty = true;
		}
		return id;
	}

	pathOf(id: string): string | undefined {
		return this.byId.get(id);
	}

	peek(path: string): string | undefined {
		return this.byPath.get(path);
	}

	rename(oldPath: string, newPath: string) {
		const id = this.byPath.get(oldPath);
		if (!id) return;
		this.byPath.delete(oldPath);
		this.byPath.set(newPath, id);
		this.byId.set(id, newPath);
		this.dirty = true;
	}

	remove(path: string) {
		const id = this.byPath.get(path);
		if (id !== undefined && this.byPath.delete(path)) {
			this.byId.delete(id);
			this.dirty = true;
		}
	}

	/** Drops entries for paths that no longer exist. */
	retainOnly(paths: Iterable<string>) {
		const keep = new Set(paths);
		for (const p of [...this.byPath.keys()]) if (!keep.has(p)) this.remove(p);
	}

	load(data: unknown) {
		this.byPath = new Map(
			data && typeof data === "object" ? Object.entries(data as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string") : [],
		);
		this.byId = new Map([...this.byPath].map(([p, i]) => [i, p]));
		this.dirty = false;
	}

	serialize(): Record<string, string> {
		this.dirty = false;
		return Object.fromEntries(this.byPath);
	}
}
