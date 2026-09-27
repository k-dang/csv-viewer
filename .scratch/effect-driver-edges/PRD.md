Status: ready-for-agent

# Effect at the driver edges: no Promise adapters inside the workspace

**Blocked by:** `.scratch/effect-resource-lifetimes/PRD.md`. That spec changes the database and host interfaces: it removes `close` and `isOpen`, adds the fatal-stop signal, and makes engine source access scoped. This spec changes the same interfaces again. Do the lifetime change first, so that each diff has one kind of risk.

## Problem Statement

The workspace runs every CsvViewer request as an Effect, but the work inside most requests is still Promise code. The Working CSV store's read and edit bodies are `async` functions. They call promise-returning table helpers, which call promise-returning database methods. The store adapts each body into Effect with `attempt`. The Comparison executor has its own adapters: `databaseEffect`, `cleanupEffect`, and `comparisonQuery`. Both database adapters wrap every driver call in `normalizeDatabaseOperation`.

For a maintainer, this causes the following problems:

- **Failures are classified again at each call site.** A Promise can reject with any value, so every adapter into Effect must decide again whether a thrown value is an expected failure or a defect. `attemptWorkspacePromise` and `attemptWorkspaceSync` check `instanceof` against a list of known classes. The driver edge already knows the answer, and the call site discards it.
- **Throwing inside Effect code creates defects silently.** Validation throws `WorkspaceRequestError` from pure helpers such as unknown-column, missing-row, and no-undo checks. That is correct inside an `async` body behind `attempt`. The same throw inside `Effect.gen` becomes a defect, and the user then sees the generic message in place of the validation message. The Comparison executor's key validation already calls `assertKnownColumn` inside Effect code. The sanitized-failure work had to design around this pattern, and each new Effect body can bring it back.
- **The interruption guarantee depends on the caller.** Interrupting a wrapped Promise does not stop DuckDB work. Only Comparison queries go through `comparisonQuery`, which cancels and awaits the driver. Other database calls have no stated rule for interruption. They are safe today only because nothing interrupts them.
- **Error normalization exists in three places.** `normalizeDatabaseOperation` in the adapters, `databaseEffect` in the Comparison executor, and the `catch` of `comparisonQuery` all map driver errors to `DataEngineError`.

The user sees nothing today. The cost is maintenance, and a failure message can change silently: a validation message becomes the generic message when a helper moves from Promise code to Effect code.

## Solution

Move the boundary between Promise and Effect to the runtime adapters. The database and host services return Effects with typed failures. Each adapter classifies driver and platform errors once, where it has the information. The workspace package then has no adapter from Promise to Effect. The only Promise boundary left in it is the shared entry adapter, which converts a request's Effect into the transport Promise.

The database interface states its interruption rule. Interrupting a cancellable query cancels the driver work and waits for it to stop. A non-cancellable query cannot be interrupted before the driver settles. This rule protects every caller, not only the Comparison executor.

Pure functions that reject expected input return a failure value and do not throw. A throw inside Effect code then always means a broken invariant, and a defect is the correct result.

Users keep every result, event, and message.

## User Stories

1. As a maintainer, I want the database methods to return Effects with a typed engine failure, so that no workspace call site must decide again what a rejection means.
2. As a maintainer, I want each database adapter to normalize driver errors in one place, so that driver messages cannot reach the workspace unsanitized.
3. As a maintainer, I want the host methods to return Effects with typed failures, so that the host decides what an expected failure is from the platform error it received.
4. As a maintainer, I want the workspace package to have no Promise-to-Effect adapter, so that I cannot choose a wrong adapter when I add a request.
5. As a maintainer, I want the shared entry adapter to be the only Promise boundary in the workspace, so that I can find the conversion to the transport in one place.
6. As a maintainer, I want the Working CSV store's read and edit bodies written as Effects, so that validation, database work, and edit history compose in one model.
7. As a maintainer, I want the table helpers written as Effects, so that the store composes them without adapters.
8. As a maintainer, I want pure validators to return a failure value, so that moving one into Effect code cannot turn a validation message into a defect.
9. As a maintainer, I want a throw inside Effect code to mean only a broken invariant, so that each defect in diagnostics points to a bug.
10. As a maintainer, I want the database interface to state what interruption does, so that I can interrupt any database Effect without releasing a table that a query still uses.
11. As a maintainer, I want interrupting a cancellable query to cancel the driver work and wait for it to stop, so that dependent resources are released only after the driver stops.
12. As a maintainer, I want a non-cancellable query to finish before interruption completes, so that cleanup cannot remove a table that the query still reads.
13. As a maintainer, I want the Comparison executor to use the database interface's cancellation directly, so that it does not need its own query adapter.
14. As a maintainer, I want Comparison cleanup failures to keep their own classification, so that diagnostics still report `cleanup-failed` separately from the Comparison outcome.
15. As a maintainer, I want Export CSV to read through a worker connection that closes in a scope finalizer, so that a failed export releases its connection the same way a Comparison does.
16. As a maintainer, I want pure query construction, edit-history calculation, and serialization to stay ordinary functions, so that the conversion does not wrap code that has no effects.
17. As a maintainer, I want the conversion to delete the adapters it replaces, so that I do not maintain two ways to call the database.
18. As a maintainer, I want the shared contract suites to pass without changes, so that I know the conversion kept behavior on both runtimes.
19. As a user, I want every validation message I see today to stay the same, so that the conversion does not change what I read.
20. As a user, I want unexpected engine failures to keep showing the generic message, so that I do not see engine details.
21. As a user, I want Comparison cancellation to stop database work as it does today, so that later operations stay reliable.
22. As a user, I want open, reopen, reads, edits, undo, redo, Export CSV, Comparison, close, and quit to keep their results, so that this change does not affect my work.
23. As a desktop user, I want dropped-file and missing-file messages to stay the same, so that the host conversion does not change them.
24. As a web user, I want capacity messages and the unreadable-source message to stay the same, so that the host conversion does not change them.

## Implementation Decisions

### Database interface

- The query methods of the database and its connections return `Effect<A, DataEngineError>`: `run`, `readObjects`, their cancellable variants, and opening a worker connection. Closing a worker connection returns an Effect that fails with `DataEngineError`.
- The shared database module exports one helper that runs a driver Promise and maps any rejection to `DataEngineError`. Both adapters use it. It replaces `normalizeDatabaseOperation`, the Comparison executor's `databaseEffect`, and the error mapping in `comparisonQuery`.
- **Interruption rule, stated on the interface:**
  - A cancellable query is interruptible. Interruption asks the driver to cancel and completes only after the driver's pending Promise settles. The current `comparisonQuery` behavior moves into the adapters.
  - A non-cancellable query is uninterruptible from start to driver settlement.
  - `cancelRunning` leaves the public interface, because cancellable queries now handle cancellation themselves.
- Worker connections keep their current ownership. The Comparison executor keeps its failed-worker retry map, and callers still own each connection's release. This spec changes only the release's return type.
- Result normalization (`normalizeRow`, `normalizeCount`, `normalizeCellValue`) stays pure. Its throws are invariant checks and remain defects.

### Host interface

- The host methods that do work return Effects: source selection, description, Recent CSV Sources read and write, discard confirmation, and export delivery. Expected failures are typed as `CsvSourceUnavailableError` or `WorkspaceRequestError`.
- Each host implementation maps its platform errors explicitly. Desktop maps filesystem errors from `stat`, reads, and writes to `CsvSourceUnavailableError` as it does today. Web maps a failed `File` read to the existing unreadable-source error. Any other error is a defect. Do not classify errors by message text or by a generic `instanceof` list.
- Prompts stay Promise-based inside each host implementation (Electron dialogs, `window.confirm`, and the portable file picker). Each host implementation adapts its prompts once.
- The desktop dropped-source entry keeps its current IPC response translation. It calls the host's Effect method and keeps its sanitized messages.

### Working CSV store and table helpers

- The table helpers become functions that return Effects. Create, drop, reading columns and row count, cell reads and writes, row deletion and insertion, column changes, reading export rows, and replaying an edit command all compose database Effects. Their expected failures, such as missing rows and unknown columns, are typed failures.
- `read`, `edit`, and the mutation queue take Effect bodies. Lease and queue rules do not change.
- Validation inside store bodies uses typed failures: the lifecycle and lookup checks, the edit checks, and the maximum row-window limit. Keep every message.
- Export CSV reads rows through a worker connection acquired with `acquireRelease`, which replaces the current `try` / `finally`.
- Delete `attempt`, `attemptWorkspacePromise`, `attemptWorkspaceSync`, and the cause-classification helper from the workspace package. Delete `toError` if nothing calls it after the change.

### Pure validators

- Pure functions that reject expected input return an Effect `Result` and do not throw. This covers the unknown-column check and the empty-row-selection check in query construction, and the no-undo and no-redo checks in edit history. Effect code yields the `Result` or converts it with `Effect.fromResult`. Confirm the exact API in the installed source.
- Throws for broken invariants stay throws: exhaustive-switch fallbacks, lease and dependency invariant violations, and invalid engine results. Inside Effect code they become defects, which is the intended result.
- Audit every throw site that Effect code can reach, and give each one exactly one of these two classifications. The Comparison executor's key validation, which calls the unknown-column check inside Effect code, is one known case.

### Comparison executor

- Use the database interface's cancellable queries directly and delete `comparisonQuery` and `databaseEffect`.
- Keep `ComparisonCleanupError` and the cleanup-failure classification. Cleanup Effects map a `DataEngineError` failure to that class, as `cleanupEffect` does today for rejections.
- Keep the executor's reader and snapshot bookkeeping unchanged.

### Entry adapter and diagnostics

- The shared entry adapter keeps its translation from `Exit` and `Cause`. It is the only Promise boundary in the workspace package. The desktop IPC wiring is unchanged.
- Stage names, outcomes, the privacy allowlist, and cleanup reporting do not change. This spec does not add stages.

### Documentation

- Update the workspace package README to state where Promises are allowed: inside runtime adapters and at the entry adapter. Replace comments that describe Promise adapters or `normalizeDatabaseOperation`.
- Update the interruption comment on the database interface so it describes the rule for both query kinds.

## Testing Decisions

- A good test asserts request results, events, messages, released resources, and diagnostic meaning. It does not assert that code uses a particular Effect combinator, or how many adapters exist.
- **Primary seam: the shared CsvViewer contract suites** on native DuckDB and DuckDB-Wasm. Every existing case must pass unchanged, including the diagnostics cases for expected failures and defects. Those cases assert expected synchronous and Promise failures by message and classification, not by adapter kind, so they stay valid after the adapters are removed.
- Add one contract case only if the throw-site audit finds an expected failure that surfaces as a defect today, such as an unknown column in a Comparison Key. That case asserts the existing validation message or declared outcome.
- **Secondary seam: the native and Wasm adapter tests.** Extend them to prove the interruption rule on real drivers:
  - Interrupting a long cancellable query cancels it, waits for the driver to settle, publishes no table, and leaves the connection usable. This extends the existing cancellation tests.
  - Interrupting a non-cancellable query completes only after the driver settles.
  - A driver error surfaces as `DataEngineError` with the sanitized message and no driver text.
- The Comparison executor tests that use controlled executors and driver cancellation keep passing. Move any assertions about `comparisonQuery` to the adapter tests.
- The existing desktop host, web host, and IPC tests keep covering host classification: dropped files, missing files, capacity, and the unreadable source. Update them for Effect-returning methods without weakening their assertions.
- Use synchronization barriers, not sleeps, for interruption timing.
- With the verify skill, on desktop and web: open a CSV Source, search and filter, edit cells, rename a column to a blank name, undo and redo, export, run and cancel an Aligned Comparison, and close. Confirm the messages and results match the current behavior, and read the diagnostics for the edit and the cancellation.
- Run the required type, lint, and test checks, and the desktop and web builds.

## Out of Scope

- Changes to lease, mutation queue, admission, or artifact registry rules.
- Changes to public requests, results, events, capabilities, or messages.
- Converting pure query construction, result normalization, edit-history calculation, or serialization to Effect.
- Effect in the renderer or React state, and Effect RPC.
- Changes to resource lifetimes. The lifetimes spec owns them.
- New diagnostic stages or outcomes.
- An Effect version upgrade. Use the installed `effect` 4.0.0-rc.115 as the API authority.

## Further Notes

This spec completes the Effect migration of the workspace package that earlier Effect work started. After this spec, each boundary in the package has one job:
- The runtime adapters own the drivers and the platform, and classify their failures.
- The workspace composes Effects.
- The entry adapter converts results and failures for the transport.

The earlier Effect work told edit bodies to keep calling promise-returning table helpers, to keep that migration small. This spec reverses that decision on purpose. With resource lifetimes owned by the runtime, the remaining Promise code is the call path to the driver, and it is now the main source of misclassified failures.

Expected deletions: `attempt`, `attemptWorkspacePromise`, `attemptWorkspaceSync`, the cause-classification helper, `normalizeDatabaseOperation`, `databaseEffect`, `comparisonQuery`, and `cancelRunning` from the public interface. If the Working CSV store gets longer, explain why in the ticket comments.

## Comments
