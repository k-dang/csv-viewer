Status: ready-for-agent

# Effect comparison experiment

## Problem Statement

CSV Viewer must keep Aligned Comparison correct when users cancel work, change a Working CSV, switch Tabs, or close a Comparison Tab. Connections, CSV leases, temporary tables, and published snapshots have different lifetimes. The current implementation coordinates these through cancellation flags, completion promises, repeated release paths, and snapshot-retirement bookkeeping.

Kevin wants to learn Effect through a useful, contained change and determine whether it makes this coordination easier to understand and maintain. The experiment addresses implementation complexity without assuming that the existing product behavior is broken.

## Solution

Implement one complete Aligned Comparison attempt with Effect, shared by applying a Comparison Key and refreshing an Outdated Comparison. Use fibers for owned tasks, scopes for temporary resources, and typed errors for operational failures.

Preserve the current experience and public CsvViewer interface on desktop and web. Evaluate the result using existing behavior contracts, real user flows, and before/after measurements. Finish with a recommendation about keeping this localized adoption; expansion is a separate decision.

## User Stories

1. As a CSV Viewer user, I want to apply a Comparison Key, so that I can inspect an Aligned Comparison of my Baseline and Candidate.
2. As a CSV Viewer user, I want to see the existing comparison phases while work runs, so that I know the attempt is progressing.
3. As a CSV Viewer user, I want a second attempt to report that the Comparison Tab is busy, so that competing attempts cannot replace each other's results.
4. As a CSV Viewer user, I want invalid Comparison Keys to produce the existing diagnostics, so that I can correct blank or duplicate key values.
5. As a CSV Viewer user, I want an invalid replacement key to preserve my previous applied result, so that a failed attempt does not discard useful work.
6. As a CSV Viewer user, I want to cancel an in-flight comparison, so that unnecessary database work stops.
7. As a CSV Viewer user, I want cancellation to preserve my previous applied result, so that I can continue inspecting it.
8. As a CSV Viewer user, I want repeated or outdated cancellation requests to be harmless, so that they cannot stop a different attempt.
9. As a CSV Viewer user, I want to switch Tabs without cancelling comparison work, so that I can use another Working CSV while waiting.
10. As a CSV Viewer user, I want an attempt to reject results computed from changed Working CSV revisions, so that the app does not present an outdated computation as current.
11. As a CSV Viewer user, I want source changes to identify the affected Baseline or Candidate, so that I understand why I need to refresh.
12. As a CSV Viewer user, I want to refresh an Outdated Comparison using its applied Comparison Key, so that I can inspect the latest data.
13. As a CSV Viewer user, I want a replacement result to become available as one complete update, so that I never see a partially published comparison.
14. As a CSV Viewer user, I want a published result to remain available after its computation finishes, so that I can continue reading and navigating it.
15. As a CSV Viewer user, I want reads already using a snapshot to remain safe during replacement, so that result navigation does not access a deleted table.
16. As a CSV Viewer user, I want query failures to preserve the previous result and show the existing failure outcome, so that I can decide whether to try again.
17. As a CSV Viewer user, I want closing a running Comparison Tab to stop its work and release its resources, so that closed Tabs do not keep computing or publish later updates.
18. As a CSV Viewer user, I want closing a Working CSV to coordinate its dependent Comparisons, so that work cannot use a table after it is released.
19. As a CSV Viewer user, I want workspace disposal to finish comparison cleanup in dependency order, so that resource lifetimes remain correct during shutdown.
20. As a CSV Viewer user, I want cancellation of one comparison to leave other workspace queries usable, so that unrelated work can continue.
21. As a CSV Viewer user, I want a successfully published replacement to remain available when old-snapshot cleanup fails, so that maintenance failure does not undo a valid result.
22. As a CSV Viewer user, I want the same comparison behavior on desktop and web, so that my workflow does not depend on the DuckDB runtime.
23. As a CSV Viewer user, I want comparison processing to remain on my device, so that the experiment preserves Local Processing.
24. As a maintainer, I want each temporary resource to have an explicit owner and paired cleanup, so that I can reason about success, cancellation, and failure paths.
25. As a maintainer, I want cancellation during connection startup to release the eventual connection, so that a startup race cannot leak resources or start unwanted queries.
26. As a maintainer, I want partial acquisition to release resources already acquired, so that failure to acquire a second resource does not leak the first.
27. As a maintainer, I want cleanup failures to preserve their cause and resource ownership, so that failed cleanup remains observable and retryable where supported.
28. As a maintainer, I want unexpected defects to remain observable and settle the attempt, so that a Comparison Tab does not remain permanently running.
29. As a maintainer, I want to validate behavior through existing interfaces, so that tests survive internal changes to Effect composition.
30. As Kevin, I want to see which manual coordination Effect removes and which domain rules remain, so that I learn where its concepts are useful.
31. As Kevin, I want measurements of startup, comparison, cancellation, and web JavaScript size, so that I can judge the cost of adoption.
32. As Kevin, I want a complete localized experiment with a clear recommendation, so that broader adoption follows evidence.

## Implementation Decisions

- **Scope of the migration.** Change the shared comparison module and its executor for validation, staging-snapshot generation, summarization, publication, settlement, and cleanup. Include their participation in cancellation, source changes, Tab closure, and workspace disposal. Change database adapters only as needed to implement those lifetimes correctly.
- **Public interface.** Keep CsvViewer's Promise-based requests, structured-clone-safe results, and existing events. Keep existing operation identifiers, result tokens, phases, busy responses, and domain outcomes. Internal Effect values, fibers, scopes, and error objects must not cross this interface. Internal interfaces may change when they remove coordination code.
- **Task ownership.** Run one fiber for each accepted comparison attempt. Its owner is the shared comparison module for the Comparison Tab. Renderer subscriptions, React component lifetime, and Active Tab changes do not own or cancel it. Establish the task and awaitable completion before publishing its running state, because subscribers can synchronously request closure.
- **Temporary resources.** Give each attempt a scope. Pair successful acquisition with release for its dedicated worker connection, CSV leases, and unpublished staging snapshot. Partial acquisition must release earlier acquisitions. Keep ownership explicit if cleanup fails.
- **Database cancellation.** Wire fiber interruption to cancelRunning on the attempt's dedicated database connection. Wait for the query to stop before releasing any connection, table, or lease it uses. Wrapping a Promise in Effect alone does not cancel the underlying query. Never interrupt the shared owner connection to cancel an attempt.
- **Connection-startup race.** If interruption wins while a connection is opening, release the eventual connection without starting validation or comparison queries. Ensure no resource is lost between successful acquisition and cleanup registration.
- **Runtime differences.** Preserve the distinction between short queries on the owner connection and cancellable queries on dedicated connections. DuckDB-Wasm's cancellable path owns a connection's result stream. Native and WASM adapters must satisfy the same comparison behavior.
- **Publication.** Treat the final current-attempt and revision checks, snapshot ownership transfer, and result installation as a short non-interruptible transition. Complete that transition before notifying subscribers. Once publication commits, cancellation cannot undo the applied result. Install the replacement before retiring the previous snapshot.
- **Published resources.** A published snapshot belongs to its Comparison Tab and outlives its attempt scope. Keep reader protection when replacing or closing snapshots. Retire a snapshot only after its readers have finished. Do not remove the artifact registry or retirement tracking merely because Effect supplies finalizers.
- **Cancellation responses.** Preserve requested, already-requested, already-finished, operation-mismatch, and comparison-not-found behavior. A requested response acknowledges cancellation intent, not completed cleanup. Settle the attempt once, after cleanup has been attempted and any cleanup failure has an explicit owner.
- **Source changes.** Keep captured data revisions and the final publication check. Preserve sources-changed outcomes, affected-side reporting, and their existing precedence over cancellation or interrupted-query failure. An existing applied snapshot remains available and becomes Outdated when appropriate.
- **Errors.** Use specific internal error types for expected operational failures. Build on DataEngineError and distinguish cleanup failures where recovery differs. Keep invalid-key, cancelled, and sources-changed as domain outcomes. Map internal failures to the existing public outcomes and retain causes for diagnostics.
- **Cleanup failure.** Preserve the original failure if cleanup also fails. Attempt remaining independent cleanup after a release fails. Keep failed artifact retirement under tracked ownership for the existing retry behavior. Failure to retire a previous snapshot must not roll back a published replacement. Unexpected defects must be observable and must not leave the attempt permanently running.
- **Closure.** Comparison Tab closure interrupts and awaits active work before completing cleanup and reporting closure. No changed event may follow completed closure. Working CSV closure and workspace disposal retain their dependency ordering, error reporting, and retryable cleanup behavior.
- **Effect execution.** Introduce one explicit owner for the runtime resources needed by this experiment. Execute Effect at the existing module seam rather than creating unmanaged runtimes per request or helper. Add Layers only when they acquire or share resources needed by this workflow.
- **Dependency selection.** Select and pin a compatible Effect release at implementation start, verify the APIs used, and record the version in the implementation report. T3 Code's version is a reference, not a requirement.
- **Complete replacement.** Delete superseded task and cleanup mechanics. Update affected comments and tests. Keep necessary operation identity, phase, revision, and ownership state. Do not retain a parallel implementation, feature flag, or fallback path.

## Testing Decisions

- Use the existing CsvViewer request-and-event interface as the primary test seam. Run the shared comparison contract through both native and WASM fixtures. No new public testing interface is required.
- Test observable outcomes: returned responses, emitted events, result readability, actual query interruption, and resource availability after settlement. Do not assert fiber layout, helper calls, internal composition, or line counts.
- Reuse existing comparison orchestration and executor lifecycle tests for controlled races that are difficult to produce reliably through the public interface. Use existing database-adapter tests to prove actual native and WASM cancellation for changed behavior. Prefer moving a check to the higher seam when it remains deterministic there.
- Preserve the existing coverage for exact comparison values and classifications, invalid-key diagnostics, result replacement, Outdated Comparisons, dependent closure, and no updates after completed closure. This checks that the implementation migration preserves product behavior.
- Cover cancellation before publication, during acquisition, and during a database query; repeated and mismatched cancellation; source changes before publication; reentrant cancellation or closure from event subscribers; and published results surviving attempt completion.
- Cover partial acquisition, query failure combined with cleanup failure, retirement failure after successful publication, active readers during retirement, and disposal continuing with independent cleanup after one failure. Add focused tests only where existing coverage does not establish the requirement.
- Use controlled completion signals to exercise orchestration races. Do not use arbitrary delays to prove that work or cleanup has finished. Actual database-interruption tests must demonstrate that the query stopped and the relevant database remains usable.
- Capture baseline behavior and measurements before implementation. Use the same representative CSVs, runtime configuration, and machine for before/after comparisons. Repeat timing measurements and report their variation.
- Perform one integrated end-to-end pass in each runtime using the project's verification skill. Apply a valid Comparison Key, refresh, cancel an in-flight attempt, change a Working CSV during work, and close a running Comparison Tab. Check result preservation, diagnostics, and UI responsiveness.
- Run lint, typecheck, relevant tests, and both application builds. Fix failures or flakiness encountered while verifying the change rather than treating them as acceptable baseline behavior.

## Out of Scope

- Effect adoption in React state, AG Grid, CSV query construction, comparison matching rules, editing, edit history, or general mutation queues.
- Application-wide Layer composition, a new RPC transport, or schema migration.
- New comparison controls, product outcomes, automatic retries of comparison generation, or a new cleanup retry framework.
- Remote processing, data upload, production systems, and live databases.
- Parallel legacy and Effect implementations, feature flags, and speculative abstractions for later migrations.
- Broader Effect adoption before this experiment has been evaluated.

## Further Notes

This experiment teaches four concepts through an existing need: fibers own running work; scopes pair acquisition and cleanup; interruption coordinates cancellation; typed errors describe operational failures. Revision checks and snapshot ownership remain application rules.

The implementation report must include:

1. The selected Effect version and the completed verification results on both runtimes.
2. Before/after ownership explanations showing where connections, leases, and staging snapshots are acquired and released.
3. The manual flags, completion plumbing, and repeated release paths removed, with reasons for the domain bookkeeping that remains.
4. Production web JavaScript size, startup readiness, representative comparison duration, and cancellation-to-settlement measurements, including test conditions and variation.
5. Any reproducible regression and its practical impact. Do not hide regressions in aggregate measurements or add unrelated optimization work to compensate.
6. What became easier or harder to understand, and a recommendation to keep the localized adoption, revise it, or remove it.

Completion requires preserved behavior, successful verification, explicit resource ownership, and a concrete evaluation of the implementation and runtime costs. Passing tests alone does not justify expansion. The final recommendation is for Kevin to assess; it is not authorization for broader migration.

## Comments

Kevin confirmed the testing seams: existing CsvViewer requests and events on desktop and web, with existing lower-level tests for cancellation and cleanup races. No new testing seam is required.
