Status: ready-for-agent

# 02 - Make comparison execution observable locally

**What to build:** A maintainer can follow an Aligned Comparison through its initiating request, computation, terminal outcome, and cleanup using correlated local structured logs and a working development trace viewer. Workspace disposal is observable through the same setup. Diagnostics work on desktop and web without a remote observability account.

**Blocked by:** 01 - Run Aligned Comparisons under the workspace Effect runtime.

This slice instruments the comparison and disposal behavior delivered by ticket 01. It establishes the diagnostic conventions that ticket 03 will reuse for CSV open/reopen. Use Effect's existing logging and tracing facilities and a compatible existing viewer; a custom telemetry framework or viewer is outside scope.

- [ ] Configure structured logging and tracing at workspace composition on both runtimes. Use the installed Effect release as the authority for supported APIs and tooling.
- [ ] Record stable operation spans for Comparison execution and workspace disposal, with meaningful child stages such as Comparison Key validation, snapshot computation, and resource release. Avoid per-row or per-cell instrumentation.
- [ ] Attach applicable opaque workspace, request, Working CSV, Comparison, and Comparison operation identifiers. Background Comparison work retains its initiating diagnostic context after the begin request finishes, through its terminal outcome and cleanup.
- [ ] Record timings, product outcomes, and cleanup results. Distinguish invalid Comparison Key, source-change outcomes, user cancellation, recoverable failure, and unexpected defect. A failure returned as a product outcome must not appear as successful product execution merely because the Effect succeeded.
- [ ] Associate secondary cleanup failures with the original operation while retaining useful normalized cause information. Replace scattered comparison and disposal logging in the migrated paths with the configured diagnostic output.
- [ ] Keep default output local. Allow only approved identifiers, stage names, timings, counts, and normalized outcomes in diagnostic fields. Exclude CSV contents, CSV Source names and locations, raw request payloads, raw SQL, and unsanitized driver errors from logs and traces, including nested causes.
- [ ] Provide and document a working development trace viewer setup for desktop and web. If a local collector is required, enable it explicitly and send only sanitized records. Remote telemetry, durable diagnostic archives, and a custom viewer remain outside scope.
- [ ] An absent or disconnected viewer does not change product outcomes or prevent resource cleanup. Use existing tooling's bounded output handling rather than introducing a new buffering subsystem.
- [ ] Capture emitted logs and spans through dependencies supplied at workspace composition while driving existing CsvViewer requests, events, and disposal. Reuse that seam rather than introducing an internal execution interface for tests.
- [ ] Verify correlation and stage relationships for Comparison success and cancellation, correct outcome classification for invalid Comparison Key and failure, and preservation of cleanup failure context. Assert diagnostic meaning rather than exact timestamps, generated identifiers, or incidental formatting.
- [ ] Include sentinel CSV values, source names and locations, and a representative driver failure in diagnostic tests. Confirm captured output excludes sensitive input while retaining enough stage and outcome information to diagnose the operation.
- [ ] Demonstrate an actual local trace for a successful and a failed or cancelled Comparison on both runtimes, including cleanup and disposal evidence. Run required type, lint, and relevant test checks.

**Completion evidence:** A maintainer can use documented local tooling to identify the Comparison, the stage it reached, its terminal outcome, and whether cleanup completed. Span names without working output do not satisfy this ticket.

## Comments

