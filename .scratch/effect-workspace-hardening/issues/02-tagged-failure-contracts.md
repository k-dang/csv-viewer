# 02 — Make declared workspace failure categories enforceable

**What to build:** Maintainers get distinct engine and source-access failure types and precise Working CSV failure channels, while users retain all existing messages, outcomes, and diagnostic classifications.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] Confirm relevant tagged-error and failure-handling APIs in the installed Effect 4.0.0-rc.115 source. Keep the installed version.
- [x] Define DataEngineError and CsvSourceUnavailableError with Data.TaggedError, preserving safe messages, source-access codes, and required engine causes. Ordinary Error is not assignable to either declared failure type.
- [x] Adapt every affected constructor and handler across both runtime adapters, hosts, workspace operations, fixtures, and entry translation in one complete change. Remove the replaced form; add no dual error taxonomy or compatibility constructor.
- [x] Preserve ComparisonCleanupError's dedicated cleanup-failed meaning. Adjust its definition or inheritance as necessary to keep discriminants distinct without changing its diagnostic classification.
- [x] Replace broad Error annotations in Working CSV and internal dispatch with their declared failure unions or precise inference. Keep unknown causes at genuinely untrusted or Cause-translation seams. Add no casts or generic catches that hide a mismatched contract.
- [x] Expected validation remains Result or typed failure, and invariant violations remain defects. Platform and driver failures remain classified at their runtime edges. Tagged errors do not cross the renderer protocol as a new public payload.
- [x] Add focused compile-time checks for ordinary Error rejection and meaningful service failure types. Existing shared CsvViewer contracts on both engines, diagnostics, host, and driver failure tests preserve their behavioral assertions; typechecking and lint pass.

## Comments

- Approved breakdown; implementation has not started. Recommended after ticket 01, but does not require its implementation to begin.
- An in-memory compiler probe accepted ordinary Error as DataEngineError before this change. Fix the underlying type distinction, rather than merely changing annotations around the same structural type.
- Kevin approved the ticket granularity on 2026-10-02. Scope and blocking edges remain as proposed.
- Implemented 2026-10-02. Compile-time contracts live in `packages/workspace/src/failure-contracts.test-d.ts`, enforced by the root typecheck.
- Follow-up: some sites still convert one failure category into another by hand. `WorkingCsvStore.createComparisonExecutor` wraps a lease `WorkspaceRequestError` and the disposal refusal as `DataEngineError`. `CsvComparisonService.closeDependents` and `dispose` wrap a plain close-failure object as `DataEngineError({ cause })`, which loses the original driver cause. Fixing them changes Comparison outcomes, so they were left out of this ticket. Possible fix: widen the executor source port's `acquireSource` channel to include `WorkspaceRequestError` and map it to `source-unavailable`; have `closeEntity`'s failed result carry the original `Cause<DataEngineError>`.
- Follow-up (fits 03 or 04): `working-csv-store.ts` is over 1k lines. `CsvOpenError` still uses a positional constructor and shares the `WorkspaceRequestError` tag, so `catchTag('WorkspaceRequestError')` also catches it. Move `CsvOpenError` and the open-failure helpers into `working-csv/open-failures.ts`, and switch it to the object-argument form.
