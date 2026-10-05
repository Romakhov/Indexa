import { FuzzySuggestModal, Modal, Setting, type App, type TFile } from "obsidian";
import type { EffectiveIndex } from "../review/ReviewState";

/** Rename an index: free text plus one-click name candidates. */
export class RenameModal extends Modal {
	private value: string;

	constructor(
		app: App,
		private readonly index: EffectiveIndex,
		private readonly onSubmit: (name: string) => void,
	) {
		super(app);
		this.value = index.unnamed ? "" : index.name;
	}

	onOpen() {
		this.setTitle("Rename index");
		const { contentEl } = this;
		if (this.index.keywords.length) contentEl.createDiv({ cls: "indexa-muted", text: "Keywords: " + this.index.keywords.slice(0, 8).join(", ") });
		let input: HTMLInputElement | null = null;
		new Setting(contentEl).setName("Name").addText((t) => {
			input = t.inputEl;
			t.setValue(this.value).setPlaceholder("Topic name");
			t.onChange((v) => (this.value = v));
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") this.submit();
			});
		});
		const options = this.index.nameOptions.filter((o) => o !== this.index.name);
		if (options.length) {
			const chips = contentEl.createDiv({ cls: "indexa-chips" });
			chips.createSpan({ cls: "indexa-muted", text: "Suggestions:" });
			for (const o of options) {
				const b = chips.createEl("button", { cls: "indexa-chip", text: o });
				b.onclick = () => {
					this.value = o;
					if (input) input.value = o;
				};
			}
		}
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Save").setCta().onClick(() => this.submit()));
		window.setTimeout(() => input?.focus(), 0);
	}

	private submit() {
		const name = this.value.trim();
		if (!name) return;
		this.onSubmit(name);
		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class NoteSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly files: TFile[],
		private readonly onChoose: (f: TFile) => void,
	) {
		super(app);
		this.setPlaceholder("Add a note to this index…");
	}

	getItems() {
		return this.files;
	}

	getItemText(f: TFile) {
		return f.path.replace(/\.md$/, "");
	}

	onChooseItem(f: TFile) {
		this.onChoose(f);
	}
}

export class IndexSuggestModal extends FuzzySuggestModal<EffectiveIndex> {
	constructor(
		app: App,
		private readonly indexes: EffectiveIndex[],
		placeholder: string,
		private readonly onChoose: (i: EffectiveIndex) => void,
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getItems() {
		return this.indexes;
	}

	getItemText(i: EffectiveIndex) {
		return `${i.name} (${i.members.length})`;
	}

	onChooseItem(i: EffectiveIndex) {
		this.onChoose(i);
	}
}
