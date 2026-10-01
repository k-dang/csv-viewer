# 04 — Move Working CSV operations onto Effects

**What to build:** Open, reopen, reads, edits, undo/redo, Export CSV, close, and table cleanup compose database Effects throughout the Working CSV store. Users retain the same data, messages, events, edit history, and Unexported Changes behavior. Export reads through a worker connection whose scope releases it on success and failure.

**Blocked by:** 01 — Make expected validation failures explicit; 02 — Add Effect database operations on both runtimes.

**Status:** implemented � manual desktop export verification remains

- [x] Convert table creation and deletion, metadata reads, row and cell reads, cell writes, row insertion/deletion, column changes, export-row reads, and edit-command replay to Effects that compose the new database interface.
- [x] The store's read and edit helpers and mutation queue accept Effect bodies. Convert lifecycle cleanup, staging cleanup, and retired-table cleanup as well as successful request paths. Preserve leases, queue order, admission, publication/rollback rules, and artifact retry behavior.
- [x] Expected lifecycle, lookup, edit, missing-row, unknown-column, dialect, and maximum-row-window failures use typed failures with existing messages. Consume the query and history Results from ticket 01. Complete the store portion of its throw-site audit; broken invariants remain defects.
- [x] Undo/redo replay database work before committing history and metadata changes. Preserve schema restoration, row counts, revisions, and Unexported Changes semantics when replay succeeds or fails.
- [x] Export reads rows through a worker connection acquired with `acquireRelease`. Its connection closes on read or serialization failure as well as success, with cleanup reporting preserved. Export delivery remains outside the Working CSV lease, and only successful delivery marks the captured revision exported.
- [x] Compose host Effects directly when ticket 05 has landed. If it has not, retain only the existing host-boundary adaptation needed until that ticket; do not gate the database/store migration on host work or add a new compatibility framework.
- [x] Remove the store's obsolete database/Promise adaptations as their callers migrate. Keep query construction, result normalization, history calculation, and serialization as ordinary functions.
- [x] Existing Working CSV, lifecycle, editing, reopen/disposal, and diagnostics behavior passes on both native DuckDB and DuckDB-Wasm without weakened assertions. Adapt fixtures and test drivers as needed. Type and lint checks pass.
- [ ] Use the verification skill on desktop and web to open a CSV Source, search/filter, edit cells, attempt a blank column rename, undo/redo, export, and close. Confirm messages, data, and edit diagnostics.
- [x] If the Working CSV store grows, explain the reason in ticket comments.


## Comments

### Implementation (Issue 4)

Working CSV table helpers and store operations now compose the ticket 02 `*Effect` database methods directly. Read bodies and queued mutations take Effects; the redundant edit wrapper was removed after review. Staging, retired-table, close, and disposal cleanup preserve publication/rollback and artifact retry rules. The store has seven fewer lines than the baseline.

Expected lifecycle/lookup/edit/row-window failures use typed Effects. Query and history Results are consumed with `Effect.fromResult`; `requireColumnIndex` and dialect validation now return Results. The remaining store/table throws are broken invariants: publication rollback rethrows, disposal lease checks, exhaustive edit switches, and an invalid logical column position. Lease and normalization invariant failures remain defects. Source description and export delivery retain the existing host-boundary adaptation because ticket 05 has not landed. The comparison owner-connection legacy surface belongs to ticket 03.

Export acquires its worker with `acquireRelease` inside the table lease, reads and serializes within that scope, then releases the worker and lease before delivery. A typed release failure is carried past the scope and rejects export with the existing sanitized engine message, preserving Unexported Changes and history. It now marks enclosing cleanup failed instead of reporting successful cleanup. No diagnostic stage was added. The three added shared contract cases cover release after read/serialization failure and failed worker release, including retry, messages, history, and diagnostics on both drivers.

Validation: `pnpm test` passed 39 files / 520 tests. After removing the edit wrapper, the focused suite passed 9 files / 321 tests: desktop integration, Wasm CsvViewer contracts, web composition, Working CSV specs, and query specs. `pnpm run typecheck`, `pnpm run lint`, `pnpm run build:desktop`, and `pnpm run build:web` passed. Vite retains its existing bundle-size warning.

Live verification used the repository verification launcher and isolated profiles. Desktop: opened through Recent CSV Sources; searched and filtered; edited a cell; rejected a blank rename; undid/redid; reopened; closed. Recent identity was retained and fixture bytes were unchanged. Web: dropped a fixture through the UI in T3 preview; searched and filtered; edited; rejected a blank rename; undid/redid; exported; checked the generated download bytes contain the edit and Unexported Changes cleared; closed. Both edit diagnostics succeeded, and blank rename was recoverable-failure. Evidence is in `.agents/skills/verify-csv-viewer/evidence/issue-04/` (desktop snapshots/screenshots, web text/CSV/diagnostics). T3 preview snapshots failed repeatedly with `PreviewAutomationExecutionError`; web visual capture remains unavailable. Both launched instances were cleaned up.

The remaining unchecked verification is desktop's native Export CSV dialog. The verification skill explicitly requires a human to finish that OS dialog and says not to click it unattended. Native export behavior and bytes passed the shared contract suite with scripted desktop prompts; the actual OS dialog was not exercised.

### Standards review

No hard violations. One optional Middle Man finding: `edit` forwarded directly to `mutate` after its adapter was deleted. Resolved by calling `mutate` directly and deleting the wrapper; relevant checks rerun.

### Spec review

No actionable findings. Database/store migration, typed validation, queue and lease preservation, cleanup, replay commitment, scoped export serialization, and captured-revision delivery all match Issue 4. Remaining host and comparison adaptations match their separate migration tickets.

Review totals: Standards 0 remaining findings (1 optional cleanup resolved); Spec 0 findings. Manual desktop export and unavailable web screenshots are recorded above.

### Follow-up diff review

A subagent reviewed the diff against main and found one P2 in the earlier Wasm database migration: interruption during parameterized preparation could call `cancelSent` before execution started, then execute the statement afterward. The adapter now remembers cancellation per Effect execution and skips sending an interrupted prepared statement while still closing it. A real-driver test reproduced table creation after interruption before the fix and now verifies no table creation, statement release, and connection reuse. The subagent confirmed the fix with no remaining findings. `pnpm test` passed 39 files / 521 tests; typecheck, lint, and `git diff --check` passed.
