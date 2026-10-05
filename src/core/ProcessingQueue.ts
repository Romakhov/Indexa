// event → debounce → queue → processing (spec §11–13). Pure: no Obsidian imports.

/** Per-key debounce: many calls for one key within `delayMs` collapse into one. */
export class KeyedDebouncer<K> {
	private timers = new Map<K, number>();

	constructor(
		private delayMs: number,
		private readonly fire: (key: K) => void,
	) {}

	setDelay(ms: number) {
		this.delayMs = ms;
	}

	trigger(key: K) {
		const t = this.timers.get(key);
		if (t !== undefined) window.clearTimeout(t);
		this.timers.set(
			key,
			window.setTimeout(() => {
				this.timers.delete(key);
				this.fire(key);
			}, this.delayMs),
		);
	}

	cancel(key: K) {
		const t = this.timers.get(key);
		if (t !== undefined) window.clearTimeout(t);
		this.timers.delete(key);
	}

	cancelAll() {
		for (const t of this.timers.values()) window.clearTimeout(t);
		this.timers.clear();
	}

	get pending() {
		return this.timers.size;
	}
}

export interface QueueStats {
	queued: number;
	running: number;
	done: number;
	failed: number;
}

/**
 * Bounded-concurrency job queue with de-duplication by key: a job enqueued
 * for a key that is already waiting replaces it (latest wins). A key that is
 * currently running is queued again so the newest state is processed.
 */
export class ProcessingQueue<K, T> {
	private waiting = new Map<K, T>();
	private running = new Set<K>();
	private idleWaiters: (() => void)[] = [];
	private stats = { done: 0, failed: 0 };
	private paused = false;

	constructor(
		private readonly worker: (key: K, job: T) => Promise<void>,
		private readonly concurrency = 1,
		private readonly onError: (key: K, error: unknown) => void = () => undefined,
	) {}

	enqueue(key: K, job: T) {
		this.waiting.delete(key); // move to the back, latest job wins
		this.waiting.set(key, job);
		this.pump();
	}

	remove(key: K) {
		this.waiting.delete(key);
	}

	clear() {
		this.waiting.clear();
	}

	pause() {
		this.paused = true;
	}

	resume() {
		this.paused = false;
		this.pump();
	}

	getStats(): QueueStats {
		return { queued: this.waiting.size, running: this.running.size, ...this.stats };
	}

	/** Resolves when nothing is waiting or running. */
	onIdle(): Promise<void> {
		if (this.waiting.size === 0 && this.running.size === 0) return Promise.resolve();
		return new Promise((r) => this.idleWaiters.push(r));
	}

	private pump() {
		if (this.paused) return;
		while (this.running.size < this.concurrency) {
			const next = [...this.waiting.keys()].find((k) => !this.running.has(k));
			if (next === undefined) break;
			const job = this.waiting.get(next)!;
			this.waiting.delete(next);
			this.running.add(next);
			this.worker(next, job)
				.then(
					() => this.stats.done++,
					(e) => {
						this.stats.failed++;
						this.onError(next, e);
					},
				)
				.finally(() => {
					this.running.delete(next);
					this.pump();
					if (this.waiting.size === 0 && this.running.size === 0) this.idleWaiters.splice(0).forEach((r) => r());
				});
		}
	}
}
