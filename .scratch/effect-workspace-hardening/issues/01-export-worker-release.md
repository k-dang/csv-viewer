# 01 — Retain failed Export CSV worker releases through disposal

**What to build:** Export CSV keeps ownership of a worker whose close failed, preserves Unexported Changes, and retries that release during workspace disposal. Persistent cleanup failure rejects disposal without preventing database release.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] Reproduce the failure through a public CsvViewer Export CSV request with a real database adapter. Inject failure before the real worker close, rather than reporting failure after a successful close.
- [x] Retain failed export worker release actions in the owning Working CSV module. Remove retained ownership only after release succeeds; do not retain a closed request scope or unrelated request state.
- [x] A failed release prevents host delivery and marking the captured revision exported. The request keeps its existing sanitized rejection and cleanup-failed diagnostic; Unexported Changes and edit history remain intact.
- [x] Workspace disposal retries retained export worker releases before database release. A persistent failure does not prevent remaining cleanup and database release, and disposal rejects with sanitized reporting. Concurrent and repeated disposal calls keep the existing stable result.
- [x] Preserve table lease, mutation queue, admission, source lifetime, and export revision rules. Host delivery remains outside the lease. Add no background retry loop, timer, worker pool, or generic release framework.
- [x] Add focused shared CsvViewer contract coverage on native DuckDB and DuckDB-Wasm proving an actual close on successful disposal retry, plus persistent failure reporting and continued database release. Use existing lifecycle and diagnostics scenarios where possible; release observations or barriers must establish the result.
- [x] Existing export, lifecycle, diagnostics, and both-engine CsvViewer contracts pass. Relevant type and lint checks pass. Update ownership comments or documentation affected by the corrected release behavior.

## Comments

- Approved breakdown; implementation has not started. This is the first recommended ticket because it fixes a reproduced resource-release bug.
- Comparison's retained failed-worker behavior is prior art. Keep ownership in the acquiring module and avoid extracting shared machinery without a concrete need.
- Kevin approved the ticket granularity on 2026-10-02. Scope and blocking edges remain as proposed.
- Implemented 2026-10-02. The fixture now fails the export worker close before the real connection closes; both engines reproduced the missing disposal retry before the fix.
