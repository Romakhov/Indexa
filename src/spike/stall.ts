/**
 * Measures main-thread blocking via Long Tasks (tasks > 50 ms). Unlike timer
 * gaps this is not distorted by Chromium throttling timers in background windows.
 */
export function stallMonitor() {
	let worst = 0;
	let total = 0;
	let count = 0;
	const observer = new PerformanceObserver((list) => {
		for (const e of list.getEntries()) {
			worst = Math.max(worst, e.duration);
			total += e.duration;
			count++;
		}
	});
	observer.observe({ type: "longtask" });
	return () => {
		for (const e of observer.takeRecords()) {
			worst = Math.max(worst, e.duration);
			total += e.duration;
			count++;
		}
		observer.disconnect();
		return { worstMs: Math.round(worst), totalMs: Math.round(total), count };
	};
}
