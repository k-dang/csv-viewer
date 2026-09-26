Status: ready-for-agent

# Effect adoption for workspace operations and observability

## Problem Statement

Maintainers need to understand what CSV Viewer is doing when an Aligned Comparison hangs, opening a CSV Source fails, or resource cleanup does not complete. Today, comparison uses Effect for parts of its execution, while the surrounding workspace uses promises, manual work tracking, and scattered console logging. Following one operation through those mechanisms requires reading several implementations.

The existing Effect adoption does not yet provide a consistent workspace lifetime or diagnostic context. Comparison starts Effects internally and uses untraced functions. Working CSV operations separately coordinate leases, mutation queues, table retirement, and disposal. This makes failures and concurrency harder to reason about and increases the chance that future changes omit cleanup or lose diagnostic context.

The goal is broader, coherent Effect adoption that improves observability and maintainability. Success is measured by simpler operation ownership and useful diagnostics, rather than the number of functions converted to Effect.

## Solution

Establish Effect as the standard for asynchronous orchestration inside the workspace. Give each workspace one execution lifetime and consistent logging and tracing configuration. First consolidate the existing comparison implementation under that lifetime, then migrate Working CSV open and reopen, including the resource ownership and cleanup needed by those operations.

Maintainers can follow an operation from admission through database work to its outcome and cleanup using correlated local logs and development traces. Users retain the existing desktop and web behavior, including comparison cancellation, close confirmation, edit history, and Local Processing.

The renderer-facing CsvViewer remains a transport contract with serializable requests, results, and events. Internally, migrated operations compose Effects. A shared adapter converts them to promises when desktop or web enters the workspace.

## User Stories

1. As a maintainer, I want workspace operations to share an Effect execution lifetime, so that I can understand who owns their work and resources.
2. As a maintainer, I want operation spans with stable names, so that I can identify which operation is slow or failing.
3. As a maintainer, I want child spans for meaningful database and cleanup steps, so that I can locate the step where an operation stopped progressing.
4. As a maintainer, I want logs to carry the applicable workspace, request, Working CSV, Comparison, and Comparison operation identifiers, so that I can follow related activity without matching message text.
5. As a maintainer, I want a Comparison's execution to remain traceable after its begin request returns, so that asynchronous completion does not lose its initiating context.
6. As a maintainer, I want diagnostics to distinguish expected failure, interruption, and unexpected defects, so that I can investigate the correct cause.
7. As a maintainer, I want cleanup failures associated with the original operation, so that a secondary failure does not hide what first went wrong.
8. As a maintainer, I want usable local structured logs, so that I can diagnose failures without a remote observability account.
9. As a maintainer, I want documented local diagnostic output that an agent can read, so that I can inspect operation timings and parent-child relationships.
10. As a user, I want CSV contents and local file paths excluded from diagnostic attributes, so that troubleshooting preserves Local Processing and source privacy.
11. As a user, I want a Comparison to continue after its begin request is accepted, so that the interface remains responsive while results are computed.
12. As a user, I want cancelling a Comparison to stop its database work before resources are released, so that later operations remain reliable.
13. As a user, I want closing a dependent Working CSV to wait for the required Comparison cleanup, so that resources are not released while still in use.
14. As a user, I want workspace disposal to reject new work and settle admitted work according to its existing rules, so that closing the app does not leave work running against a closed database.
15. As a user, I want an unsuccessful CSV open to clean up partially created resources, so that I can continue using the workspace.
16. As a user, I want an unsuccessful reopen to preserve my existing Working CSV and its edit history, so that a parsing failure does not discard my work.
17. As a user, I want a successful reopen to retain the same CSV Tab and logical Working CSV identity, so that my workspace remains understandable.
18. As a user, I want existing readers to finish safely when reopen replaces a backing table, so that active reads do not fail because their table was removed too early.
19. As a user, I want edits and reopen to retain their existing per-Working CSV ordering, so that concurrent actions cannot corrupt rows or history.
20. As a user, I want close confirmation to continue reflecting current Unexported Changes and dependent Comparisons, so that I can make an informed decision before discarding work.
21. As a user, I want the same results and failure behavior on desktop and web, so that runtime differences do not change how I use CSV Viewer.
22. As a maintainer, I want to test migrated behavior through the existing CsvViewer contract, so that tests survive internal refactoring.
23. As a maintainer, I want tests to capture Effect log events through workspace configuration, so that observability can be verified through in-memory capture.
24. As a maintainer, I want completed migrations to remove the orchestration they replace, so that I do not have to maintain two competing implementations.

## Implementation Decisions

- Deliver in two increments within this feature. First establish workspace execution ownership and local diagnostics, and move existing comparison execution into that model. Then migrate CSV open/reopen and their required resource handling. Full conversion of every workspace operation is a later task.
- Separate the internal Effect-based workspace interface from the renderer-facing CsvViewer transport interface. Preserve public request, result, event, capability, and close-confirmation behavior. Effect values and live resources stay inside the owning process.
- Create one workspace-owned runtime and scope at composition. Desktop and web supply their existing host and database adapters plus diagnostic configuration there. Centralize Effect execution and conversion to transport outcomes in a shared entry adapter. Migrated internal modules compose Effects rather than independently invoking execution functions.
- Modify workspace composition and dispatch, Comparison orchestration and execution, Working CSV open/reopen, and their cleanup integration. Adapt host and database calls where these workflows require Effect composition. Keep driver-specific behavior in the existing native and Wasm adapters.
- Treat background Comparison work as workspace-owned. The initiating request can finish while the Comparison continues. Preserve its operation identifier and diagnostic context until the terminal event and cleanup finish. Cancelling or closing a Comparison awaits the relevant interruption and cleanup.
- Preserve disposal semantics rather than applying blanket interruption. Comparison work is interrupted and awaited as required; already admitted CSV opens, reads, and edits retain their existing completion guarantees. Disposal stops new admission, releases dependent resources in a safe order, and closes the database after work using it has settled. Concurrent disposal remains idempotent and cleanup failures remain visible.
- Use scoped acquisition and finalization for resource ownership in migrated workflows. Opening owns its staging resources until successful publication transfers ownership to the Working CSV. Reopening publishes a fully prepared replacement and retires the prior table while preserving outstanding readers. Register cleanup before interruptible work can strand an acquired resource.
- Keep explicit shared-table leases and the artifact registry where they encode real ownership. A scope alone does not replace reference counting or retirement rules. Preserve admission leases, mutation ordering, and resolution of the current Working CSV after queued work begins. Replace manual coordination only where Effect provides equivalent guarantees with less implementation complexity.
- On cleanup failure, retain enough ownership information for the existing retry or disposal behavior and report the failure. Running a finalizer is not evidence that the resource was successfully released.
- Preserve driver cancellation semantics. Interrupting a wrapped promise does not by itself stop DuckDB work. Cancellable operations must stop and await the driver before dependent resources are released; non-cancellable operations must settle before cleanup can invalidate their resources.
- Model recoverable internal failures explicitly and translate them once into the existing public outcomes. Keep user cancellation and invalid Comparison Keys as their existing product outcomes. Unexpected defects and cleanup failures retain diagnostic causes without exposing raw engine details to callers.
- Name top-level spans by operation, including CSV open, CSV reopen, Comparison computation, and workspace disposal. Add child spans for stages that explain latency or cleanup, such as source access, table preparation, Comparison Key validation, snapshot computation, and resource release. Avoid spans for each row or cell.
- Correlate logs and traces using opaque identifiers already available to the operation, adding a workspace or request identifier where needed. Record terminal product outcome separately from Effect success so a returned failure outcome cannot appear as a successful product operation. Capture interruption, failure category, timing, and cleanup result.
- Use Effect's logging and tracing facilities directly. Configure local structured output that agents can read to inspect stage timings, parent-child relationships, outcomes and cleanup. Document how to capture it and prove it works on both runtimes.
- Keep the default diagnostic output local. Trace and log fields use an allowlist of identifiers, stage names, timings, counts, and normalized outcomes. Do not serialize request payloads, CSV values, CSV Source names or locations, raw SQL, or unsanitized driver errors into diagnostic output.
- Diagnostic output must not block resource cleanup or change a successful product result when a development viewer is absent or disconnected. Use existing tooling's bounded handling of diagnostic output rather than introducing a new buffering subsystem.
- Keep pure query construction, comparison presentation, serialization, and edit-history calculations as ordinary functions. Introduce dependencies at existing real seams; Effect adoption does not require a new module or Layer for every helper.
- Delete superseded promise orchestration, obsolete logging, and temporary migration shims in each completed increment. Retain promises where native libraries or transport require them. Keep comments and architecture documentation aligned with the resulting ownership model.

## Testing Decisions

- Use CsvViewer requests and emitted events as the primary behavioral seam, with the existing workspace-owner confirmation and disposal interface for lifecycle assertions. Run the shared workspace contracts against both native DuckDB and DuckDB-Wasm. Preserve this highest shared seam rather than introducing a parallel internal test interface.
- Reuse the Working CSV, comparison, editing, and lifecycle contract suites. They already cover real comparison execution, source changes during generation, closing dependent work, rejecting late admission, waiting for admitted opens and reads, concurrent mutations, and idempotent disposal.
- A good test asserts results, event sequences, retained user data, released resources, or emitted diagnostic meaning. Do not assert Effect combinator choices, private maps, fiber identifiers, exact timestamps, or incidental log formatting.
- Capture standard Effect logger events through the logger supplied at workspace composition. Drive ordinary requests through CsvViewer and verify operation correlation, stage relationships, terminal outcome classification, and cleanup evidence. Use a sentinel CSV value and source location to verify neither appears in captured diagnostics.
- Exercise Comparison success, invalid Comparison Key, cancellation during database work, source-change races, and cleanup failure. Verify accepted background work survives the begin request and cannot outlive workspace disposal. Use existing controlled executors or driver tests for deterministic failure and cancellation timing.
- Exercise failed CSV open after partial allocation, failed reopen preserving the prior Working CSV, successful replacement with an active reader, and disposal racing an admitted open. Assert ownership through continued query behavior and existing resource observations rather than inspecting implementation internals.
- Keep narrow driver tests where they are necessary to prove that cancellation settles an underlying query before cleanup. Shared contract tests cannot substitute for this adapter-specific guarantee.
- Use synchronization barriers rather than wall-clock sleeps to test ordering. Extend existing cases when possible; add a new case only for a distinct behavioral or diagnostic requirement.
- Verify representative desktop and web flows through the project's app verification skill: open two CSV Sources, compute and cancel an Aligned Comparison, reopen a Working CSV with changed dialect options, and close the workspace. Inspect UI behavior and demonstrate a usable local trace for a successful operation and a failed or cancelled operation.
- Run the repository's required type, lint, and test checks, plus the relevant native, Wasm, and browser verification for changed behavior. Fix observed failures rather than weakening assertions to accommodate the migration.

## Out of Scope

- Converting the entire repository in one change, including React state, all reads and mutations, Export CSV, Recent CSV Sources, or every database adapter method.
- Rebuilding DuckDB-Wasm startup and fatal-worker recovery as a separate Effect project. Make only the composition and disposal adjustments required to preserve existing behavior.
- New user-facing cancellation controls, retry policies, timeout policies, or changes to Comparison and Working CSV outcomes.
- Replacing shared-table ownership rules solely because Effect scopes are available.
- Separate trace viewers, telemetry collectors, remote telemetry services, analytics, durable diagnostic archives, and benchmark or metrics dashboards.
- An Effect version upgrade unless implementation identifies and documents a concrete compatibility requirement.

## Further Notes

The architectural direction comes from the user's preference for broader Effect adoption to improve observability and maintainability. The bounded first adoption scope is comparison consolidation followed by CSV open/reopen. The remaining workspace operations can adopt the same model in later work.

The user confirmed the existing CsvViewer contracts as the test seam, including requests, events, and workspace disposal across desktop and web, with Effect log events captured at workspace composition.

Completion requires both migration increments, preserved desktop and web behavior, working local diagnostic output, and evidence that a maintainer can follow an operation to the step it reached, its outcome, and its cleanup result. Merely wrapping existing promises in Effect or adding span names without a usable diagnostic output does not complete the feature.

Use the installed Effect release as the implementation authority. Consult its source and matching documentation before choosing runtime, tracing, or scope APIs. Relevant references include [Effect resource scopes](https://effect.website/docs/v4/resource-management/scope), [structured logging and annotations](https://effect.website/docs/v4/observability/logging).

## Comments

### Ticket 04 added 2026-09-25

Ticket 03 connected reopen to the existing promise-based mutation queue instead of replacing the queue. The Working CSV store now has two mutation paths and two lease release paths. Ticket 04 consolidates them and sends every CsvViewer request through the shared entry adapter. The feature is complete when 04 is complete.
