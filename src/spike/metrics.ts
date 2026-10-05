// Benchmark-only metrics for comparing partitions.

/** Normalized mutual information (arithmetic normalization) between two labelings of the same items. */
export function nmi(a: (string | number)[], b: (string | number)[]): number {
	const n = a.length;
	const count = <T>(xs: T[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<T, number>());
	const ca = count(a);
	const cb = count(b);
	const joint = count(a.map((x, i) => `${x}\u0000${b[i]}`));
	const h = (c: Map<unknown, number>) => -[...c.values()].reduce((s, v) => s + (v / n) * Math.log(v / n), 0);
	let mi = 0;
	for (const [key, v] of joint) {
		const [x, y] = key.split("\u0000");
		const pa = ca.get(typeof a[0] === "number" ? Number(x) : x)! / n;
		const pb = cb.get(typeof b[0] === "number" ? Number(y) : y)! / n;
		mi += (v / n) * Math.log(v / n / (pa * pb));
	}
	const denom = (h(ca) + h(cb)) / 2;
	return denom === 0 ? 1 : mi / denom;
}

/** Share of items whose cluster's majority label equals their own label. */
export function purity(labels: string[], clusters: number[]): number {
	const byCluster = new Map<number, Map<string, number>>();
	labels.forEach((l, i) => {
		const m = byCluster.get(clusters[i]) ?? new Map<string, number>();
		m.set(l, (m.get(l) ?? 0) + 1);
		byCluster.set(clusters[i], m);
	});
	let hit = 0;
	for (const m of byCluster.values()) hit += Math.max(...m.values());
	return hit / labels.length;
}
