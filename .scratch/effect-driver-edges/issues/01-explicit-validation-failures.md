# 01 — Make expected validation failures explicit

**What to build:** Expected input failures keep their validation messages when query construction, Comparison Key validation, and undo/redo run inside Effects. Pure validators return failure values instead of throwing. Undo and redo calculate the next command separately from database replay, and commit history only after replay succeeds.

**Blocked by:** None — can start immediately. The resource-lifetime changes are implemented; remaining web UI verification is carried into ticket 06.

**Status:** ready-for-agent

- [ ] Confirm the `Result` and Effect conversion APIs in the installed `effect` 4.0.0-rc.115 source. Do not upgrade Effect.
- [ ] Unknown-column and empty-row-selection validation return `Result`. Propagate failures through affected query builders and callers without changing SQL, request results, or validation messages. Query construction remains ordinary synchronous code.
- [ ] No-undo and no-redo checks return `Result` with their existing messages. Separate pure history calculation and commitment from asynchronous command replay; a replay failure leaves the history stacks and revision identity unchanged.
- [ ] Update every affected caller, including Comparison Key validation. Effect callers place expected validation failures in the failure channel. Existing Promise callers remain functional during migration; no permanent duplicate validator or history API is introduced.
- [ ] Audit every throw site reachable from Effect code and record its classification in ticket comments: expected input/platform failure or broken invariant. Identify remaining store and host conversions for tickets 04 and 05. Exhaustive-switch failures, lease/dependency invariant violations, and invalid engine results remain defects.
- [ ] If the audit finds an expected failure currently surfacing as a defect, first reproduce it through the closest user-facing request path. Add one focused shared contract case asserting the existing validation message or declared outcome, including diagnostics classification where relevant. Do not add tests merely for the new return type.
- [ ] Existing shared contract cases pass on native DuckDB and DuckDB-Wasm without changed behavioral assertions. Adapt affected unit tests to the value-returning API while retaining their behavioral coverage. Type and lint checks pass.

## Comments

- This is the prefactor for tickets 03 and 04. Follow the existing history semantics rather than adding a new state machine. Pure result normalization, edit-history calculation, and serialization stay ordinary functions.
