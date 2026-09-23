Status: complete

# 02 - Make comparison execution observable locally

**What to build:** A maintainer can follow an Aligned Comparison through its initiating request, computation, terminal outcome, and cleanup using correlated local structured logs that an agent can read to trace performance and failures. Workspace disposal is observable through the same setup. Diagnostics work on desktop and web without a remote observability account.

**Blocked by:** 01 - Run Aligned Comparisons under the workspace Effect runtime.

This slice instruments the comparison and disposal behavior delivered by ticket 01. It establishes the diagnostic conventions that ticket 03 will reuse for CSV open/reopen. Use Effect's existing logging and tracing facilities. Separate viewers, collectors and custom telemetry frameworks are outside scope.

- [x] Configure structured logging and tracing at workspace composition on both runtimes. Use the installed Effect release as the authority for supported APIs and tooling.
- [x] Record stable operation spans for Comparison execution and workspace disposal, with meaningful child stages such as Comparison Key validation, snapshot computation, and resource release. Avoid per-row or per-cell instrumentation.
- [x] Attach applicable opaque workspace, request, Working CSV, Comparison, and Comparison operation identifiers. Background Comparison work retains its initiating diagnostic context after the begin request finishes, through its terminal outcome and cleanup.
- [x] Record timings, product outcomes, and cleanup results. Distinguish invalid Comparison Key, source-change outcomes, user cancellation, recoverable failure, and unexpected defect. A failure returned as a product outcome must not appear as successful product execution merely because the Effect succeeded.
- [x] Associate secondary cleanup failures with the original operation while retaining useful normalized cause information. Replace scattered comparison and disposal logging in the migrated paths with the configured diagnostic output.
- [x] Keep default output local. Allow only approved identifiers, stage names, timings, counts, and normalized outcomes in diagnostic fields. Exclude CSV contents, CSV Source names and locations, raw request payloads, raw SQL, and unsanitized driver errors from logs and traces, including nested causes.
- [x] Document how an agent captures and reads diagnostic records on desktop and web, including stage timings and parent-child relationships.
- [x] Diagnostic output does not change product outcomes or prevent resource cleanup. Use the local console or a supplied Effect logger without introducing a buffering subsystem.
- [x] Capture emitted Effect log events through the logger supplied at workspace composition while driving existing CsvViewer requests, events, and disposal. Reuse that seam rather than introducing an internal execution interface for tests.
- [x] Verify correlation and stage relationships for Comparison success and cancellation, correct outcome classification for invalid Comparison Key and failure, and preservation of cleanup failure context. Assert diagnostic meaning rather than exact timestamps, generated identifiers, or incidental formatting.
- [x] Include sentinel CSV values, source names and locations, and a representative driver failure in diagnostic tests. Confirm captured output excludes sensitive input while retaining enough stage and outcome information to diagnose the operation.
- [x] Demonstrate an actual local trace for a successful and a failed or cancelled Comparison on both runtimes, including cleanup and disposal evidence. Run required type, lint, and relevant test checks.

**Completion evidence:** A maintainer can use documented local tooling to identify the Comparison, the stage it reached, its terminal outcome, and whether cleanup completed. Span names without working output do not satisfy this ticket.

## Comments

### Implementation and verification

The user clarified that standard Effect output is sufficient for agents to investigate performance. The implementation uses `Logger.consoleLogFmt`, `Effect.logInfo` and `Effect.withLogSpan`, with standard `Effect.withSpan` tracing. No custom serializer, tracer or output format is installed.

Only approved identifiers and normalized outcomes are logged. Cleanup retains its original operation context. Shared CsvViewer tests capture standard Effect logger events and formatted text, including success, cancellation, invalid keys, source changes, failures, deferred table cleanup, cleanup retries and a throwing logger.

See [Read diagnostics](../../../.agents/skills/verify-csv-viewer/SKILL.md#read-diagnostics) for capture instructions and timing interpretation.

Validation passed: type checks, lint, 351 tests across 33 files, and both application builds. The suite includes 22 native and Wasm diagnostic contracts. Live desktop and web checks emitted Effect-formatted success, invalid-key, resource release and disposal logs. Local evidence is in `.agents/skills/verify-csv-viewer/evidence/issue2/desktop-diagnostics.log` and `web-diagnostics.log`, with UI screenshots and snapshots alongside them. Web disposal used a controlled page-hide event with the context kept alive for observation; normal navigation remains best effort.
