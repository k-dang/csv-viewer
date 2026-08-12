# 03 - Shared runtime-neutral CsvWorkspace extraction

**What to build:** Refactor the existing desktop `CsvWorkspace`, `WorkingCsvStore`, `CsvComparisonService`, `ComparisonExecutor`, and `WorkspaceArtifactRegistry` modules into one shared, runtime-neutral CsvWorkspace area. It owns Working CSV lifecycle, row windows, filtering, sorting, search, Column Value Counts, editing, history, Unexported Changes, export state, capacity-outcome types, and Aligned Comparison. Desktop still instantiates it in the main process and stays green.

"One workspace" names one contract and one owning area, **not one file**. `working-csv-store.ts` is already 1,176 lines and `csv-comparison-service.ts` is 857; this ticket must come out with smaller modules than it went in with, not a merged mega-module.

The internal database interface is deliberately **not** part of this ticket - it is extracted in ticket 06 alongside the second implementation that shapes it. Here, native DuckDB access is concentrated so that later swap is mechanical.

**Blocked by:** 01 - Desktop Export CSV corrections. Informed by 00 - DuckDB-Wasm feasibility spike (host interface shape).

**Status:** ready-for-agent

- [ ] Node-independent query construction, storage schema, edit history, comparison orchestration, and result normalization live in shared modules that import neither Electron nor Node filesystem primitives (enforced by a lint or build rule, not convention).
- [ ] **Decomposition, not consolidation.** `working-csv-store.ts` ends this ticket materially smaller than its current 1,176 lines, with source lifecycle/identity, query construction (extend the existing `csv-query.ts` rather than adding a near-duplicate), edit history, and export serialization in separate focused modules. No file in the shared workspace area exceeds 1,000 lines on completion.
- [ ] **Depth guardrail.** `CsvWorkspace` is the sole external domain seam and the shared behavioral test surface. Extracted modules remain internal implementation unless they independently pass the deletion test: removing one would spread meaningful complexity or invariants across multiple callers. No extraction may expose callers to orchestration order, edit stacks, revision bookkeeping, artifact transitions, SQL construction steps, or host/database-specific representations. Focused internal tests are reserved for adapter behavior or invariants that cannot be observed through the `CsvWorkspace` interface.
- [ ] **One host interface, not three.** CSV Source acquisition, export delivery, and Recent CSV Source access sit behind a single internal host interface shaped by the six Node-dependent call sites it replaces: source description (`working-csv-store.ts:314,322,355`), source identity (`:121-124`), source-to-SQL exposure (`:341`), byte delivery (`:592`), and the TSV default-delimiter lookup (`:1106`). It speaks CSV Viewer language and opaque source identity, never paths or browser handles.
- [ ] Native DuckDB access is confined to a small, named set of modules with the driver import appearing in as few files as possible, so ticket 06 can introduce the database interface behind them without touching workspace logic. Do not invent that interface here.
- [ ] Every operation on the workspace surface is asynchronous and every request, result, and subscription event is structured-clone-safe - no live objects, callbacks inside results, or synchronous accessors (the surface must survive IPC on desktop).
- [ ] CSV Source identity is opaque at the shared surface; desktop maps canonical paths to it internally and retains one-Tab-per-known-source deduplication.
- [ ] The extraction preserves existing data-revision freshness, comparison publication ordering, owner/worker execution separation, cancellation, artifact ownership and cleanup, source-close behavior, and deterministic workspace disposal.
- [ ] Existing workspace and comparison modules are moved or refactored in place behind the shared interface; no second workspace, comparison orchestrator, or artifact lifecycle is created beside them.
- [ ] The full existing desktop test suite passes with the workspace instantiated in the main process over the extracted modules.
