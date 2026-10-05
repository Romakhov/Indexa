# Indexa

Forget where the note lives. Indexa organizes notes by meaning.

Local self-organizing knowledge graph for Obsidian: analyses the meaning of your notes
and proposes index notes linking related notes. Desktop only, Obsidian 1.13+. Work in progress.

## Status

| Phase | State |
|---|---|
| 0 — technical spike (Gates 0a–0c) | done — reports in [`reports/`](reports/) |
| 1 — plugin foundation: settings, main view, vault scanner, Markdown processing | done |
| 2 — semantic pipeline: chunking, embeddings, cache, queue | done |
| 3 — vector search: HNSW index, persistence, top-K (in the worker) | next |

What works now: the Indexa view (ribbon icon or command "Indexa: Open"), "Analyze vault" with stage
progress and cancel (scanning, text preparation, chunking, local embeddings with a persistent cache),
settings, model download. Nothing in the vault is modified.

Measured on a real 932-note vault (Windows, 16 threads): first analysis ≈4 min with 2 embedding
workers, re-analysis from cache 0.3 s. Each worker holds its own model copy (~0.5 GB RAM); workers are
released after 5 minutes without semantic work.

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
Embeddings are cached in the plugin folder (`cache/`, a few MB per thousand notes); vectors are never written into notes.
Inference runs in a Web Worker in which all `fetch`/XHR/`importScripts` calls are blocked.

## Development

```bash
npm install
npm test              # unit tests (vitest)
npm run build         # typecheck + tests + release main.js
npm run build:vault   # dev build with spike commands into dev-vault/.obsidian/plugins/indexa
```

`PLUGIN_OUT_DIR=<vault>/.obsidian/plugins/indexa npm run build:vault` builds into another test vault.

Run Obsidian with `--remote-debugging-port=9333`, open `dev-vault`, then drive it with
`node scripts/cdp.mjs "<js expression>"` (see the script header; `--screenshot file.png` captures the window,
`--any` also targets popout and settings windows).

Spike reports are in [`reports/`](reports/).
