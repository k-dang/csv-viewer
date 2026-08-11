# 08 - Web Export CSV + workspace lifecycle guards

**What to build:** Export CSV delivers through a browser download, and the memory-only workspace lifetime is honest with the user: a navigation guard protects Unexported Changes, and a fatal engine failure produces one clear error with a reload action.

**Blocked by:** 07 - Web composition root.

**Status:** ready-for-agent

- [ ] Export CSV generates output preserving the current Working CSV: active delimiter, header choice, edits, inserts, deletes, and source order; internal columns excluded.
- [ ] Handoff to the browser download counts as success, clears Unexported Changes, preserves undo/redo, and is communicated as "Download started", not "Saved".
- [ ] A navigation warning appears on refresh or close only while at least one Working CSV has Unexported Changes; no warning when all Working CSVs match their initial or latest exported state. Browser-provided confirmation copy is acceptable.
- [ ] Refresh or page close ends the workspace; nothing is restored and no CSV contents or derived data touch browser-managed persistent storage.
- [ ] A fatal DuckDB-Wasm Worker failure produces one workspace-level error state with a reload action; no partial reconstruction, no continuing with corrupted state.
- [ ] Web adapter tests cover download handoff, "Download started" presentation, the navigation guard's on/off conditions, and fatal Worker behavior.
