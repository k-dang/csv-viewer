# 02 - Internal database interface + native DuckDB adapter

**What to build:** A small internal database interface around the execution behavior CSV Viewer actually needs, with the existing native DuckDB binding refactored to sit behind it as the first adapter. Desktop behavior is unchanged; this is the seam that later admits DuckDB-Wasm.

**Blocked by:** None - can start immediately.

**Status:** ready-for-agent

- [ ] All DuckDB access in the application routes through one internal interface covering parameter normalization, row results, connection lifecycle, cancellation, and error normalization.
- [ ] The interface is shaped by what the workspace needs, not by the native driver's API; no driver types leak through it.
- [ ] SQL construction, storage schema, edit history, comparison orchestration, and result normalization stay outside the adapter - the adapter remains narrow.
- [ ] The full existing test suite passes unchanged against the native adapter.
