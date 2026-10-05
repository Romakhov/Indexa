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
| 3 — vector search: HNSW index in a worker, rebuild from cache, top-K | done |
| 4 — hybrid similarity graph + Louvain in the worker; clustering benchmark | done |
| 5 — proposals: confidence + unclassified, multi-index (incl. chunks), collections, names, related | done |
| 6 — review UI: rename, merge, split, ignore, add/remove notes, main/secondary index, unclassified | done |
| 7 — apply + undo: index notes, frontmatter, change sets | next |

What works now: the Indexa view (ribbon icon or command "Indexa: Open"), "Analyze vault" with stage
progress and cancel (scanning, text preparation, chunking, local embeddings with a persistent cache,
HNSW vector index, topic communities via Louvain, index proposals with names, multi-index
membership, collections and unclassified notes — see the Indexes / Unclassified tabs), settings,
model download. Nothing in the vault is modified.

Measured on a real 932-note vault (Windows, 16 threads): first analysis ≈4 min with 2 embedding
workers, re-analysis from cache 0.3 s. Each worker holds its own model copy (~0.5 GB RAM); workers are
released after 5 minutes without semantic work. The vector index lives in a separate light worker
(no model) and is rebuilt from the embedding cache after a restart: 0.25 s for 930 notes, ~4 s for
10 000 (synthetic), without blocking the UI. Vectors are mean-centred before indexing, which removes
"hub" notes that otherwise look similar to everything.

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

## Clustering choice (spec §40)

Graph + Louvain was compared with a density-based method (UMAP → HDBSCAN) on two labelled datasets:
a real 358-note personal vault (43 manual indexes) and 1 990 Wikipedia articles (8 topics).
Full numbers: [`reports/bench-clustering-real-vault.json`](reports/bench-clustering-real-vault.json),
[`reports/bench-clustering-wikipedia.json`](reports/bench-clustering-wikipedia.json).

| | real vault NMI | Wikipedia purity | left unassigned | time (1 990 notes) |
|---|---|---|---|---|
| Louvain, hybrid edges (+ refinement) | 0.70–0.72 | 0.89–0.93 | 0% | 13–35 ms |
| UMAP + HDBSCAN | 0.45–0.53 | 0.37–0.41 | 54–73% | 11.7 s |
| HDBSCAN on raw vectors | 0.16 | 0.17 | 88–95% | 258 s |

Production path: top-K hybrid graph (semantic 70%, links 15%, tags 8%, keywords 5%, folder 2%;
configurable) → Louvain (seeded, stable across seeds: NMI 0.92–0.98) → recursive refinement of
communities above 15% of the vault. "Level of detail" maps to Louvain resolution.

## Proposals (spec §41–51)

- **Confidence**: closeness to the community centre (as a percentile) blended with neighbourhood
  agreement. Low-confidence notes become *Unclassified* instead of polluting a topic. On the real
  vault the notes moved to Unclassified were ones raw clustering had right only 25% of the time
  (vs 59% for those kept). Default threshold: 77% of content notes get an index.
- **Multi-index**: every note is scored against every index centre with its document vector and
  its best section (chunk) vector; ~10% of notes get a second index.
- **Collections**: notes with little own text (e.g. template movie cards) are grouped by shared
  metadata (`type`, tag, or a folder) instead of meaning.
- **Names**: shared title phrases (the user's own vocabulary), concentrated tags, top keywords;
  generic names (Notes, Misc, Разное…) are never proposed; otherwise "Unnamed topic" + keywords.

## Review (spec §52–54)

Proposals are recomputed on every analysis; the user's decisions (rename, merge, split, ignore,
add/remove notes, main index of a note) are stored separately (`review.json`) and layered on top.
After re-analysis, new proposals inherit the ids of old ones that kept most of their notes
(member overlap), so decisions keep applying. Split indexes are split again deterministically.
