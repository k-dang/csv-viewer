# 02 - Engine source access is a scoped acquisition

**What to build:** Open and reopen acquire the engine source inside the staging table's scope, and the scope releases it. When the CSV loads but the engine source cannot be released afterward, the open or reopen still returns `opened` and reports `cleanup-failed` against that request. The Working CSV stays readable. A load failure still fails the open with its current message, and the staging finalizer still drops the staging table.

The host's `withEngineSource(sourceId, use)` callback becomes a scoped acquisition that returns the engine source reference and releases it when the scope closes. This is the only host method that changes shape. The other host methods stay promise-returning. Desktop's engine source is the file path and has no release step. Web's engine source is a registered file buffer, and its release drops it.

**Blocked by:** 01 - The workspace runtime acquires and releases the database.

**Status:** done

- [x] The host interface exposes engine source access as a scoped acquisition. `withEngineSource` is deleted from the interface, both hosts, the contract fixture hosts, and the tests that override it.
- [x] Open and reopen acquire the engine source inside the staging scope. The release runs even when the load fails.
- [x] An engine source release failure after a successful load does not change the result. The request reports `cleanup-failed`.
- [x] Diagnostics report the release as a `csv.release-engine-source` stage with a normalized outcome. No registered file reference, path, or driver message reaches diagnostic output.
- [x] New contract case, on native DuckDB and DuckDB-Wasm: an engine source release failure after a successful load returns `opened`, reports `cleanup-failed` for that request, and the Working CSV is readable afterward.
- [x] Existing open, reopen, and cleanup-failure contract and integration cases pass without weakened assertions.
- [x] The host interface comment describes the scoped lifetime of the engine source reference.
- [x] The verify skill's diagnostics section lists the new stage, and its `.agents` mirror is regenerated.
- [x] With the verify skill on desktop and web: open two CSV Sources, then reopen one Working CSV with changed dialect options. Read the engine source release stages in the diagnostics.
- [x] The type, lint, and test checks and the desktop and web builds pass.

## Comments

Implemented scoped source acquisition for both hosts. Contract cases on native DuckDB and DuckDB-Wasm cover successful open and reopen with failed source release, release after a failed load, and simultaneous load and release failures. The web fixture fails the actual registered-file drop; the desktop fixture fails its scoped release callback. The full Vitest suite passed before the last test was added (493 tests); both contract suites passed afterward (286 tests), as did typecheck and lint. Both builds passed after the implementation change. Desktop and web UI runs opened two sources, reopened one with an explicit comma delimiter, and showed `csv.release-engine-source` diagnostics. The standards and spec reviews found no remaining issues.
