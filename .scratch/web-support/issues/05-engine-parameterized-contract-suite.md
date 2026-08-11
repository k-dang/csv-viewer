# 05 - Engine-parameterized behavioral contract suite

**What to build:** One extensive behavioral contract that runs against a CsvWorkspace wired to any database adapter, executed first against the native DuckDB adapter. Existing workspace, comparison, export, and renderer-state tests are the prior art; the contract is written so a second engine can be dropped in without editing the tests.

**Blocked by:** 03 - Shared CsvWorkspace extraction.

**Status:** ready-for-agent

- [ ] The workspace contract covers CSV Source opening, dialect overrides, metadata, row windows, sorting, filters, search, Column Value Counts, edit operations, stable row identity, insert restrictions, deletion, undo, redo, Unexported Changes, export state, close impact, and resource release.
- [ ] The comparison contract covers candidate discovery, Comparison-Compatible CSVs, Comparison Key validation, invalid-key diagnostics, execution, cancellation, summaries, row classifications, result windows, swapping, Outdated Comparison behavior, refresh, source closing, and artifact cleanup.
- [ ] Export contract tests compare output bytes for headers, delimiters, quoting, null/empty values, edits, inserted rows, deleted rows, row order, and exclusion of internal columns.
- [ ] Export-state tests prove export clears Unexported Changes without removing undo/redo, undoing away recreates them, and returning to the exported revision clears them.
- [ ] Tests assert observable domain behavior only - no private SQL helper structure, driver internals, or IPC details.
- [ ] The suite is parameterized over the database adapter and passes fully against the native adapter.
