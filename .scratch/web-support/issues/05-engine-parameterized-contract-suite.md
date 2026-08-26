# 05 - Engine-parameterized behavioral contract suite

**What to build:** Parameterize and extend the existing native-DuckDB workspace verification into one extensive behavioral contract that runs against a CsvWorkspace produced by an injected **workspace factory**. The current `csv-workspace.comparison-verification.test.ts`, workspace, comparison-module, comparison-executor, artifact-registry, export, and renderer-state tests are the starting evidence, not a parallel suite to duplicate. A second engine can be added by supplying a second factory, without editing contract cases or expected results.

The parameterization point is the workspace factory, not a database interface - that interface does not exist yet and is extracted in ticket 06. This ticket must not require it or anticipate its shape.

**Blocked by:** 03 - Shared CsvWorkspace extraction. Informed by 00 - DuckDB-Wasm feasibility spike (cancellation granularity).

**Status:** done

- [x] The workspace contract covers CSV Source opening, dialect overrides, metadata, row windows, sorting, filters, search, Column Value Counts, edit operations, stable row identity, insert restrictions, deletion, undo, redo, Unexported Changes, export state, close impact, and resource release.
- [x] The comparison contract covers candidate discovery, Comparison-Compatible CSVs, Comparison Key validation, invalid-key diagnostics, execution, cancellation, summaries, row classifications, result windows, swapping, Outdated Comparison behavior, refresh, source closing, and artifact cleanup.
- [x] Export contract tests compare output bytes for headers, delimiters, quoting, null/empty values, edits, inserted rows, deleted rows, row order, and exclusion of internal columns.
- [x] Export-state tests prove export clears Unexported Changes without removing undo/redo, undoing away recreates them, and returning to the exported revision clears them, including the export-undo-different-edit case that distinguishes revision identity from stack depth.
- [x] Cancellation is asserted by observable outcome, not latency: a cancelled operation reports cancelled, publishes no result, and releases its artifacts. No case asserts that cancellation preempts an in-flight statement - that is a runtime capability, not contract behavior. The native suite has already had to remove one flaky real-interruption test and make another deterministic; these cases must be deterministic under cooperative statement-boundary cancellation before a second engine is wired in.
- [x] Tests assert observable domain behavior only - no private SQL helper structure, driver internals, or IPC details.
- [x] Existing literal comparison expectations and lifecycle assertions for cancellation, publication races, source close, read survival, artifact cleanup, and disposal are retained in the parameterized contract or in focused adapter tests at the appropriate seam.
- [x] Contract setup accepts a workspace factory fixture; the existing native-only construction through `new CsvWorkspace()` is removed from contract cases rather than copied into a second suite.
- [x] The suite passes fully against the native workspace factory, and adding a second factory requires no edits to contract cases or expected results.
