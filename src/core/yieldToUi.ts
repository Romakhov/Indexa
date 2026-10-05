/**
 * Lets the UI process pending events between chunks of synchronous work.
 *
 * Not setTimeout: Chromium throttles timers in hidden/background windows (down
 * to once per minute after 5 minutes), which stalled long analyses when the
 * Obsidian window was not in front. MessageChannel callbacks are not throttled.
 */
const channel = new MessageChannel();
const queue: (() => void)[] = [];
channel.port1.onmessage = () => queue.shift()?.();

export function yieldToUi(): Promise<void> {
	return new Promise((resolve) => {
		queue.push(resolve);
		channel.port2.postMessage(null);
	});
}

/**
 * Time-sliced cooperative yielding: call maybeYield() inside a long loop and it
 * yields only once the current slice has used up its budget.
 */
export function timeSlicer(budgetMs = 30) {
	let sliceStart = performance.now();
	return async function maybeYield() {
		if (performance.now() - sliceStart < budgetMs) return;
		await yieldToUi();
		sliceStart = performance.now();
	};
}
