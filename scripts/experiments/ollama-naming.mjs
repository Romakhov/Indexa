import fs from "node:fs";
import { namingPrompt } from "./naming-prompt.mjs";
const topics = JSON.parse(fs.readFileSync("build/naming-inputs.json", "utf8"));
const model = process.argv[2];
const out = [];
for (const t of topics) {
	const t0 = Date.now();
	const res = await fetch("http://127.0.0.1:11434/api/chat", {
		method: "POST",
		body: JSON.stringify({ model, stream: false, format: "json", options: { temperature: 0.2, num_predict: 80 }, messages: [{ role: "user", content: namingPrompt(t) }] }),
	}).then((r) => r.json());
	let name = "?";
	try { const j = JSON.parse(res.message.content); name = j.name + "  (" + (j.alternatives || []).join(" · ") + ")"; } catch { name = "RAW " + res.message?.content; }
	out.push({ current: t.current, name, ms: Date.now() - t0 });
	console.log(`${String(Date.now() - t0).padStart(6)} ms | ${t.current.padEnd(22)} → ${name}`);
}
fs.writeFileSync(`build/naming-${model.replace(/[:/]/g, "_")}.json`, JSON.stringify(out, null, 1));
