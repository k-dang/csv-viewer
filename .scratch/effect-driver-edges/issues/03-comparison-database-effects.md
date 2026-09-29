# 03 — Move Aligned Comparison onto database Effects

**What to build:** Aligned Comparison execution, result reads, cancellation, and cleanup use the database Effect interface directly on desktop and web. Cancelling an attempt still stops its database work before resources are released, and cleanup failures retain their separate diagnostic meaning.

**Blocked by:** 01 — Make expected validation failures explicit; 02 — Add Effect database operations on both runtimes.

**Status:** ready-for-agent

- [ ] Migrate the Comparison executor's owner-connection access, worker acquisition, queries, result reads, table drops, worker closes, and retry cleanup to direct database Effects. Include the store-to-executor connection seam.
- [ ] Use cancellable database queries directly and delete `comparisonQuery`. Remove the executor's uses of `databaseEffect`; retain a shared helper only if another unmigrated consumer still needs it until ticket 06.
- [ ] Keep `ComparisonCleanupError`. Map typed database release failures to it, preserving `cleanup-failed` reporting separately from the Comparison outcome. Cleanup no longer adapts Promise rejections.
- [ ] Keep the failed-worker retry map, source leases, reader counts, snapshot bookkeeping, admission behavior, and resource ownership unchanged.
- [ ] Comparison Key validation consumes the explicit failure values from ticket 01. Validation messages, invalid-key outcomes, cancellation outcomes, result rows, and events retain their existing behavior.
- [ ] Existing controlled-executor and cancellation tests pass. Move assertions about the removed query adapter to the real-driver adapter tests from ticket 02, retaining behavior coverage without testing helper structure.
- [ ] Existing shared Comparison and diagnostics contract cases pass unchanged on native DuckDB and DuckDB-Wasm. Type and lint checks pass.
- [ ] Use the verification skill on desktop and web to run and cancel an Aligned Comparison, confirm subsequent operations remain usable, and inspect cancellation diagnostics. Keep diagnostic stages and privacy rules unchanged.

