# 02 - Engine source access is a scoped acquisition

**What to build:** Open and reopen acquire the engine source inside the staging table's scope, and the scope releases it. When the CSV loads but the engine source cannot be released afterward, the open or reopen still returns `opened` and reports `cleanup-failed` against that request. The Working CSV stays readable. A load failure still fails the open with its current message, and the staging finalizer still drops the staging table.

The host's `withEngineSource(sourceId, use)` callback becomes a scoped acquisition that returns the engine source reference and releases it when the scope closes. This is the only host method that changes shape. The other host methods stay promise-returning. Desktop's engine source is the file path and has no release step. Web's engine source is a registered file buffer, and its release drops it.

**Blocked by:** 01 - The workspace runtime acquires and releases the database.

**Status:** ready-for-agent

- [ ] The host interface exposes engine source access as a scoped acquisition. `withEngineSource` is deleted from the interface, both hosts, the contract fixture hosts, and the tests that override it.
- [ ] Open and reopen acquire the engine source inside the staging scope. The release runs even when the load fails.
- [ ] An engine source release failure after a successful load does not change the result. The request reports `cleanup-failed`.
- [ ] Diagnostics report the release as a `csv.release-engine-source` stage with a normalized outcome. No registered file reference, path, or driver message reaches diagnostic output.
- [ ] New contract case, on native DuckDB and DuckDB-Wasm: an engine source release failure after a successful load returns `opened`, reports `cleanup-failed` for that request, and the Working CSV is readable afterward.
- [ ] Existing open, reopen, and cleanup-failure contract and integration cases pass without weakened assertions.
- [ ] The host interface comment describes the scoped lifetime of the engine source reference.
- [ ] The verify skill's diagnostics section lists the new stage, and its `.agents` mirror is regenerated.
- [ ] With the verify skill on desktop and web: open two CSV Sources, then reopen one Working CSV with changed dialect options. Read the engine source release stages in the diagnostics.
- [ ] The type, lint, and test checks and the desktop and web builds pass.

## Comments
