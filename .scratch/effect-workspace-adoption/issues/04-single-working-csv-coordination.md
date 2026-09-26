Status: ready-for-agent

# 04 - Consolidate Working CSV coordination and observe every request

**What to build:** Every Working CSV operation uses one Effect mutation queue and one scoped lease. Reopen and edits no longer coordinate through a shared map of promises. Every CsvViewer request runs through the shared entry adapter, so a maintainer can follow a read, edit, undo, redo, export, or close request with the same correlated diagnostics that open, reopen, and Comparison already have.

**Blocked by:** None. 03 - Migrate CSV open/reopen to observable Effect workflows is complete.

This ticket completes the parent spec's rule that each increment deletes the orchestration it replaces (user story 24). Ticket 03 migrated reopen but bridged it to the promise-based mutation queue. The store now has two mutation paths, `withWorkingCsvMutation` and `withWorkingCsvMutationEffect`, sharing `mutationQueues`, and two lease release paths, `releaseLeaseAndReport` and `releaseReopenLease`. A change to ordering or cleanup has to be made twice, and missing one corrupts rows or edit history.

- [ ] Run every Working CSV mutation through one Effect-based queue per Working CSV: cell edit, row delete and insert, column rename, insert, and delete, undo, redo, and reopen. Keep the existing rules. One mutation runs at a time. Reads stay off the queue and run concurrently. An admission lease makes close wait for queued work. A queued mutation resolves the current Working CSV state when its turn begins, so work queued behind a reopen runs against the replacement.
- [ ] Reopen reserves its queue position at admission, as it does today, through the same queue edits use. Delete `mutationQueues`, `withWorkingCsvMutation`, and the `previous` and `settled` fields of `ReopenAdmission`.
- [ ] Acquire and release Working CSV leases through one scoped Effect used by reads, export serialization, mutations, reopen, and Comparison sources. Keep the explicit reference counts and retirement rules. When the last release of a retired table fails to drop it, report the failure against the releasing operation and keep the table registered for close or disposal retry. Delete `withWorkingCsvLease`, `releaseLeaseAndReport`, and the duplicate reopen release path.
- [ ] Replace `sourceLeaseWaiters`, `workspaceWorkWaiters`, and `activeWorkspaceWorkCount` with Effect primitives that give the same guarantees. Close waits for admitted leases on the current table. Disposal waits for admitted open, reopen, read, and edit work.
- [ ] Make close and store disposal Effects and compose them directly in workspace close and disposal. Remove the `Effect.tryPromise` wrapper around `disposeStore`. Keep the disposal order, idempotency, and failure aggregation.
- [ ] Hand the Comparison executor a lease Effect in place of the promise-returning `release` callback from `acquireComparisonSource`.
- [ ] Dispatch every CsvViewer request through the shared entry adapter with a span named after its operation, such as `csv.get-rows` or `csv.edit-cell`. Attach workspace, request, and Working CSV identifiers where the request has them. Record the product outcome and cleanup result. Show queue wait and lease release as child stages so a stuck edit shows which one it is waiting on. Do not add per-row or per-cell spans.
- [ ] Keep public results and rejections unchanged. Edit validation failures still reject with their current messages. Diagnostics classify them as recoverable failures. Typed errors belong to the CsvViewer contract spec, not this ticket.
- [ ] Replace the remaining `console.error` calls in the workspace package with configured diagnostic output that carries only normalized fields. This covers the data-change listener failure and the Comparison that disappears while close impact is calculated.
- [ ] Apply the existing privacy allowlist. Cell values, column names, search text, filter values, source names and locations, SQL, and driver errors stay out of diagnostic output.
- [ ] Keep query construction, edit-history calculation, and serialization as ordinary functions. Edit bodies can keep calling promise-returning table helpers, adapted where the queue composes them. Do not wrap pure helpers in Effect.
- [ ] Update `packages/workspace/README.md`, the queue and lease comments, and the verify skill's diagnostics section to describe one coordination model. Regenerate the `.agents` mirror of the verify skill.
- [ ] Run the existing editing, Working CSV, and lifecycle contracts against native DuckDB and DuckDB-Wasm without weakening assertions. They already cover concurrent mutation ordering, close waiting for queued work, and disposal waiting for admitted work.
- [ ] Add contract cases only for guarantees they do not already cover. The likely gaps are an edit queued behind a reopen that resolves the replacement state, and a read admitted before reopen that finishes against the retired table while a later edit uses the replacement. Use synchronization barriers, not sleeps.
- [ ] Extend the diagnostics contract with a read, an edit, an undo, an export, and a close. Verify correlation, outcome classification, the queue-wait stage for an edit queued behind another mutation, and exclusion of sentinel cell values, column names, and search text.
- [ ] On desktop and web, use the app verification skill to edit cells, undo and redo, reopen with changed dialect options while edits are queued, and close. Inspect the local diagnostic output for those requests. Run the required type, lint, and test checks.

**Completion evidence:** The store has one mutation queue, one lease primitive, and no hand-written waiter arrays. Every CsvViewer request produces a correlated span with its outcome. The shared contracts pass unchanged on both runtimes. `working-csv-store.ts` should get shorter. If it grows, the ticket comments explain why.

## Comments
