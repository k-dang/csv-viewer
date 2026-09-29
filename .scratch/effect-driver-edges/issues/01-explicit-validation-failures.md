# 01 — Make expected validation failures explicit

**What to build:** Expected input failures keep their validation messages when query construction, Comparison Key validation, and undo/redo run inside Effects. Pure validators return failure values instead of throwing. Undo and redo calculate the next command separately from database replay, and commit history only after replay succeeds.

**Blocked by:** None — can start immediately. The resource-lifetime changes are implemented; remaining web UI verification is carried into ticket 06.

**Status:** ready-for-agent

- [x] Confirm the `Result` and Effect conversion APIs in the installed `effect` 4.0.0-rc.115 source. Do not upgrade Effect.
- [x] Unknown-column and empty-row-selection validation return `Result`. Propagate failures through affected query builders and callers without changing SQL, request results, or validation messages. Query construction remains ordinary synchronous code.
- [x] No-undo and no-redo checks return `Result` with their existing messages. Separate pure history calculation and commitment from asynchronous command replay; a replay failure leaves the history stacks and revision identity unchanged.
- [x] Update every affected caller, including Comparison Key validation. Effect callers place expected validation failures in the failure channel. Existing Promise callers remain functional during migration; no permanent duplicate validator or history API is introduced.
- [x] Audit every throw site reachable from Effect code and record its classification in ticket comments: expected input/platform failure or broken invariant. Identify remaining store and host conversions for tickets 04 and 05. Exhaustive-switch failures, lease/dependency invariant violations, and invalid engine results remain defects.
- [x] If the audit finds an expected failure currently surfacing as a defect, first reproduce it through the closest user-facing request path. Add one focused shared contract case asserting the existing validation message or declared outcome, including diagnostics classification where relevant. Do not add tests merely for the new return type.
- [x] Existing shared contract cases pass on native DuckDB and DuckDB-Wasm without changed behavioral assertions. Adapt affected unit tests to the value-returning API while retaining their behavioral coverage. Type and lint checks pass.

## Comments

- This is the prefactor for tickets 03 and 04. Follow the existing history semantics rather than adding a new state machine. Pure result normalization, edit-history calculation, and serialization stay ordinary functions.

### Implementation notes (ticket 01)

APIs confirmed in `effect` 4.0.0-rc.115: `Result.succeed/fail/void/fromNullishOr/map/all/gen/getOrThrow` (`getOrThrow` throws the failure value itself) and `Effect.fromResult`.

Converted to `Result`: `requireKnownColumn` (was `assertKnownColumn`), `requireRowIds`, and every query builder that reaches them (`buildRowsQuery`, `buildColumnValuesQuery`, `buildColumnValueCountsQuery`, `buildRowDeletionStatement`, `buildExistingRowIdsQuery`); `columnsAfter` (the rename case reuses `requireKnownColumn`); `CsvEditHistory.step(direction)`, which returns the command plus a `commit` the store calls after replay. A replay failure never reaches the commit, so stacks and revision are unchanged. Comparison `validateKey` yields the check through `Effect.fromResult`, and its error type now includes `WorkspaceRequestError`.

Promise callers (store bodies and table helpers) unwrap with `Result.getOrThrow` until ticket 04 converts them.

**Throw-site audit** (every `throw` under `packages/workspace/src`):

- Expected input failure, now a `Result` value: unknown column (filter, sort, requested column), empty row selection, no-undo/no-redo, unknown column when replaying a rename (`columnsAfter`).
- Expected input failure, still thrown inside Promise store bodies and table helpers, converted in ticket 04: every `WorkspaceRequestError` in `working-csv-store.ts` (lifecycle, lookup, edit checks, row-window limit, `requireColumnIndex`) and in `csv-working-csv-table.ts` (`readCellValue`, `assertRowsExist`, `resolveInsertionOrder`); `CsvOpenError` for a bad delimiter (`validateDialectOptions`).
- Expected platform failure, converted in ticket 05: host errors reach the store through `attemptWorkspacePromise`; `normalizeDatabaseOperation` in `database.ts` is ticket 02.
- Broken invariant, stays a throw (defect): exhaustive-switch fallbacks (`rowCountDelta`, `columnsAfter`, `runEditCommand`), `spliceColumn` index, comparison dependency/source/settlement/terminal invariants, executor snapshot/reader/release invariants and invalid classification, artifact registry invariants, source lease invariant during disposal, `normalizeRow`/`normalizeCount`, `validateKey` empty key (the service rejects an empty key first).
- Boundary rethrows, unchanged: `csv-workspace-implementation.ts` (transport translation) and the rollback rethrows in `working-csv-store.ts` (open/reopen).

**Expected failure surfacing as a defect:** only the Comparison executor's unknown Key column. It is not reachable through a request: the service checks the key against the current columns before starting, and a column change mid-run settles as `sources-changed` first. The user-facing outcome is `query-failed` either way, so no contract case was added. The diagnostics classification changes from `defect` to `recoverable-failure`, covered by a focused executor test.
