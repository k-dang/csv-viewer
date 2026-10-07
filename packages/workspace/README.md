# Workspace resource ownership

This package implements the `CsvViewer` workspace that desktop and web share. This page explains who owns each resource, how concurrent work coordinates, and how failures travel.

## Requests run as Effects behind one adapter

`CsvViewer` is the Promise and event boundary for desktop IPC and the web renderer. Behind it, every request runs as an Effect through one shared entry adapter. The adapter converts Effects to transport Promises, owns the startup and disposal runners, and translates each `Exit` and `Cause` into a public result.

Requests use the workspace runtime's services but not its scope. Disposal therefore settles admitted requests by the rules below instead of interrupting them. Background Comparison work belongs to the workspace scope.

Workspace services compose Effects directly. Promises appear only at runtime edges:

- Hosts keep the Promises for filesystem access, browser file reads, and prompts inside themselves.
- Database adapters call the driver through the shared `driverEffect` helper, which classifies its failures once. Acquisition and release are scoped Effects.
- The web database exposes buffer registration and release as Effects. The host composes them into scoped CSV Source access.

The database adapter keeps any buffer whose drop failed and retries the drop before the next registration. Engine termination releases the remaining buffers. The shared engine-source helper accepts Effects and manages only source lifetime and cleanup diagnostics.

Reusable multi-step Effect functions in Working CSV, table operations, request dispatch, and Comparison use `Effect.fnUntraced`. They attach `scoped`, `uninterruptible`, and diagnostic stages as function-level transforms. The entry adapter and the existing stages already supply tracing. Inline workflows and callbacks use `Effect.gen`. Simple forwarding helpers and helpers that only combine Effects stay plain functions.

## Failures are tagged, defects are not

Runtime hosts return Effects and classify platform failures at their edges. An expected source-access problem or request rejection is a typed failure. An unexpected platform exception is a defect.

Declared failures are tagged errors, so an ordinary `Error` can't satisfy them:

- `WorkspaceRequestError`
- `CsvSourceUnavailableError`
- `DataEngineError`

Working CSV and request dispatch name these failures in their error channels. Database and connection methods fail with `DataEngineError`. A failed Comparison release travels as a `ComparisonCleanupError` defect, and a failed database release as a `DatabaseReleaseError` defect. Diagnostics report both as `cleanup-failed`.

Pure query construction, history calculation, and CSV serialization stay ordinary functions. View preparation composes the serializer in yielding batches. Expected validation problems return a `Result` or a typed Effect failure. Broken invariants are defects.

Comparison keeps request failures as request failures:

- Source leases and worker admission keep a `WorkspaceRequestError` instead of classifying a lifecycle rejection as an engine failure.
- When a request failure is the only failure, the attempt settles as `source-unavailable`.
- Snapshot availability guards also reject with request failures.
- Internal Comparison closes keep the original typed failure or defect through dependent-source close and disposal.
- Only the public Comparison close maps a cleanup failure to its sanitized result. No `Cause` crosses the renderer boundary.
- When both the operation and its cleanup fail, the result reports both.

## Resource lifetimes follow one Layer

Each runtime builds the workspace with `createCsvViewer`. It builds one Layer in acquisition order: first the database and the runtime's host, then the Working CSV, Comparison, and diagnostics services that depend on both.

Each capability module owns its service tag, interface, and Layer:

- `database.ts` acquires and releases the database.
- `working-csv-store.ts` builds the Working CSVs. It also builds the DuckDB Comparison executor, which shares their leases, admission, and artifacts.
- `csv-comparison-service.ts` builds Comparisons on top of those and owns the finalizer for their data-change subscription.

The runtime supplies its host. Tests can supply their own Comparison executor. `workspace-runtime.ts` composes the Layers. Implementation classes stay private to their modules.

The database acquires its engine and owner connection eagerly, in a scope. Each runtime's database either registers a release step with `releaseOnClose` before it can hold the matching resource, or acquires the resource with `acquireWithRelease`, which registers its release with no interruptible gap. A failed or interrupted acquisition therefore releases exactly what it acquired, through the same `workspace.release-database` stage as disposal. The workspace exists only after acquisition succeeds. Release steps run in reverse order: the owner connection closes first, then the engine.

Disposal runs in this order:

1. Stop admission.
2. Settle Comparisons.
3. Release every Working CSV table.
4. Retry failed export worker releases.
5. Close the runtime scope once, which releases the database.

Each Working CSV close waits for that Working CSV's leases. Disposal attempts every close even after one fails. A failed close or retry doesn't skip the worker retries or the database release.

After an engine stop, disposal interrupts and settles Comparison attempts and admitted closes while their source projections still exist. It then forgets source state without starting database cleanup. Attempt completion records the settlement's full `Exit`, so a projection defect rejects waiters instead of leaving them pending.

A failed release step fails the scope close, which rejects disposal, and every later call returns the same rejection.

## Three primitives coordinate Working CSV work

The store coordinates Working CSV work with a lease, a mutation queue, and admission.

- **Lease.** One scoped Effect leases a Working CSV's current table. Reads, export serialization, mutations, reopen, and Comparison sources all take a lease. Each table keeps an explicit lease count. Closing a Working CSV waits until no lease holds its current table or its retired tables. The last release of a retired table drops the table. If that drop fails, the releasing operation reports `cleanup-failed`, and the table stays registered for close or disposal to retry.
- **Mutation queue.** Cell edits, row and column edits, undo, redo, and reopen run one at a time per Working CSV, in call order. A mutation takes its lease and waits for that CSV's semaphore permit when the request starts, so a close waits for queued work. When its turn comes, the mutation reads the current Working CSV state, so work queued behind a reopen runs against the new table. View export also reserves a turn to capture consistent rows and metadata. The lock stays registered until its holder and all waiters have left. Other reads skip the queue and run concurrently.
- **Admission.** An open or reopen holds an admission until its scope closes. A Comparison worker connection holds one only while it connects. Comparison disposal closes open worker connections before the store releases tables. Disposal stops new admissions and waits for admitted work before it releases tables and the database.

## Cancellable queries wait for the driver

Interrupting a cancellable query requests cancellation, then waits for the driver to settle. Other database operations stay uninterruptible until they settle. A failed worker release produces a `cleanup-failed` diagnostic, and the worker stays available for disposal to retry.

Complete export holds its table lease and a scoped worker connection while it reads and serializes. It releases both before the host delivers the file. Only successful complete delivery marks the captured revision as exported.

View export holds its mutation turn, lease, and scoped worker through reading an immutable row/metadata snapshot. It releases them before serializing in cancellable batches and delivering the file. View export leaves history unchanged. Close, reopen, and disposal cancel preparation; prepared delivery keeps its captured contents and source identity independently of the source tab.

If a worker release fails, either export rejects before delivery, and the store keeps that worker until a release succeeds.

## Open and reopen publish atomically

An open reserves a Working CSV table as a staging artifact before it loads the CSV Source. Inside that scope, it acquires an engine-readable source reference, loads the table, and releases the reference. If the source release fails, the open reports a cleanup failure but keeps the loaded Working CSV.

The open reserves the selected CSV Source with Effect finalization. The reservation moves to the Working CSV only after a successful open. A failed result or a defect releases it. The staging finalizer drops the table unless publication marks it current. If the drop fails, the artifact stays registered so workspace disposal can retry it. The admission also covers the Recent CSV Source write, so disposal waits for accepted opens.

Reopen prepares a new table, its columns, its row count, and a fresh edit history before publication. Publication is one synchronous step. It changes artifact roles, replaces the complete Working CSV state, and advances the data revision once. The queue then notifies dependent Comparisons. If publication throws, it restores the old state and roles before the staging finalizer runs.

The previous table stays retired until its admitted readers release their leases. If its physical deletion fails, it stays registered for close or disposal to retry. The committed reopen still returns `opened`.

## Diagnostics name stages, never data

Each request logs a stage named after its operation, such as `csv.get-rows`, `csv.edit-cell`, or `csv.reopen`.

Workspace stages cover database acquisition and release: `workspace.acquire-database` and `workspace.release-database`. Each release step logs `workspace.close-database-connection` and `workspace.close-database-engine`.

Child stages cover:

- source description
- table preparation
- source access and load
- engine source release (`csv.release-engine-source`)
- metadata
- queue waits (`csv.queue-wait`)
- lease releases (`csv.release-lease` and `csv.release-retired`)
- staging release

Log records carry opaque workspace, request, Working CSV, and Comparison identifiers. They also carry stage timings, product outcomes, and cleanup results. They never carry source names, locations, column names, cell values, search or filter text, SQL, or driver errors. For desktop and web capture commands, see [Read diagnostics](../../.agents/skills/verify-csv-viewer/SKILL.md#read-diagnostics).
