import fs from "node:fs";
import { AutoModelForCausalLM, AutoTokenizer } from "@huggingface/transformers";
import { namingPrompt } from "./naming-prompt.mjs";
const [modelId, dtype] = [process.argv[2], process.argv[3] ?? "q4"];
const topics = JSON.parse(fs.readFileSync("build/naming-inputs.json", "utf8"));
const tl = Date.now();
const tokenizer = await AutoTokenizer.from_pretrained(modelId);
const model = await AutoModelForCausalLM.from_pretrained(modelId, { dtype });
console.log("load ms", Date.now() - tl);
const out = [];
for (const t of topics) {
	const t0 = Date.now();
	const messages = [{ role: "user", content: namingPrompt(t) + "\n/no_think" }];
	const inputs = tokenizer.apply_chat_template(messages, { add_generation_prompt: true, return_dict: true, enable_thinking: false });
	const gen = await model.generate({ ...inputs, max_new_tokens: 60, do_sample: false });
	const text = tokenizer.batch_decode(gen.slice(null, [inputs.input_ids.dims[1], null]), { skip_special_tokens: true })[0];
	let name = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
	try { const j = JSON.parse(name.match(/\{[\s\S]*\}/)[0]); name = j.name + "  (" + (j.alternatives || []).join(" · ") + ")"; } catch {}
	out.push({ current: t.current, name, ms: Date.now() - t0, promptTokens: inputs.input_ids.dims[1] });
	console.log(`${String(Date.now() - t0).padStart(6)} ms ${String(inputs.input_ids.dims[1]).padStart(4)} tok | ${t.current.padEnd(22)} → ${name.replace(/\n/g, " ")}`);
}
fs.writeFileSync(`build/naming-${modelId.split("/").pop()}-${dtype}.json`, JSON.stringify(out, null, 1));
