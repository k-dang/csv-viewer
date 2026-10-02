Status: ready-for-agent

# Harden workspace Effect conventions and resource release

## Problem Statement

The workspace Effect migration is implemented across native DuckDB and DuckDB-Wasm. Requests, database operations, Working CSV operations, and Aligned Comparison work compose Effects while the renderer retains its Promise and event interface. The remaining problems are cleanup correctness and inconsistent use of Effect's module and type conventions.

A failed Export CSV worker close is reported but the connection is forgotten. Disposal cannot retry a release that failed before the driver closed the connection. The existing controlled failure closes the real connection before returning an error, so its passing test does not prove recovery from an actual release failure.

The failure types also provide less protection than they appear to. DataEngineError is structurally equivalent to ordinary Error, and many Working CSV methods widen their failure channel to Error. A maintainer can introduce an undeclared failure without a compiler error. Service tags expose concrete implementation classes, and the composition root knows their constructors. Working CSV and table helpers frequently wrap reusable generator functions in Effect.gen while Comparison already uses fnUntraced. Web source registration and release convert Effects to Promises and immediately back to Effects.

For users, these changes must preserve CSV Viewer behavior: Local Processing, existing messages, Unexported Changes, edit history, Aligned Comparison cancellation, and safe close and disposal. For maintainers, each module should expose a precise interface and keep construction, failure classification, and resource ownership local.

## Solution

Finish the migration with a focused hardening pass. Retain failed export workers until their release succeeds, give declared failures distinct tagged types, move service construction into module-owned Layers, use reusable Effect function constructors consistently, and compose web source-access Effects directly.

Keep one composition root and the existing public CsvViewer interface. Preserve the current workspace lifetime: admitted requests settle before their resources are released, background Comparison work belongs to the workspace scope, and runtime adapters classify platform and driver failures. This work changes internal structure and closes a resource-release gap without adding product features.

## User Stories

1. As a user, I want Export CSV to release its worker connection, so that repeated exports do not accumulate abandoned resources.
2. As a user, I want a failed export worker release to preserve Unexported Changes, so that CSV Viewer does not claim undelivered work was exported.
3. As a user, I want disposal to retry an export worker release that failed earlier, so that closing the workspace attempts to release every resource it owns.
4. As a user, I want an unsuccessful cleanup retry to be reported, so that disposal does not silently claim success.
5. As a user, I want database release to proceed even when worker cleanup fails, so that one failure does not prevent later cleanup steps.
6. As a user, I want successful Export CSV to preserve edit history and mark the captured revision exported, so that undo and redo retain their existing meaning.
7. As a user, I want Export CSV prompts to remain outside table leases, so that a prompt does not prevent closing a Working CSV.
8. As a user, I want every current validation message to remain unchanged, so that internal error refactoring does not alter the guidance I receive.
9. As a user, I want unexpected failures to remain sanitized, so that driver details and CSV contents do not appear in messages or diagnostics.
10. As a user, I want an Aligned Comparison to cancel and release its worker before dependent resources are removed, so that later operations remain reliable.
11. As a user, I want admitted edits and reads to finish before disposal releases their resources, so that closing the workspace does not invalidate accepted work.
12. As a user, I want web startup interruption and fatal engine recovery to retain their current behavior, so that internal module changes do not leave a partially usable workspace.
13. As a user, I want all CSV processing to remain local, so that this refactoring does not change where my data lives.
14. As a maintainer, I want engine failures to have a distinct tagged type, so that an ordinary Error cannot satisfy the engine-failure contract accidentally.
15. As a maintainer, I want source-access failures to have a distinct tagged type, so that expected platform failures remain distinguishable from defects.
16. As a maintainer, I want Working CSV failure channels to name their declared failures, so that adding a new failure category requires an explicit type change.
17. As a maintainer, I want Comparison cleanup failures to retain their dedicated classification, so that cleanup and operation outcomes stay distinguishable.
18. As a maintainer, I want each service module to own its tag, interface, and Layer, so that construction knowledge lives beside the implementation.
19. As a maintainer, I want the composition root to compose Layers, so that it does not need to know implementation constructors.
20. As a maintainer, I want Layer requirements to describe dependencies, so that missing dependencies are visible to TypeScript.
21. As a maintainer, I want service interfaces to be independent of concrete classes, so that focused tests can supply narrow implementations without unsafe casts.
22. As a maintainer, I want reusable multi-step Effect functions to use fnUntraced or fn, so that Working CSV and Comparison follow consistent conventions.
23. As a maintainer, I want existing diagnostic stages to remain stable, so that function refactoring does not create duplicate tracing or change diagnostic meaning.
24. As a maintainer, I want web buffer registration and release to return Effects directly, so that their failure and interruption behavior compose without nested runners.
25. As a maintainer, I want pure query construction, history calculations, and serialization to remain ordinary functions, so that the refactoring does not spread Effect into code that has no effects.
26. As a maintainer, I want behavioral proof through the existing CsvViewer contracts on both engines, so that internal changes preserve the same product interface.
27. As a maintainer, I want compile-time checks for error distinctions, so that runtime tests are complemented by enforceable failure contracts.
28. As a maintainer, I want changes checked against the installed Effect version, so that examples from other repositories do not introduce unsupported APIs.

## Implementation Decisions

### Priority and sequence

1. Correct export worker release ownership and its behavioral coverage.
2. Introduce distinct tagged failures and narrow the affected failure channels.
3. Move service contracts and construction into module-owned Layers.
4. Align reusable generator functions with fnUntraced or fn.
5. Remove the redundant web source-access conversion.

Keep each change independently reviewable. This spec records one feature; it does not require a single large implementation PR.

### Export worker ownership

- The Working CSV module retains the release action for an export worker whose close did not succeed. Remove it from retained ownership only when release succeeds.
- Export preparation remains scoped. Release the worker and table lease before host delivery, and retain the current refusal to deliver or mark a revision exported after worker release fails.
- Retry retained export worker releases during workspace disposal before database release. Use the existing disposal pass; do not add automatic background retries, timers, or an unbounded retry loop.
- If a retry fails, continue the remaining cleanup and database release steps and report failed disposal. Repeated disposal calls retain the existing stable result rather than starting new cleanup passes.
- Keep worker-release failure visible as cleanup-failed and preserve the diagnostic privacy allowlist. Retaining a release action must not retain a closed operation scope or unrelated request state.
- Use Comparison's retained failed-worker release behavior as prior art, while keeping ownership in the module that acquired the export worker. Introduce shared machinery only if the implementation reveals necessary duplication.

### Failure contracts

- Use Data.TaggedError for internal DataEngineError and CsvSourceUnavailableError, consistent with WorkspaceRequestError. Preserve safe messages, source-access codes, and engine causes where currently needed.
- Keep ComparisonCleanupError distinct in cleanup diagnostics. Its existing inheritance need not survive if that would erase or conflict with the required error discriminants.
- Narrow Working CSV and internal request-dispatch failure channels to their actual declared failures, or let inference preserve those types. Ordinary Error must not be assignable as a declared engine or source-access failure.
- Expected validation remains Result or a typed Effect failure. Broken invariants remain defects. Do not turn defects into expected failures merely to satisfy narrower annotations.
- Runtime adapters continue to classify failures at their platform or driver edge. Transport translation retains existing public outcomes and messages. Tagged internal errors do not become a new renderer protocol.
- Use tag-based matching where it clarifies handling of declared failures. Preserve Cause handling where interruption, defects, or combined cleanup failures are intentionally contained or translated.

### Service modules and composition

- The Working CSV, Comparison, host, and database capabilities own their service tags and explicit interfaces. The owning modules define their construction Layers; the composition root supplies runtime implementations and composes those Layers in acquisition order.
- Keep private implementation classes where useful. Do not rewrite their state into closures merely for stylistic uniformity. Service interfaces must not expose private fields or require a concrete class instance.
- Keep test overrides at the existing capability seams. Adapt affected tests to module-owned construction or Layers, without creating a generic service framework or exporting compatibility constructors.
- Preserve a single shared database acquisition and the current release order. Layer composition must not accidentally create duplicate database or store instances.
- Preserve the manual workspace scope and entry runners. In the installed Effect implementation, ManagedRuntime tracks running fibers and interrupts them during disposal; substituting it would change the current admitted-work contract.
- Preserve explicit release outcomes for finalizers whose typed failure channel is never. Keep database release failure observable through the existing disposal result.

### Reusable Effect functions

- Use fnUntraced for reusable multi-step generator functions in Working CSV and table operations when the existing entry or stage already supplies tracing. Use named fn only at a useful tracing seam without duplicating existing stages.
- Keep Effect.gen for inline workflows and callbacks. Keep simple forwarding functions and combinator-only helpers simple; this is not a requirement to wrap every function.
- Preserve generic parameters, receiver behavior, scoped requirements, failure types, and interruption semantics. Attach function-level transforms using the supported function-constructor API.
- Keep diagnostic stage names, outcomes, attributes, and privacy rules unchanged. Do not add tracing of SQL, paths, source names, column names, cell values, or driver causes.

### Web source access

- Browser buffer registration and release return Effects directly. The web host yields those Effects when acquiring and releasing an engine-readable CSV Source reference.
- Delete the replaced Promise wrappers and their nested Effect runners. Keep raw driver Promises private to the runtime adapter, where they are classified once.
- Preserve failed-buffer-drop retention and retry behavior, source registration identity, startup cleanup, fatal-stop settlement, and interruption guarantees.

### Existing behavior to preserve

- CsvViewer requests, results, events, capabilities, and its Promise interface stay unchanged.
- Leases, mutation queue ordering, admission, artifact roles, Working CSV revisions, and Comparison dependency behavior retain their current rules.
- Pure query construction, edit-history calculation, result normalization, and export serialization remain ordinary functions.
- Mutable maps remain appropriate for synchronous bookkeeping. Introduce Ref or a synchronization primitive only for a concrete interleaving requirement.
- Remove superseded internal surfaces completely. Update nearby comments and the workspace ownership documentation to describe the final conventions.

## Testing Decisions

- The primary seam is the existing shared CsvViewer contract suite, exercised against native DuckDB and DuckDB-Wasm. Preserve existing result, event, message, edit-history, revision, lifecycle, and diagnostics assertions while adapting construction and fixtures.
- First reproduce the export release gap through a public Export CSV request using a real database adapter. Inject the failure before the real connection close occurs. The previously observed behavior was one failed close attempt and no retry during successful disposal.
- Add one focused shared contract scenario that proves failed export preparation does not deliver or clear Unexported Changes, disposal retries the still-owned connection, and successful retry actually closes it. Use a barrier or resource observation to establish release; an error returned after an already-successful close is insufficient proof.
- Cover persistent retry failure in a focused disposal scenario: the failure remains sanitized, disposal rejects, and database release still occurs. Extend existing lifecycle or diagnostics prior art instead of duplicating a complete export workflow.
- Use existing driver interruption tests to preserve cancellation, settlement, no unintended table publication, and connection reuse. Use existing host, startup, fatal-stop, and buffer-release tests for runtime-specific behavior.
- Add focused compile-time checks showing that ordinary Error cannot satisfy declared engine or source-access failure types and that narrowed service interfaces retain their intended failure types. Do not test the library's tagged-error implementation.
- A good test asserts user-visible behavior, released resources, stable diagnostic meaning, or a meaningful type guarantee. Do not count Layers or runners, assert a particular combinator, or add smoke tests for deleted compatibility code.
- Use synchronization barriers rather than arbitrary sleeps. Adapt tests to the final service interfaces without module mocking or unsafe casts that hide a contract mismatch.
- Run required typechecking, lint, tests, desktop and web builds, and the existing browser and built-bundle lifecycle suites after integration. Inspect lifecycle screenshots for visible defects.
- No new public test seam is required. Kevin confirmed the existing CsvViewer contracts on both engines as the primary seam, supplemented by driver/host tests for resource release and TypeScript checks for error categories.

## Out of Scope

- Effect in React state, renderer orchestration, Effect RPC, or changes to public requests, results, events, capabilities, and messages.
- An Effect version upgrade. Use the installed 4.0.0-rc.115 source as the API authority.
- Replacing the manual workspace runtime, changing disposal admission rules, or making currently drained mutations interruptible.
- Replacing the mutation queue or lease model merely to resemble a reference repository.
- A generic worker pool, retry subsystem, service graph framework, custom accessor proxy, or new synchronization abstraction.
- New diagnostic stages, outcomes, or logging of private data.
- Mechanical conversion of pure functions or all mutable state to Effect abstractions.
- New benchmark tooling, browser support claims, or unattended automation of native OS dialogs.

## Further Notes

### Audit evidence

The audit covered repository HEAD 65948e1. All 524 existing tests, typechecking, lint, both builds, nine browser tests, and two built-bundle lifecycle tests passed. The checking, unsupported, fatal, and recovered web screens were inspected without a visible defect. Passing tests do not negate the export release gap: its existing fixture reports failure only after the real connection closes.

A temporary native-database probe through CsvViewer confirmed that a pre-close export worker failure was not retried during disposal. The probe was removed after verification. An in-memory TypeScript probe separately confirmed that ordinary Error was assignable to DataEngineError without a diagnostic. These observations motivate the behavioral and compile-time acceptance criteria above.

The reference review used opensrc to fetch T3 Code, Effect, and OpenCode. T3 Code declared Effect 4.0.0-rc.112 and OpenCode declared 4.0.0-beta.83. opensrc could not resolve the requested Effect rc.115 tag and fetched the default branch; the installed rc.115 source was therefore used to verify available APIs and runtime behavior.

Prior art includes [Effect's function and service guidance](https://github.com/Effect-TS/effect/blob/main/LLMS.md), [T3 Code's service contracts and Layers](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/workspace/WorkspacePaths.ts), [OpenCode's module-owned service Layer](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/agent.ts), and [OpenCode's synchronous keyed-lock bookkeeping](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/effect/keyed-mutex.ts). These examples inform conventions; they do not justify copying larger architectures into CSV Viewer.

### Separate audit follow-ups

Refresh the existing Working CSV latency comparison after the final migration on comparable hardware; the recorded baseline predates it. This spec makes no claim of performance neutrality or improvement. Complete native Export CSV dialog and quit/menu verification with human interaction, and use an actual browser before making an unsupported-browser compatibility claim.

Complete asynchronous disposal logs after navigation are not required proof: unloading can destroy the old JavaScript context. The current navigation checks appropriately prove disposal initiation, old Worker closure, and a usable new workspace, while live-context contracts prove release ordering and failure handling.

## Comments

- Synthesized from Kevin's migration audit and idiomatic Effect review. This publishes the planned work; implementation has not started.
- Kevin confirmed the proposed testing seams: shared CsvViewer contracts on native DuckDB and DuckDB-Wasm, driver/host resource-release tests, and compile-time error-category checks.
