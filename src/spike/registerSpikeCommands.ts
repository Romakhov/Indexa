// Dev-only Phase 0 spike commands. Compiled in only when __SPIKE__ is true
// (npm run build:vault); release builds leave this module out entirely.

import { Notice } from "obsidian";
import { E5_SMALL } from "../embeddings/ModelStore";
import type IndexaPlugin from "../main";
import { AdapterBinaryStore } from "../storage/BinaryStore";
import { runGate0a } from "./gate0a";
import { runGate0b } from "./gate0b";
import { runGate0c, type Gate0cOptions } from "./gate0c";

export function registerSpikeCommands(plugin: IndexaPlugin) {
	const store = () => new AdapterBinaryStore(plugin.app.vault.adapter, `${plugin.manifest.dir}/spike-data`);
	const writeReport = async (name: string, report: unknown) => {
		const dir = `${plugin.manifest.dir}/reports`;
		if (!(await plugin.app.vault.adapter.exists(dir))) await plugin.app.vault.adapter.mkdir(dir);
		await plugin.app.vault.adapter.write(`${dir}/${name}`, JSON.stringify(report, null, 2));
		console.log(`[indexa] ${name}`, report);
	};

	const spike = {
		async gate0a() {
			const report = await runGate0a(plugin.getProvider(), {
				pluginOnloadMs: +plugin.onloadMs.toFixed(2),
				modelDir: plugin.modelStore.dir(E5_SMALL),
			});
			await writeReport("gate0a.json", report);
			new Notice(`Gate 0a: ${report.passed ? "PASSED" : "FAILED"}`);
			return report;
		},
		async gate0b(sizes?: number[], scaleN?: number) {
			const report = await runGate0b(plugin.app, plugin.getProvider(), store(), sizes, scaleN);
			await writeReport("gate0b.json", report);
			new Notice(`Gate 0b: ${report.passed ? "PASSED" : "FAILED"}`);
			return report;
		},
		async gate0c(options: Partial<Gate0cOptions> = {}) {
			const report = await runGate0c(plugin.app, plugin.getProvider(), store(), options);
			await writeReport(`gate0c-${report.variant.variant.split(" ")[0]}.json`, report);
			new Notice(`Gate 0c: report written to ${report.reportNote}`);
			return report;
		},
	};
	// reachable from the dev console / CDP: app.plugins.plugins.indexa.spike
	(plugin as unknown as { spike: typeof spike }).spike = spike;

	plugin.addCommand({ id: "spike-gate-0a", name: "Spike: run Gate 0a self-test", callback: () => spike.gate0a() });
	plugin.addCommand({ id: "spike-gate-0b", name: "Spike: run Gate 0b pipeline benchmark", callback: () => spike.gate0b() });
	plugin.addCommand({ id: "spike-gate-0c", name: "Spike: run Gate 0c on this vault", callback: () => spike.gate0c() });
}
