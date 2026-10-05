// Dev helper: evaluate JS inside a running Obsidian window via the Chrome
// DevTools Protocol. Obsidian must be started with --remote-debugging-port.
//
//   node scripts/cdp.mjs [--title <substr>] [--port 9333] [--timeout ms] "<expression>"
//
// The expression may use top-level await; its JSON-serialised value is printed.

const args = process.argv.slice(2);
const opt = (name, def) => {
	const i = args.indexOf(name);
	if (i < 0) return def;
	const v = args[i + 1];
	args.splice(i, 2);
	return v;
};
const port = opt("--port", process.env.CDP_PORT ?? "9333");
const title = opt("--title", "dev-vault");
const timeout = Number(opt("--timeout", "600000"));
const shot = opt("--screenshot", null);
const anyWindow = args.includes("--any") && (args.splice(args.indexOf("--any"), 1), true);
const expr = args.join(" ");

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
// only main vault windows (popouts / settings windows have other URLs)
// only main vault windows unless --any (popouts / the settings window are about:blank)
const pages = targets.filter((t) => t.type === "page" && (anyWindow || t.url.startsWith("app://obsidian.md/index.html")));
if (expr === "--list") {
	console.log(pages.map((p) => p.title).join("\n"));
	process.exit(0);
}
const page = pages.find((p) => p.title.includes(title));
if (!page) {
	console.error(`No page with title containing "${title}". Pages:\n` + pages.map((p) => " - " + p.title).join("\n"));
	process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
const timer = setTimeout(() => {
	console.error("timeout");
	process.exit(3);
}, timeout);
ws.onmessage = (ev) => {
	const msg = JSON.parse(ev.data);
	if (msg.id !== 1) return;
	clearTimeout(timer);
	const r = msg.result;
	if (r?.exceptionDetails) {
		console.error("EXCEPTION:", r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
		process.exit(1);
	}
	const v = r?.result?.value;
	console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
	ws.close();
	process.exit(0);
};
if (shot) {
	ws.onmessage = async (ev) => {
		const msg = JSON.parse(ev.data);
		if (msg.id !== 1) return;
		const { writeFileSync } = await import("node:fs");
		writeFileSync(shot, Buffer.from(msg.result.data, "base64"));
		console.log("saved " + shot);
		process.exit(0);
	};
	ws.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "png" } }));
} else ws.send(
	JSON.stringify({
		id: 1,
		method: "Runtime.evaluate",
		params: {
			expression: `(async () => { const __v = await (async () => (${expr}))(); return typeof __v === "string" ? __v : JSON.stringify(__v); })()`,
			awaitPromise: true,
			returnByValue: true,
			replMode: false,
		},
	}),
);
