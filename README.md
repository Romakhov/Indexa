# Indexa

Forget where the note lives. Indexa organizes notes by meaning.

Local self-organizing knowledge graph for Obsidian: analyses the meaning of your notes
and proposes index notes linking related notes. Desktop only, Obsidian 1.13+. Early version (0.0.x):
try it on a copy of your vault first.

## Getting started

1. Open Indexa from the ribbon icon or the command "Indexa: Open".
2. Run "Download local semantic model" once (~130 MB, see [Privacy and network use](#privacy-and-network-use)).
3. Run "Analyze vault". Nothing in the vault is changed by analysis.
4. Review the proposed indexes in the Indexes and Unclassified tabs: rename, merge, split, ignore, move notes.
5. "Apply index structure" creates the index notes and adds `zk-indexes` links to your notes.
   "Undo last Apply" restores every changed file.

After the first Apply, new and edited notes get index suggestions automatically (incremental mode).

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
| 7 — apply + undo: index notes, zk-indexes, change journal, stacked undo | done |
| 8 — incremental mode: new / changed / renamed / deleted notes, review queue | done |
| 9 — large-vault stabilisation: 500 / 2k / 5k / 10k benchmarks, fixes from measurements | done |
| Gate R — Obsidian review compatibility: scanner lint + bundle preflight in build and CI | done — [`reports/review-check.md`](reports/review-check.md) |

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
| Size | ~130 MB |
| Stored in | Obsidian's own browser storage (IndexedDB `indexa-models`), not in the vault |

The model is kept outside the vault so it is shared between vaults and is not copied by vault sync.
The plugin does not access files outside the vault.
The ONNX Runtime WebAssembly binary is bundled inside `main.js` (brotli-compressed, see below); nothing is loaded from a CDN.
No executable code is ever downloaded: the model download contains weights, tokenizer and config files only.
Embeddings are cached in the plugin folder (`cache/`, a few MB per thousand notes); vectors are never written into notes.
Inference runs in a Web Worker in which all `fetch`/XHR/`importScripts` calls are blocked.

To analyse the vault, Indexa reads every Markdown file that is not excluded in the settings
(Settings → Excluded folders). It writes only when you run Apply or Undo.

## Development

```bash
npm install
npm test              # unit tests (vitest)
npm run build         # typecheck + tests + scanner lint + release main.js
npm run lint          # Obsidian community scanner ESLint rules (pinned copy in tools/review)
npm run review        # Obsidian's review action, run locally against the source and the built main.js
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

## Apply and Undo (spec §55–58, §76, §95–96)

- Index notes are created in the index folder (`zk-type: index`, `zk-generated: true`). If a note with
  the same name already exists there, it is not overwritten: Indexa adds its own section only.
- Notes get `zk-type: note` and `zk-indexes` in their frontmatter. YAML is edited as text: only
  these keys are added or replaced; every other byte (comments, quoting, empty values, CRLF) stays.
- Indexa writes body text only between `%% indexa:start %%` and `%% indexa:end %%`.
- Links use the shortest unambiguous path, so notes with the same name in different folders work.
- Renames (an index renamed after Apply, optional note moves) bypass Obsidian's link updater, which
  would re-serialise the frontmatter of every linking note; only the affected link strings change.
- Every Apply is an ordered journal with the original text of each file. Undo replays it backwards:
  untouched files come back byte-for-byte, files edited since lose only Indexa's keys and section,
  created index notes go to the Obsidian trash. Undo works as a stack over the last 10 Applies.

Verified on a 954-note vault copy: Apply (16 created, 827 updated, 0 broken links) → Undo → all
954 files identical to the snapshot taken before; also with a renamed index and user edits in between.

## Incremental mode (spec §11–13, §60–63, §94)

After the first analysis, Indexa follows the vault: create / modify events are debounced per note
(default 3 s) and processed one at a time. A new or meaningfully changed note is embedded on its
own, the vector index is updated in place, and the note is scored against the centres of the
current indexes (after your review decisions). Suggestions appear as a notice with
**Add · Review · Ignore** and in the Review tab. With "Ask before assigning" off, a note without
an index gets its best one directly. Once a structure is applied, adding a note writes only that
note and its index notes (journaled, undoable). Small edits (vector almost unchanged) update the
cache silently; renames keep the note id and its embedding; deletions remove vector, cache entry
and memberships. Indexa's own writes are recognised by content and never re-processed.

Measured on the 954-note vault copy: new note → suggestion in ~1.3 s after the debounce
(model loaded lazily), 5 rapid edits → 1 job.

## Large vaults (spec §68–75, §93)

Reproducible benchmark vault: `node scripts/make-bench-vault.mjs <dir> 10000` (Wikipedia, 20 topics,
RU/EN, long notes, links, tags, duplicate file names). Full numbers:
[`reports/bench-large-vault.json`](reports/bench-large-vault.json). Windows, 16 threads, CPU only,
2 embedding workers:

| | 500 | 2 000 | 5 000 | 10 000 |
|---|---|---|---|---|
| first analysis (embedding dominates) | ~1.8 min | ~5.5 min | ~14 min | ~37 min |
| re-analysis from cache | < 1 s | ~3 s | ~8 s | ~15 s |
| vector index build + top-K (worker) | 0.2 s | 1.2 s | 3.5 s | 7.6 s |
| Louvain (worker) | 0.07 s | 0.5 s | 1.1 s | 2.4 s |
| graph edges / all note pairs | 3.7% | 1.0% | 0.44% | 0.23% |
| ANN query | 0.22 ms | 0.26 ms | 0.33 ms | 0.35 ms |
| new note → index suggestion | 1.0 s | 1.4 s | 1.1 s | 1.4 s |
| embedding cache on disk | 1.4 MB | 5.5 MB | 13.5 MB | 26.6 MB |
| clusters vs 20 known topics (NMI) | 0.84 | 0.85 | 0.85 | 0.84 |

10 000 notes: Apply 33 s (9 432 notes, 43 indexes), Undo 21 s; peak renderer memory ~1.2 GB during
analysis (two model workers), released afterwards. Analysis can be cancelled at any point; the next run
continues from the cache. The progress view shows the remaining time of long stages.

Measured and fixed in this phase: note-id → path lookup was linear (Review recomputation 326 ms → 12 ms
at 10k); classification, keyword extraction and graph features now yield to the UI; scoring no longer
allocates an object per (note, index) pair; the model-installed check is cached. Longest main-thread
pause during a 10k analysis: 802 ms → 330 ms (remaining pauses are garbage collection).

## Obsidian review compatibility (Gate R)

Since May 2026 the community directory scans every release automatically: the source with the
`eslint-plugin-obsidianmd` scanner rules and Stylelint, and the published `main.js` with bundle checks.
The same checks run here on every build and push:

- `npm run lint` uses a pinned copy of the scanner's ESLint setup (`tools/review/`, mirrored from
  [obsidianmd/obsidian-workflows](https://github.com/obsidianmd/obsidian-workflows) v1.2.3) with zero warnings allowed;
- `npm run review` runs that action itself locally, in scanner mode, against the built bundle;
- `.github/workflows/review.yml` runs it on GitHub for every push.

Current result: **0 errors**, scanner ESLint and Stylelint clean. Remaining bundle findings, both expected and explained:

| Finding | Severity | Why it is there |
|---|---|---|
| `bundle-inline-wasm` | warning (advisory) | the WASM build of `hnswlib-wasm-core` (0.6 MB), inlined as base64 by that npm package itself. |
| `bundle-wasm-reference` | recommendation | file-name strings inside the ONNX Runtime glue code; the binary is passed in directly, so they are never fetched (the worker blocks all network access). |

**The ONNX Runtime binary.** `main.js` contains `ort-wasm-simd-threaded.wasm` of `onnxruntime-web`
1.31.0-dev.20260914-8d85527a0, unmodified, compressed with brotli (quality 11, window 24) at build time.
The only reason is size: raw it is 14.3 MB, compressed 2.3 MB, which keeps `main.js` (4.5 MB) under the 5 MB
file limit of Obsidian Sync. It is decompressed with Node's `zlib` when the embedding worker starts
(`src/embeddings/ortWasm.ts`, `esbuild.config.mjs`). The build is reproducible byte-for-byte, so the bytes can be
checked against the npm package. Downloading the binary at runtime instead was rejected: plugins must not
install their dependencies.

### Bundled third-party components

| Component | Licence | Use |
|---|---|---|
| [@huggingface/transformers](https://github.com/huggingface/transformers.js) | Apache-2.0 | tokenizer + inference pipeline (embedding worker) |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) (incl. its WASM binary) | MIT | model execution on the CPU |
| [hnswlib-wasm-core](https://www.npmjs.com/package/hnswlib-wasm-core) | Apache-2.0 | approximate nearest-neighbour index (analysis worker) |
| [graphology](https://graphology.github.io/), graphology-communities-louvain | MIT | similarity graph, Louvain communities |
