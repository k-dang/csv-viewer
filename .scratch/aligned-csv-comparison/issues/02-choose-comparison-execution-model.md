Parent: [Find the Way to an Implementation-Ready Aligned CSV Comparison Specification](../map.md)
Type: prototype
Status: resolved
Blocked by: None

# Choose the Comparison Execution Model

## Question

Which DuckDB-backed execution model should produce Valid Comparison Key diagnostics, result summaries, changed-column summaries, and bounded result windows while preserving previous results across refresh cancellation or failure?

Build a throwaway logic prototype comparing materialized snapshot tables, reusable views or query builders, and other plausible local designs. Exercise exact null and empty-string behavior, composite keys, duplicate and blank key diagnostics, reordered schemas, edits and deletes in both Working CSVs, large row counts, cancellation limits, cleanup, and deterministic key ordering.

## Comments

### Resolution

Use staged, materialized DuckDB result snapshots produced on dedicated worker connections. The executable prototype is [duckdb-execution-prototype.mjs](../prototypes/duckdb-execution-prototype.mjs); it passed against the installed `@duckdb/node-api` version with all four row classifications, reordered columns, composite and invalid keys, exact null/empty/case behavior, source edits/deletes, a 100,000-row snapshot, a bounded 200-row window, worker interruption, owner-connection survival, and cleanup.

#### Why this model

- A reusable live view changed under Working CSV edits and therefore could not preserve Outdated results.
- Re-running a query builder for each summary and window could observe different Working CSV revisions, repeats the full join, and cannot preserve old cell values.
- Materializing separate input snapshots preserves values but duplicates both inputs and still repeats classification work for windows and summaries.
- A materialized aligned result is the smallest tested model that makes the applied key/results an immutable pair, supports cheap bounded reads, preserves the prior result during replacement, and keeps the full dataset out of renderer memory.

#### Snapshot shape and computation

- Each successful generation owns one DuckDB table with one row per unioned Comparison Key. It stores classification, Baseline/Candidate internal row identifiers, key values once, both exact `VARCHAR` values for every non-key column, and a changed boolean per non-key column.
- Compatibility and projections are name-based. Presentation column order starts from Baseline column order even when Candidate table order or inferred types differ.
- Key validation runs before materialization over visible Working CSV rows (`__deleted = false`). Every key part must be non-null and non-empty, and each composite value must occur once per source. Diagnostics include total blank rows, duplicate-group count, and bounded examples; no automatic key inference occurs.
- Matching uses equality on every validated key part. Cell equality uses DuckDB `IS NOT DISTINCT FROM` semantics over the stored all-`VARCHAR` values: null equals null, null differs from empty string, case and whitespace differences remain differences.
- Classification is derived from row presence and any non-key changed flag. A key-only schema therefore yields only Unchanged/Baseline-only/Candidate-only rows.
- The module aggregates row and per-column summaries once from the staged table, then retains the small summary in comparison-session state. Windows query the table with a hard maximum limit and deterministic key-column ascending binary order.
- Differences/All rows is a bounded table predicate. Changed/All columns is projection metadata and does not cause a new comparison generation.

#### Generations, revisions, and atomic replacement

- Every Working CSV session needs a monotonic data revision incremented after successful edit, insert, delete, undo, redo, and session replacement. Sort, filter, search, Stats state, Save As, and tab activation do not increment it.
- Apply key/Refresh captures both source session IDs and revisions. It creates a uniquely named staging table and summary without touching the active snapshot.
- Before commit, it rechecks both source identities/revisions. If either changed, the staging table is discarded and the operation reports `sources-changed`; it never publishes a result that was already outdated at creation.
- Success atomically replaces the comparison session's active table pointer, applied key, captured revisions, and summary, then drops the prior table. Failure, invalidity, cancellation, or `sources-changed` drops only staging artifacts.
- One comparison generation may run per Comparison Tab. A new Apply/Refresh request is rejected while one is active; the user cancels first rather than silently superseding work.

#### Cancellation and isolation

- Each active generation uses a dedicated DuckDB connection to the same instance that owns the Working CSV tables. Calling `interrupt()` cancelled the prototype's long query while a separate owner connection remained usable.
- The connection is never shared with CSV row windows, edits, other Comparison Tabs, or active-result reads. Cancellation is idempotent and operation-token scoped so a late Cancel cannot interrupt a later generation.
- Validation and materialization report coarse phases (`validating`, `comparing`, `summarizing`) rather than fabricated percentages. DuckDB progress may be surfaced only when it is finite and monotonic.
- After interrupt/error, the worker connection and staging table are disposed. The active snapshot remains queryable through a separate read connection.

#### Lifecycle and limits

- The renderer receives only metadata, summaries, diagnostics with bounded examples, and row windows of at most 1,000 rows. It never receives or owns a complete snapshot.
- Closing a Comparison Tab cancels its generation, drops staging and active tables, and releases its connections. Closing a source is blocked by the dependent-close contract until its comparisons are closed.
- Startup has no comparison restoration requirement: Comparison Tabs are process-lifetime workspaces backed by in-memory Working CSVs.
- DuckDB out-of-memory, interrupt, missing-source, invalid-key, and internal-query failures are normalized into typed module outcomes; raw SQL and table names never cross the module seam.
