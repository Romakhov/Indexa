// Dev helper: CPU-profile an expression in an Obsidian window and print the
// functions with the most self time inside long main-thread tasks.
//
//   node scripts/cdp-profile.mjs --title <window> "<async expression>"

const args = process.argv.slice(2);
const ti = args.indexOf("--title");
const title = ti >= 0 ? args.splice(ti, 2)[1] : "dev-vault";
const expr = args.join(" ");
const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = targets.find((t) => t.type === "page" && t.url.startsWith("app://obsidian.md/index.html") && t.title.includes(title));
if (!page) throw new Error("window not found");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let next = 1;
const pending = new Map();
ws.onmessage = (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) {
		pending.get(m.id)(m);
		pending.delete(m.id);
	}
};
const send = (method, params = {}) =>
	new Promise((resolve) => {
		const id = next++;
		pending.set(id, resolve);
		ws.send(JSON.stringify({ id, method, params }));
	});

await send("Profiler.enable");
await send("Profiler.setSamplingInterval", { interval: 200 });
await send("Profiler.start");
const res = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
const { result } = await send("Profiler.stop");
const profile = result.profile;

// self time per node, then grouped by function
const dt = new Map();
for (let i = 0; i < profile.samples.length; i++) dt.set(profile.samples[i], (dt.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0));
const byFn = new Map();
for (const n of profile.nodes) {
	const us = dt.get(n.id) ?? 0;
	if (!us) continue;
	const f = n.callFrame;
	if (["(idle)", "(program)", "(garbage collector)"].includes(f.functionName) && f.url === "") {
		byFn.set(f.functionName, (byFn.get(f.functionName) ?? 0) + us);
		continue;
	}
	const key = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
	byFn.set(key, (byFn.get(key) ?? 0) + us);
}
const top = [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 30);
console.log("result:", JSON.stringify(res.result?.result?.value ?? res.result?.exceptionDetails?.exception?.description).slice(0, 300));
for (const [k, us] of top) console.log(`${(us / 1000).toFixed(0).padStart(7)} ms  ${k}`);
ws.close();
process.exit(0);
