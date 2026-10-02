# 02 — Make declared workspace failure categories enforceable

**What to build:** Maintainers get distinct engine and source-access failure types and precise Working CSV failure channels, while users retain all existing messages, outcomes, and diagnostic classifications.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Confirm relevant tagged-error and failure-handling APIs in the installed Effect 4.0.0-rc.115 source. Keep the installed version.
- [ ] Define DataEngineError and CsvSourceUnavailableError with Data.TaggedError, preserving safe messages, source-access codes, and required engine causes. Ordinary Error is not assignable to either declared failure type.
- [ ] Adapt every affected constructor and handler across both runtime adapters, hosts, workspace operations, fixtures, and entry translation in one complete change. Remove the replaced form; add no dual error taxonomy or compatibility constructor.
- [ ] Preserve ComparisonCleanupError's dedicated cleanup-failed meaning. Adjust its definition or inheritance as necessary to keep discriminants distinct without changing its diagnostic classification.
- [ ] Replace broad Error annotations in Working CSV and internal dispatch with their declared failure unions or precise inference. Keep unknown causes at genuinely untrusted or Cause-translation seams. Add no casts or generic catches that hide a mismatched contract.
- [ ] Expected validation remains Result or typed failure, and invariant violations remain defects. Platform and driver failures remain classified at their runtime edges. Tagged errors do not cross the renderer protocol as a new public payload.
- [ ] Add focused compile-time checks for ordinary Error rejection and meaningful service failure types. Existing shared CsvViewer contracts on both engines, diagnostics, host, and driver failure tests preserve their behavioral assertions; typechecking and lint pass.

## Comments

- Approved breakdown; implementation has not started. Recommended after ticket 01, but does not require its implementation to begin.
- An in-memory compiler probe accepted ordinary Error as DataEngineError before this change. Fix the underlying type distinction, rather than merely changing annotations around the same structural type.
- Kevin approved the ticket granularity on 2026-10-02. Scope and blocking edges remain as proposed.
