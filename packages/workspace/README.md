# Workspace resource ownership

Every `CsvViewer` request runs as an Effect through one shared entry adapter. `CsvViewer` remains the promise and event boundary for desktop IPC and the web renderer. Requests use the workspace runtime's services but not its scope, so disposal settles admitted work by the rules below instead of interrupting it. Background Comparison work belongs to the workspace scope.

## Coordination

Working CSV work coordinates through three primitives in the store:

- **Lease.** One scoped Effect leases a Working CSV's current table for reads, export serialization, mutations, reopen, and Comparison sources. Each table keeps an explicit lease count. Closing a Working CSV waits until no lease holds its current table. The last release of a retired table drops it. If that drop fails, the releasing operation reports `cleanup-failed` and the table stays registered for close or disposal to retry.
- **Mutation queue.** Cell edits, row and column edits, undo, redo, and reopen run one at a time per Working CSV, in call order. A mutation takes its lease and its queue position when the request starts, so a close waits for queued work. When its turn begins, it resolves the current Working CSV state, so work queued behind a reopen runs against the replacement. Reads stay off the queue and run concurrently.
- **Admission.** Opens, reopens, and Comparison worker connections hold an admission until their scope closes. Disposal stops new admission and waits for admitted work before it releases tables and closes the database.

## Open and reopen

An open operation reserves a Working CSV table as a staging artifact before loading the CSV Source. Its scoped finalizer drops that table unless publication marks it current. If a drop fails, the artifact stays registered so workspace disposal can retry it. The admission covers the Recent CSV Source write, so disposal waits for accepted opens.

Reopen prepares a new table, columns, row count, and fresh edit history before publication. The synchronous publication point changes artifact roles and replaces the complete Working CSV state. It advances the data revision once, and the queue then notifies dependent Comparisons. A publication error restores the old state and roles before the staging finalizer runs. The previous table stays retired until its admitted readers release their leases. A failed physical deletion leaves it registered for close or disposal to retry; the committed reopen still returns `opened`.

## Diagnostics

Each request logs a stage named after its operation, such as `csv.get-rows`, `csv.edit-cell`, or `csv.reopen`. Child stages cover source description, table preparation, source access and load, metadata, queue waits (`csv.queue-wait`), lease releases (`csv.release-lease`, `csv.release-retired`), and staging release. Log records carry opaque workspace, request, Working CSV, and Comparison identifiers, stage timings, product outcomes, and cleanup results. Source names, locations, column names, cell values, search and filter text, SQL, and driver errors are excluded. See [Read diagnostics](../../.agents/skills/verify-csv-viewer/SKILL.md#read-diagnostics) for desktop and web capture commands.
