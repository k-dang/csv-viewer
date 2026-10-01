# 03 — Move Aligned Comparison onto database Effects

**What to build:** Aligned Comparison execution, result reads, cancellation, and cleanup use the database Effect interface directly on desktop and web. Cancelling an attempt still stops its database work before resources are released, and cleanup failures retain their separate diagnostic meaning.

**Blocked by:** 01 — Make expected validation failures explicit; 02 — Add Effect database operations on both runtimes.

**Status:** done

- [x] Migrate the Comparison executor's owner-connection access, worker acquisition, queries, result reads, table drops, worker closes, and retry cleanup to direct database Effects. Include the store-to-executor connection seam.
- [x] Use cancellable database queries directly and delete `comparisonQuery`. Remove the executor's uses of `databaseEffect`; retain a shared helper only if another unmigrated consumer still needs it until ticket 06.
- [x] Keep `ComparisonCleanupError`. Map typed database release failures to it, preserving `cleanup-failed` reporting separately from the Comparison outcome. Cleanup no longer adapts Promise rejections.
- [x] Keep the failed-worker retry map, source leases, reader counts, snapshot bookkeeping, admission behavior, and resource ownership unchanged.
- [x] Comparison Key validation consumes the explicit failure values from ticket 01. Validation messages, invalid-key outcomes, cancellation outcomes, result rows, and events retain their existing behavior.
- [x] Existing controlled-executor and cancellation tests pass. Move assertions about the removed query adapter to the real-driver adapter tests from ticket 02, retaining behavior coverage without testing helper structure.
- [x] Existing shared Comparison and diagnostics contract cases pass unchanged on native DuckDB and DuckDB-Wasm. Type and lint checks pass.
- [x] Use the verification skill on desktop and web to run and cancel an Aligned Comparison, confirm subsequent operations remain usable, and inspect cancellation diagnostics. Keep diagnostic stages and privacy rules unchanged.


## Comments

- Migrated the executor and store connection seam to `ownerConnectionEffect`, `connectWorkerEffect`, cancellable query Effects, owner read/run Effects, and `closeEffect`. Deleted `comparisonQuery` and `databaseEffect` after migrating all remaining consumers. `cleanupEffect` now maps typed database release failures to `ComparisonCleanupError`; it does not adapt Promises. Reader, snapshot, lease, admission, and failed-worker retry bookkeeping is unchanged.
- Existing unknown-key validation remains a typed request failure with its original message. Executor tests now supply database Effects, and snapshot cleanup failure injection targets the Effect surface. Driver throw/rejection normalization coverage belongs to the existing real-driver contracts.
- Verification: `pnpm run typecheck`, `pnpm run lint`, `pnpm run build:desktop`, and `pnpm run build:web` passed. Focused run: comparison service, both runtime workspace contracts, and both database adapter specs (321 tests). Full bounded suite: `pnpm test` (39 files, 513 tests). Executor lifecycle spec also passed independently (8 tests).
- UI verification used isolated verify-csv-viewer runs. Desktop and web both produced Changed 1 / Unchanged 4 for the sample fixtures. Desktop cancelled a 500,000-row replacement; web cancelled a 100,000-row replacement through the rendered Cancel button, synchronized with the comparison progress banner. Both preserved their previous result, reported snapshot `interrupted`, released snapshot and worker successfully, and finished as `cancelled` with cleanup `succeeded`. Reapplying afterwards succeeded on both runtimes; desktop CSV search also remained usable. No new stages or source/driver text appeared in cancellation diagnostics. Evidence is under `.agents/skills/verify-csv-viewer/evidence/issue-3/`. Collaborative preview reconnections were needed during web automation; the successful final cancellation and reuse runs are recorded separately.
- Required matt-code-review completed against implementation base `7914b1ffe5ee6cc1e25dff92fdee0b0114233175`: Standards 0 findings; Spec 0 actionable findings. The prerequisite's documented best-effort driver cancellation decision remains in force.
- Follow-up adversarial subagent review requested by Kevin: no actionable findings across cancellation/scoping, cleanup retries, owner-reader leases, snapshot retirement, diagnostic cause handling, and migrated test sensitivity. Independent focused executor/service run passed (2 files, 24 tests).
