# 09 - Web file and workspace size limits

**What to build:** Fixed web limits of 100 MB per CSV Source and 200 MB across open CSV Sources, checked before ingestion. MB is decimal: 100,000,000 and 200,000,000 bytes respectively.

These are provisional product limits. They count original source-file bytes and do not measure memory or guarantee that all workloads below the limits succeed. Capacity benchmarking is deferred. Browser responsiveness verification belongs to ticket 11.

**Blocked by:** 08 - Web Export CSV + lifecycle.

**Status:** complete

- [x] Check the selected file's size against 100,000,000 bytes and the resulting sum of admitted CSV Source sizes against 200,000,000 bytes before ingestion or buffer registration. Values exactly at either limit are admitted.
- [x] Reject an opening that exceeds either limit before allocating expensive work. Preserve all existing Tabs and state.
- [x] Closing a CSV Tab releases its source-byte budget. Failed or cancelled opens retain no budget, and concurrent opens cannot bypass the workspace total.
- [x] Export CSV and Aligned Comparison have no separate capacity admission checks. Edits, history, comparison artifacts, and export buffers do not change the source-byte total.
- [x] A capacity rejection is a domain outcome naming the applicable limit and directing the user to the desktop application.
- [x] Add the capacity outcome to `OpenCsvResult` in `packages/workspace/src/contracts/csv-viewer.ts`. Its existing `failed` arm carries only a message and cannot name a limit. Both runtimes handle the new shared result arm, including desktop IPC transport; the size limits apply only to web.
- [x] Rejection copy states "CSV Viewer Web supports files up to 100 MB" or "CSV Viewer Web supports up to 200 MB of open CSV files", followed by a desktop fallback. It never claims to measure memory or predict a crash.
- [x] Use the same fixed limits across supported browsers and devices. Limits are injected for testing, with no adaptive heuristics or best-effort attempts above them.
- [x] Use small injected limits to test admission below and exactly at each boundary, rejection immediately above, preservation of existing state, budget release on close, failed or cancelled opens, and concurrent opens respecting the total. No capacity benchmark fixtures are required.

## Comments

Implemented source-byte admission before file reads, with concurrent-open reservations and release on failed opens or successful close. Shared capacity outcomes reach the renderer and desktop IPC.

Verification: all 270 tests across 31 files pass, including both engine contracts, injected capacity boundaries, lifecycle and concurrent-open cases, comparison and export at capacity, renderer copy, and IPC transport. Lint and typechecking pass. Standards and spec reviews found no issues. Browser responsiveness and the release browser matrix remain with ticket 11.

Browser follow-up: passed real Chrome UI checks with two actual 100,000,000-byte CSV Sources, an oversized Source, and workspace rejection followed by successful opening after closing a Tab. Existing Tabs and search survived rejection. Fixed the source-size formatter to use decimal MB after the visual pass exposed 95.4 MB for a 100 MB file. Added a focused CsvGrid test; 12 affected UI tests, lint, and typechecking pass. Local evidence: .scratch/browser-qa/results.md. Other browsers remain ticket 11 work.
