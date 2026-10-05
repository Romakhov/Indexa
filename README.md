# Indexa

Forget where the note lives. Indexa organizes notes by meaning.

Local self-organizing knowledge graph for Obsidian: analyses the meaning of your notes
and proposes index notes linking related notes. Desktop only. Work in progress (Phase 0 — technical spike).

## Privacy and network use

All semantic analysis runs locally. Your note content is never sent anywhere. No telemetry, no analytics.

The plugin makes exactly one kind of network request: **downloading the embedding model, and only when you
run "Download local semantic model"**.

| | |
|---|---|
| Model | [`Xenova/multilingual-e5-small`](https://huggingface.co/Xenova/multilingual-e5-small) (ONNX port of `intfloat/multilingual-e5-small`), q8 |
| Licence | MIT |
| Source | `huggingface.co`, pinned to commit `761b726dd34fb83930e26aab4e9ac3899aa1fa78` |
| Size | ~130 MB on disk |
| Stored in | Windows `%APPDATA%\indexa\models`, macOS `~/Library/Application Support/indexa/models`, Linux `$XDG_DATA_HOME/indexa/models` |

The model is kept outside the vault so it is shared between vaults and is not copied by vault sync.
The ONNX Runtime WebAssembly binary is bundled inside `main.js`; nothing is loaded from a CDN.
Inference runs in a Web Worker in which all `fetch`/XHR/`importScripts` calls are blocked.

## Development

```bash
npm install
npm run build:vault   # builds into dev-vault/.obsidian/plugins/indexa
```

Run Obsidian with `--remote-debugging-port=9333`, open `dev-vault`, then drive it with
`node scripts/cdp.mjs "<js expression>"` (see the script header).

Spike reports are in [`reports/`](reports/).
