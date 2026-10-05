# Changelog

## 0.0.2

- `main.js` is now 4.5 MB instead of 19.5 MB, so it fits Obsidian Sync's 5 MB file limit: the bundled
  ONNX Runtime WebAssembly binary is stored brotli-compressed and unpacked when the model starts.
- The embedding model is now kept in Obsidian's own storage (IndexedDB) instead of a folder in the
  user's app-data directory. The plugin no longer accesses any files outside the vault.
  If you used 0.0.1, run "Download local semantic model" once more; the old folder
  (`%APPDATA%/indexa`, `~/Library/Application Support/indexa` or `~/.local/share/indexa`) can be deleted.
- README: what the plugin reads and writes in the vault.

## 0.0.1

First release: local semantic analysis of the vault (embeddings, similarity graph, Louvain topics),
index proposals with names, review (rename, merge, split, ignore, move notes), Apply with full Undo,
incremental suggestions for new and edited notes.
