# 06 — Remove compatibility code and verify the complete boundary

**What to build:** Complete the migration so runtime adapters own Promise work and failure classification, the workspace composes Effects, and the shared entry boundary converts Effects to transport Promises. Delete temporary compatibility code and prove that desktop and web retain the complete CSV Viewer behavior.

**Blocked by:** 03 — Move Aligned Comparison onto database Effects; 04 — Move Working CSV operations onto Effects; 05 — Move platform failure classification into the hosts.

**Status:** ready-for-agent

- [ ] Remove the legacy Promise database/connection surface introduced or retained during expansion. The final query methods use the intended names and Effect types, with no dual API or compatibility shims. Remove public `cancelRunning`; cancellation stays internal to the adapters.
- [ ] Delete `attempt`, `attemptWorkspacePromise`, `attemptWorkspaceSync`, the cause-classification helper, `normalizeDatabaseOperation`, `databaseEffect`, and any remaining `comparisonQuery` implementation. Delete `toError` only if no caller remains. Retain `ComparisonCleanupError` and required entry-boundary failure translation.
- [ ] Audit the entire workspace for Promise inputs/adaptations, including database acquisition/release, startup check/cleanup, engine-source scope callbacks, edit history, and disposal. Remove any leftovers from migration. The shared exported driver-Promise helper is invoked only at runtime adapter edges; workspace services never use it to wrap operations.
- [ ] Preserve the shared entry adapter's `Exit`/`Cause` translation and the transport's Promise contract. Do not introduce nested Effect runners in workspace services to bridge old APIs. Keep renderer state and React free of this migration.
- [ ] Reconcile the throw-site audit with the completed code: expected input failures use typed values, runtime failures are classified at their platform/driver edge, and invariant failures remain defects. Preserve all public results, events, capabilities, messages, diagnostic stages, outcomes, cleanup classification, and privacy rules.
- [ ] Update the workspace README to describe where Promises are allowed and replace obsolete Promise-adapter comments. The database interface documents interruption behavior for both query kinds. Remove obsolete documentation and temporary migration notes from production code.
- [ ] All existing shared CsvViewer contract cases pass unchanged on native DuckDB and DuckDB-Wasm, including expected-failure and defect diagnostics. Preserve assertions while adapting fixture mechanisms. Do not add tests counting adapters or asserting a particular Effect combinator.
- [ ] Real-driver cancellation, settlement, and sanitization tests from ticket 02 pass, along with controlled Comparison executor, host, IPC, startup/fatal-stop, lifecycle, and export coverage. Timing tests use synchronization barriers rather than sleeps.
- [ ] With the verification skill on desktop and web: open a CSV Source, search/filter, edit cells, attempt a blank column rename, undo/redo, Export CSV, run and cancel an Aligned Comparison, and close. Confirm the existing messages and results, inspect edit and cancellation diagnostics, and confirm reopen and desktop quit behavior remain intact.
- [ ] Complete the remaining resource-lifetime web UI verification: open two CSV Sources, run and cancel an Aligned Comparison, reopen with changed dialect options, and reload during startup. Read startup, acquisition, and release diagnostics; inspect checking, unsupported, and fatal states for visual defects. Record any checks requiring human interaction as pending rather than treating automated coverage as completed visual verification.
- [ ] Required type, lint, and test checks and both desktop and web builds pass. Record verification results and any justified store-size increase in ticket comments. No changes to lease, queue, admission, artifact registry, or resource-lifetime rules are introduced.

## Comments

- This is the contract step, blocked by every consumer migration. Verification performed in earlier tickets remains useful evidence; run the complete final checks here without adding redundant smoke tests or tests for deleted implementation details.
- The removed resource-lifetime tickets had completed implementation and automated checks. Their last UI pass opened two CSV Sources, applied a Comparison, reopened with changed dialect options, and inspected acquisition and release diagnostics. Comparison finished before cancellation could be clicked; reload during startup and checking/unsupported/fatal visual verification remained pending. The checkbox above carries that unfinished verification forward.
