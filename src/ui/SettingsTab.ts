import { PluginSettingTab, type App, type SettingDefinitionItem } from "obsidian";
import type IndexaPlugin from "../main";
import type { IndexaSettings } from "../settings/Settings";

type Key = keyof IndexaSettings;
/** Keys stored as string[] but edited as one entry per line. */
const LIST_KEYS = new Set<Key>(["excludedFolders", "excludedTags"]);

export class IndexaSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: IndexaPlugin,
	) {
		super(app, plugin);
	}

	getControlValue(key: string): unknown {
		const value = this.plugin.settings[key as Key];
		return LIST_KEYS.has(key as Key) ? (value as string[]).join("\n") : value;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const v = LIST_KEYS.has(key as Key) ? String(value).split("\n") : value;
		await this.plugin.updateSettings({ [key]: v } as Partial<IndexaSettings>);
		if (key === "showAdvanced" || key === "moveNotesAfterApply") this.refreshDomState();
	}

	getSettingDefinitions(): SettingDefinitionItem<Key>[] {
		const advanced = () => this.plugin.settings.showAdvanced;
		return [
			{
				type: "group",
				heading: "Privacy",
				items: [
					{
						name: "All semantic analysis runs locally",
						desc: "Your note content is not sent to an external AI service. No telemetry, no analytics. The only network request is the model download you start yourself.",
					},
				],
			},
			{
				type: "group",
				heading: "Indexes",
				items: [
					{ name: "Index folder", desc: "Where index notes are created.", control: { type: "folder", key: "indexFolder", defaultValue: "Indexes" } },
					{ name: "Add frontmatter to notes", desc: "Write zk-indexes links into the note's YAML.", control: { type: "toggle", key: "addFrontmatter" } },
					{ name: "Add visible index links", desc: "Also add a small section with index links to the note body.", control: { type: "toggle", key: "addVisibleIndexLinks" } },
					{ name: "Move notes after Apply", desc: "Off: notes stay where they are; only links are added.", control: { type: "toggle", key: "moveNotesAfterApply" } },
					{
						name: "Move notes to",
						visible: () => this.plugin.settings.moveNotesAfterApply,
						control: { type: "folder", key: "moveTargetFolder", defaultValue: "Zettelkasten" },
					},
				],
			},
			{
				type: "group",
				heading: "What to analyse",
				items: [
					{
						name: "Excluded folders",
						desc: "One folder per line. Notes inside are never analysed.",
						control: { type: "textarea", key: "excludedFolders", rows: 4, placeholder: "Templates\nDaily\nArchive" },
					},
					{
						name: "Excluded tags",
						desc: "One tag per line, without #. Notes with these tags are skipped. Frontmatter zk-ignore: true also works.",
						control: { type: "textarea", key: "excludedTags", rows: 2, placeholder: "zk-ignore" },
					},
				],
			},
			{
				type: "group",
				heading: "Proposals",
				items: [
					{
						name: "Level of detail",
						desc: "Few broad indexes (1) or many narrow ones (10).",
						control: { type: "slider", key: "detailLevel", min: 1, max: 10, step: 1 },
					},
					{
						name: "Minimum notes per index",
						control: { type: "number", key: "minNotesPerIndex", min: 2, max: 50, validate: (v) => (v < 2 ? "At least 2" : undefined) },
					},
					{ name: "Maximum suggested indexes per note", control: { type: "number", key: "maxIndexesPerNote", min: 1, max: 10 } },
				],
			},
			{
				type: "group",
				heading: "New and changed notes",
				items: [
					{ name: "Analyse new notes automatically", control: { type: "toggle", key: "autoAnalyzeNewNotes" } },
					{ name: "Ask before assigning", desc: "Suggest indexes and wait for confirmation.", control: { type: "toggle", key: "askBeforeAssigning" } },
					{
						name: "Debounce delay (ms)",
						desc: "Wait this long after the last edit before re-analysing a note.",
						control: { type: "number", key: "debounceMs", min: 500, max: 60000 },
					},
				],
			},
			{
				type: "group",
				heading: "Advanced",
				items: [
					{ name: "Show advanced settings", control: { type: "toggle", key: "showAdvanced" } },
					{
						name: "Embedding model",
						visible: advanced,
						control: { type: "dropdown", key: "embeddingModel", options: { "multilingual-e5-small": "multilingual-e5-small (≈130 MB, RU/EN)" } },
					},
					{
						name: "Semantic threshold",
						desc: "Relative confidence required to suggest an index (0–100).",
						visible: advanced,
						control: { type: "slider", key: "semanticThreshold", min: 0, max: 100, step: 5 },
					},
					{ name: "Top-K neighbours", visible: advanced, control: { type: "number", key: "topK", min: 5, max: 50 } },
					{
						name: "Embedding workers",
						desc: "Parallel model copies used during analysis. More is faster on multi-core CPUs but each uses ~300 MB of memory.",
						visible: advanced,
						control: { type: "slider", key: "embeddingWorkers", min: 1, max: 4, step: 1 },
					},
					{ name: "Debug logging", visible: advanced, control: { type: "toggle", key: "debugLogging" } },
				],
			},
		];
	}
}
