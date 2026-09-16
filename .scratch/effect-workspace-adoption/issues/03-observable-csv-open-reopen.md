Status: ready-for-agent

# 03 - Migrate CSV open/reopen to observable Effect workflows

**What to build:** Opening and reopening a CSV Source use the established workspace Effect runtime, resource ownership model, and local diagnostics on desktop and web. Failed opens release staging resources. Failed reopens preserve the existing Working CSV. Successful reopens retain the CSV Tab and logical Working CSV identity while readers of the previous table finish safely.

**Blocked by:** 02 - Make comparison execution observable locally, which depends on 01 - Run Aligned Comparisons under the workspace Effect runtime.

This completes the initial adoption scope in the parent spec. Integrate with the runtime and diagnostic conventions from the preceding tickets. Preserve the existing CsvViewer contract and product behavior; full conversion of reads, mutations, Export CSV, Recent CSV Sources, React state, or DuckDB-Wasm startup is outside scope.

- [ ] Migrate CSV open/reopen orchestration, including source description and access, table preparation, metadata reads, publication, and required cleanup, to Effects composed under the workspace runtime. Retain promises at native library and transport interfaces as needed.
- [ ] Opening owns staging resources until successful publication transfers them to the Working CSV. Register cleanup before interruptible work can strand acquired resources. Successful publication retains the table for subsequent requests.
- [ ] Failed opens clean up partial resources. If cleanup itself fails, report both the operation and cleanup outcomes and retain ownership information for existing retry or disposal behavior rather than forgetting the resource.
- [ ] Reopen prepares a complete replacement before publication. A failed reopen preserves the prior Working CSV, rows, edit history, and identity. A successful reopen preserves existing logical identity and revision behavior and retires the previous backing table safely.
- [ ] Preserve outstanding source leases and artifact ownership until readers finish. Keep admission leases, per-Working CSV mutation ordering, and resolution of current state after queued work begins. Use Effect primitives only where they simplify coordination without weakening these guarantees.
- [ ] Preserve existing close confirmation and revision revalidation for Unexported Changes and dependent Comparisons. Reopening and publishing changed data continue to produce the established Comparison outcomes and Outdated Comparison behavior.
- [ ] Preserve duplicate-source handling, file-selection cancellation, Recent CSV Source behavior, dialect validation, and existing public failure messages and outcome shapes. Distinguish source access, dialect, and engine failures internally and translate them into public outcomes at the established interface.
- [ ] Disposal rejects new work and waits for already admitted open/reopen operations according to existing lifecycle rules. Non-cancellable driver work settles before cleanup can invalidate its resources; do not add user-facing cancellation controls or new timeout and retry policies.
- [ ] Emit correlated CSV open and reopen spans with meaningful child stages, normalized product outcomes, and cleanup results using ticket 02's conventions. Reuse its local output and privacy rules rather than adding another logger or tracing configuration.
- [ ] Delete superseded orchestration, obsolete logging, and temporary migration shims in the completed workflows. Keep pure query construction, serialization, and edit-history calculations as ordinary functions. Update ownership documentation and comments.
- [ ] Run shared Working CSV and lifecycle contracts against native DuckDB and DuckDB-Wasm through existing CsvViewer requests, events, and owner operations. Verify partial-allocation failure, failed reopen preservation, successful replacement with an active reader, and disposal racing an admitted open.
- [ ] Preserve existing concurrent mutation and source-change contract coverage. Use deterministic synchronization for races and existing resource observations or continued query behavior for ownership assertions rather than private implementation state.
- [ ] Capture open/reopen logs and spans at workspace composition and verify correlation, truthful failure classification, cleanup evidence, and exclusion of sensitive source data.
- [ ] Demonstrate opening, reopening with changed dialect options, failed reopen preservation, and workspace close through the app verification skill on desktop and web. Inspect actual local traces and run required type, lint, and relevant test checks.

**Completion evidence:** Both runtimes preserve Working CSV behavior and ownership through success, failure, active readers, and disposal. Local diagnostics identify the stage reached, the operation outcome, and cleanup result. Wrapping the existing promise orchestration without consolidating ownership and diagnostics is insufficient.

## Comments

