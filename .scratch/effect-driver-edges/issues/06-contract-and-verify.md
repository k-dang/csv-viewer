# 06 — Remove compatibility code and verify the complete boundary

**What to build:** Complete the migration so runtime adapters own Promise work and failure classification, the workspace composes Effects, and the shared entry boundary converts Effects to transport Promises. Delete temporary compatibility code and prove that desktop and web retain the complete CSV Viewer behavior.

**Blocked by:** 03 — Move Aligned Comparison onto database Effects; 04 — Move Working CSV operations onto Effects; 05 — Move platform failure classification into the hosts.

**Status:** implemented - manual native and web failure-state verification remains

- [x] Remove the legacy Promise database/connection surface introduced or retained during expansion. The final query methods use the intended names and Effect types, with no dual API or compatibility shims. Remove public `cancelRunning`; cancellation stays internal to the adapters.
- [x] Delete `attempt`, `attemptWorkspacePromise`, `attemptWorkspaceSync`, the cause-classification helper, `normalizeDatabaseOperation`, `databaseEffect`, and any remaining `comparisonQuery` implementation. Delete `toError` only if no caller remains. Retain `ComparisonCleanupError` and required entry-boundary failure translation.
- [x] Audit the entire workspace for Promise inputs/adaptations, including database acquisition/release, startup check/cleanup, engine-source scope callbacks, edit history, and disposal. Remove any leftovers from migration. The shared exported driver-Promise helper is invoked only at runtime adapter edges; workspace services never use it to wrap operations.
- [x] Preserve the shared entry adapter's `Exit`/`Cause` translation and the transport's Promise contract. Do not introduce nested Effect runners in workspace services to bridge old APIs. Keep renderer state and React free of this migration.
- [x] Reconcile the throw-site audit with the completed code: expected input failures use typed values, runtime failures are classified at their platform/driver edge, and invariant failures remain defects. Preserve all public results, events, capabilities, messages, diagnostic stages, outcomes, cleanup classification, and privacy rules.
- [x] Update the workspace README to describe where Promises are allowed and replace obsolete Promise-adapter comments. The database interface documents interruption behavior for both query kinds. Remove obsolete documentation and temporary migration notes from production code.
- [x] All existing shared CsvViewer contract cases pass unchanged on native DuckDB and DuckDB-Wasm, including expected-failure and defect diagnostics. Preserve assertions while adapting fixture mechanisms. Do not add tests counting adapters or asserting a particular Effect combinator.
- [x] Real-driver cancellation, settlement, and sanitization tests from ticket 02 pass, along with controlled Comparison executor, host, IPC, startup/fatal-stop, lifecycle, and export coverage. Timing tests use synchronization barriers rather than sleeps.
- [x] With the verification skill on desktop and web: open a CSV Source, search/filter, edit cells, attempt a blank column rename, undo/redo, run and cancel an Aligned Comparison, reopen, and close. Confirm the existing messages and results, inspect edit and cancellation diagnostics, and verify web Export CSV through the downloaded bytes and cleared Unexported Changes state.
- [x] Complete resource-lifetime web UI verification for opening two CSV Sources, running and cancelling an Aligned Comparison, reopening with changed dialect options, and reloading during startup. Read startup, acquisition, source/table/worker release diagnostics, and inspect the checking state for visual defects.
- [ ] Complete desktop native Export CSV and quit/menu verification with human interaction.
- [ ] Inspect unsupported-browser and fatal web states using an unsupported browser and a real Worker failure.
- [ ] Capture complete live old-workspace database-release diagnostics after browser navigation.
- [x] Required type, lint, and test checks and both desktop and web builds pass. Record verification results and any justified store-size increase in ticket comments. No changes to lease, queue, admission, artifact registry, or resource-lifetime rules are introduced.

## Comments

- This is the contract step, blocked by every consumer migration. Verification performed in earlier tickets remains useful evidence; run the complete final checks here without adding redundant smoke tests or tests for deleted implementation details.
- The removed resource-lifetime tickets had completed implementation and automated checks. This ticket completed their remaining Comparison cancellation, startup reload, and checking-state visual verification. Unsupported/fatal visuals and complete post-navigation release diagnostics remain pending above.

### Implementation and boundary audit (2026-10-01)

The database and connection interfaces now expose only `run`, `readObjects`, `runCancellable`, `readObjectsCancellable`, `ownerConnection`, `connectWorker`, and `close` with Effect return types. Both runtime adapters implement that one surface. Removed the Promise compatibility methods, public `cancelRunning`, native compatibility fiber bookkeeping, and the unused native row alias. All workspace consumers, driver tests, spies, and controlled fixtures use the final names.

Deleted the unused `attemptWorkspacePromise`, `attemptWorkspaceSync`, and `classifyCaughtCause`. `attempt`, `normalizeDatabaseOperation`, `databaseEffect`, and `comparisonQuery` had already been removed by the preceding tickets; no implementations or consumers remain. `ComparisonCleanupError` and its cleanup classification remain. `isExpectedWorkspaceError` remains only for the shared entry and desktop dropped-source entry to translate declared failures; it no longer classifies caught platform/driver exceptions. `toError` remains because Wasm fatal-stop and termination paths still use it.

The complete production workspace audit found no Promise adaptations or nested runners in Working CSV, Comparison, edit history, engine-source scopes, database Layer acquisition/check/cleanup, or service disposal. Only the shared entry implementation runs Effects for runtime startup, transport requests, fatal-stop notification, and scope disposal. The exported `driverEffect` implementation stays in the shared database module, but its production consumers are runtime edges only. README and interface comments describe the final boundary.

Expected validation uses Result or typed Effect failures. Remaining service throws enforce artifact, dependency, lease, snapshot, exhaustive-switch, and engine-result invariants. Empty-key and invalid-window executor checks are guarded by service validation before the executor runs. Publication rollback rethrows the original invariant failure. Entry throws are transport translations. No additional expected failure was found that needs a new contract case. WorkingCsvStore has no line-count increase in this ticket; its changes only rename database calls. Coordination and resource-lifetime rules, renderer state, messages, events, capabilities, diagnostic stages, and privacy rules are unchanged.

### Automated checks

- `pnpm exec vitest run apps/desktop/src/main/duckdb-database.test.ts apps/web/src/duckdb-wasm-database.test.ts packages/workspace/src/comparison/duckdb-comparison-executor.test.ts`: 3 files / 27 tests passed. Shared real-driver barriers prove cancellation/settlement, no table publication, reuse, non-cancellable settlement, and sanitization on both engines.
- `pnpm exec vitest run apps/web/integration/fixtures/wasm-workspace.test.ts`: 3 tests passed after adapting the shared fixture to run Effects.
- Final `pnpm test`: 39 files / 524 tests passed, including unchanged native/Wasm CsvViewer contracts, diagnostics, controlled Comparison, hosts, IPC, startup/fatal-stop, lifecycle, and export behavior. No test asserts adapter counts or Effect combinators. Removed the native compatibility-only duplicate cancellation case; the unchanged shared real-driver case covers the same cancellation result.
- `pnpm run typecheck`, `pnpm run lint`, and `git diff --check` passed. `pnpm run build:desktop` and `pnpm run build:web` passed. Both builds retain Vite's existing large-chunk advisory.

### Live verification

Used verify-csv-viewer's launcher with isolated profiles, then cleaned up every recorded runtime. Evidence is under `.agents/skills/verify-csv-viewer/evidence/issue-06/`.

Desktop: opened through Recent CSV Sources and file drops; searched Ada; filtered name for Grace through the focused header's Ctrl+Enter filter UI; edited Ada's cell; rejected a blank column rename with `CSV column name cannot be blank.`; undid/redid; reopened; applied the fixture Aligned Comparison (Changed 1 / Unchanged 4); cancelled a 500,000-row Aligned Comparison; closed Comparison and CSV Tabs. Recent CSV Source identity persisted, and the original fixture hash stayed unchanged. Inspected screenshots for layout defects; none found.

Web: used T3 preview first. Its snapshot tool failed twice (including a text-only retry), then the preview host explicitly reported unavailable and instructed no retries. Continued through the skill's own isolated Chrome browser. Opened the actual fixture through Open CSV and file drops; searched/filtered; edited; rejected blank rename; undid/redid; exported; checked the downloaded CSV bytes contain `Ada Lovelace Edited`, LF endings, and all five rows, with Unexported Changes cleared. Reopened with Headers None (six rows and generated column names), then First row (five rows and original names). Opened two sources, applied the fixture comparison (Changed 1 / Unchanged 4), cancelled a 500,000-row comparison, and closed all tabs. Web screenshots, snapshots, and exported bytes are saved and inspected; no layout defect found.

Captured web console diagnostics read-only over the launched browser's CDP connection. Startup acquisition and `web.startup-check` succeeded. On both runtimes `csv.edit-cell` succeeded, blank rename was `recoverable-failure` with `defect=false`, and cancellation interrupted query work then released its worker successfully and recorded `comparison.compute outcome=cancelled cleanup=succeeded`. Engine-source/lease/table release stages succeeded; diagnostic lines contain no source contents, SQL, or driver text.

A direct CDP navigation on the isolated browser caught the real Checking browser support screen, captured `web-checking.png`, checked that exact heading immediately before a second reload, and reloaded during startup. The next workspace reached ready and empty state (`web-startup-reload.txt`, `web-reloaded.aria.txt`); its acquisition/startup-check diagnostics succeeded. Navigation can stop logging before old-workspace disposal completes, so this does not certify complete live database-release diagnostics for the unloaded workspace. Automated startup interruption and release contracts passed.

### Remaining manual verification

Completed live flows are checked separately above. These checks remain pending:

- Desktop native Export CSV dialog and quit/menu behavior. The exact verification skill rule is: "Desktop Export CSV requires a human to finish the OS dialog. An enabled button is not export proof." Its native-control limitation also states: "CDP cannot trigger Electron menu accelerators." The unattended pass therefore did not invoke those dialogs or claim quit from process cleanup. Shared contracts, host/IPC, and desktop intent/disposal specs passed.
- Web unsupported-browser and fatal-state visual inspection. The feature guide requires an unsupported browser and a real Worker failure, and says "Leave it unverified rather than faking it." No such browser or user path to crash the Worker was available. Existing startup/fatal-state automated tests passed. Checking-state visual inspection and reload during startup are now complete, rather than carried forward again.
- Complete live old-workspace database-release diagnostic capture after browser navigation remains uncertified; acquisition, normal startup, source/table/worker release, and all automated disposal ordering/failure checks passed.

### Reviews

Standards: 0 findings. Spec: 0 implementation findings. Both reviews covered all 20 changed files and saved evidence against initial HEAD `a42ef5b0413f744f9f53e4f0c83afb24e2be68fc`. After removing the unused native row alias, the native driver suite (4 tests), desktop typecheck, lint, and diff checks passed again. WorkingCsvStore remains 1052 lines before and after this ticket.
