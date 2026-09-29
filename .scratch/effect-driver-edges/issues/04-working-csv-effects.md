# 04 — Move Working CSV operations onto Effects

**What to build:** Open, reopen, reads, edits, undo/redo, Export CSV, close, and table cleanup compose database Effects throughout the Working CSV store. Users retain the same data, messages, events, edit history, and Unexported Changes behavior. Export reads through a worker connection whose scope releases it on success and failure.

**Blocked by:** 01 — Make expected validation failures explicit; 02 — Add Effect database operations on both runtimes.

**Status:** ready-for-agent

- [ ] Convert table creation and deletion, metadata reads, row and cell reads, cell writes, row insertion/deletion, column changes, export-row reads, and edit-command replay to Effects that compose the new database interface.
- [ ] The store's read and edit helpers and mutation queue accept Effect bodies. Convert lifecycle cleanup, staging cleanup, and retired-table cleanup as well as successful request paths. Preserve leases, queue order, admission, publication/rollback rules, and artifact retry behavior.
- [ ] Expected lifecycle, lookup, edit, missing-row, unknown-column, dialect, and maximum-row-window failures use typed failures with existing messages. Consume the query and history Results from ticket 01. Complete the store portion of its throw-site audit; broken invariants remain defects.
- [ ] Undo/redo replay database work before committing history and metadata changes. Preserve schema restoration, row counts, revisions, and Unexported Changes semantics when replay succeeds or fails.
- [ ] Export reads rows through a worker connection acquired with `acquireRelease`. Its connection closes on read or serialization failure as well as success, with cleanup reporting preserved. Export delivery remains outside the Working CSV lease, and only successful delivery marks the captured revision exported.
- [ ] Compose host Effects directly when ticket 05 has landed. If it has not, retain only the existing host-boundary adaptation needed until that ticket; do not gate the database/store migration on host work or add a new compatibility framework.
- [ ] Remove the store's obsolete database/Promise adaptations as their callers migrate. Keep query construction, result normalization, history calculation, and serialization as ordinary functions.
- [ ] Existing Working CSV, lifecycle, editing, reopen/disposal, and diagnostics behavior passes on both native DuckDB and DuckDB-Wasm without weakened assertions. Adapt fixtures and test drivers as needed. Type and lint checks pass.
- [ ] Use the verification skill on desktop and web to open a CSV Source, search/filter, edit cells, attempt a blank column rename, undo/redo, export, and close. Confirm messages, data, and edit diagnostics.
- [ ] If the Working CSV store grows, explain the reason in ticket comments.

