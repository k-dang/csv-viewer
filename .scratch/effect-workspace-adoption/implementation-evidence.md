# Issue 1 implementation evidence

Completed 2026-09-17 against starting commit `847ac52e737a74d6446bf3cc82b80a8cd3f31e36`. Initial implementation committed as `57ea8a32ca9332f2aac8748d24152479e0b74326`.

## Implementation

One workspace-owned ManagedRuntime constructs host, database, Working CSV, and Comparison services. The shared entry adapter executes Effects and preserves multiple failure causes at the promise boundary. Comparison attempt, result-read, retirement, close, and disposal workflows compose Effects. No Effect execution calls remain in migrated Comparison modules.

Attempt scopes release worker connections, source leases, and unpublished staging artifacts. Publication transfers the artifact to the Comparison; replacement and close wait for readers before retirement. Cancellation acknowledges the request before driver settlement and finalization. Disposal blocks new admission, settles Comparisons, preserves admitted Working CSV work, closes the database, then disposes the runtime. Failed cleanup retains ownership for retry.

## Automated verification

- `pnpm run test`: 33 files, 327 tests passed before the final shared reader-retirement case was added.
- After review, `pnpm exec vitest run apps/desktop/integration/csv-workspace.contract.test.ts apps/web/integration/csv-workspace.contract.test.ts packages/workspace/src/comparison/duckdb-comparison-executor.test.ts packages/workspace/src/comparison/csv-comparison-service.test.ts`: 4 files, 198 tests passed, including both instances of the new shared contract.
- The Comparison service suite was rerun after adding test-runtime teardown: 16 tests passed.
- `pnpm run test:browser`: all 6 Chromium tests passed.
- `pnpm run build`: typechecks, lint, desktop production build, and web production build passed. Vite retains its bundle-size advisory.
- After the review test addition, `pnpm exec tsc -p tsconfig.json --noEmit` and `pnpm run lint` passed.
- `git diff --check` passed. Tracked CSV fixtures are unchanged.

Distinct new coverage verifies disposal waits for query and attempt cleanup, non-cancellable result queries settle before interruption releases their snapshots, late requests retain public outcomes after runtime disposal, and admitted result windows finish before comparison close.

The late-request test first failed with `ManagedRuntime disposed`, then passed after entry admission handling was fixed. The public reader-retirement test passed on both engines, failed on both when the reader wait was temporarily removed, and passed after restoration. No timing sleeps were added.

## App verification

Used the project `verify-csv-viewer` skill with isolated desktop and web instances. Desktop loaded the built app; web used an isolated real dev server and Chrome profile. Both instances passed doctor checks and were cleaned up.

On desktop, opened fixtures through file drop. On web, opened them through Open CSV file inputs. Used the header Compare button, Candidate picker, id checkbox, and Apply key. Both displayed Changed 1, Baseline-only 0, Candidate-only 0, and Unchanged 4. Swap and Refresh retained the expected result. Screenshots were inspected.

On both runtimes, dropped two generated 700,000-row CSVs, began a comparison, clicked Cancel, and observed `Comparison cancelled. No result was applied.` Closed every Comparison and CSV Tab, observed `No CSV open`, and closed the isolated window. Desktop Recent CSV Sources still contained the opened fixtures before cleanup.

Snapshots and screenshots are in `.agents/skills/verify-csv-viewer/evidence/effect-workspace/`: `desktop-empty`, `desktop-applied`, `desktop-cancelled`, `desktop-closed`, and the equivalent `web-*` files. Desktop native file dialogs were not exercised; file drop was the authorized automated entry point.

## Standards

No actionable findings. The changes preserve documented workspace boundaries and domain terms. Runtime ownership, attempt scopes, reader retention, and disposal ordering remain separated by responsibility. Failure causes stay structured until projection, and failed releases retain retry records. No baseline code smell warrants a change.

## Spec

Zero remaining findings. The review identified missing public-contract proof for reader retirement. The new shared test at `packages/workspace/test/contract/comparison.contract.ts` verifies the admitted window returns expected rows before close completes. Both native and Wasm passes, plus failures with reader waiting removed, establish sensitivity to the ownership guarantee. The reviewer confirmed the wait was restored and closed the finding.

Standards: 0 findings. Spec: 1 coverage finding resolved, 0 remaining. No outstanding issue in either axis.

## Effect coordination follow-up

Refactored against `57ea8a32ca9332f2aac8748d24152479e0b74326` after comparison with the cached Effect 4.0.0-rc.115 source and T3 Code. Follow-up changes remain uncommitted.

- Startup now waits on a `Deferred` until admission records and publishes the running attempt. `startImmediately` installs settlement before reentrant cancellation; a separate `yieldNow` preserves asynchronous computation after admission. Phase yields also use `yieldNow` instead of zero-duration timers.
- Each group of concurrent result readers shares a count and a `Deferred`. The last reader completes it. Removed callback waiter arrays and extended the existing retirement test to cover two concurrent readers.
- Removed interruption protection from service result projection, synchronous publication, and the retirement retry loop. Kept and documented it for admission, shared close/retirement, disposal, and noncancellable owner reads. Attempt acquisition and finalizers retain Effect's scoped protection.
- Updated README ownership documentation.

Validation: all 329 tests across 33 files passed, including the 198 focused service/executor/native/Wasm contract tests. All 6 Chromium tests, workspace typechecking, lint, and `git diff --check` passed. The existing reentrant-close, cancellation, source-change, and noncancellable-read tests remain green. This follow-up did not repeat the manual desktop/web video capture above.

### Standards review

No actionable findings. The reader record, explicit startup gate, retained interruption protection, and README follow the documented ownership boundaries and simplicity guidance.

### Spec review

No actionable findings. The gate preserves startup ordering and settlement, the final reader releases retirement, and narrowed interruption protection preserves required resource lifetimes. No missing requested improvement or scope creep was found.

Standards: 0 findings. Spec: 0 findings.
