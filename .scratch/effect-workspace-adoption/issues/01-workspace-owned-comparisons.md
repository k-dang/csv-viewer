Status: ready-for-agent

# 01 - Run Aligned Comparisons under the workspace Effect runtime

**What to build:** Desktop and web run Aligned Comparisons as work owned by the workspace. Starting a Comparison returns promptly while computation continues. Cancellation, dependent Working CSV close, and workspace disposal settle the underlying work and cleanup before releasing resources. Maintainers get one execution model for comparison, with Effect composed internally and promises used at the renderer-facing transport interface.

**Blocked by:** None. Can start immediately.

This is the first slice of the parent spec, "Effect adoption for workspace operations and observability." Implement the workspace ownership changes through the complete comparison flow on both runtimes. Local tracing and structured diagnostic output are delivered by ticket 02; CSV open/reopen migration is delivered by ticket 03.

- [ ] Each workspace has one owned Effect runtime and resource scope, configured where its existing host and database adapters are composed. Keep the implementation compatible with the installed Effect release.
- [ ] A shared entry adapter executes migrated internal Effects and exposes the existing promise-based CsvViewer contract. Preserve requests, results, events, capabilities, and workspace-owner confirmation and disposal behavior. Effect values and live resources remain within the owning process.
- [ ] Comparison orchestration composes Effects and starts background work within workspace ownership. Remove independent execution calls from migrated internal modules rather than wrapping them in another execution layer.
- [ ] An accepted Comparison survives completion of its begin request, retains its operation identity, and emits the existing terminal outcome. Invalid Comparison Keys, source-change races, refresh, swap, and closing a Comparison preserve existing behavior.
- [ ] Cancelling a Comparison or closing dependent work stops and awaits the underlying driver query before releasing its connections, source leases, or result resources. Preserve native and Wasm cancellation behavior; interruption of a promise alone is insufficient.
- [ ] Workspace disposal rejects new admission, interrupts and awaits Comparison work, and preserves completion guarantees for already admitted CSV opens, reads, and edits. Dependent resources settle before the database closes. Concurrent disposal remains idempotent.
- [ ] Cleanup failures remain visible and retain the ownership information needed by existing retry or disposal behavior. Preserve the distinction between recoverable failures, cancellation, and unexpected defects, translating them into existing public outcomes at the appropriate entry interface.
- [ ] Retain shared-table leases and artifact ownership where required. Keep pure comparison rules and presentation as ordinary functions, and limit host or database adapter changes to the needs of this migration.
- [ ] Remove superseded comparison orchestration and temporary migration shims. Update comments and architecture documentation to describe the final ownership model. Keep usable existing failure reporting until ticket 02 replaces it.
- [ ] Verify success, invalid Comparison Key, source-change races, cancellation, dependent close, and disposal through existing CsvViewer requests, events, and workspace-owner operations on both native DuckDB and DuckDB-Wasm. Extend existing contract cases only for distinct missing guarantees.
- [ ] Use existing controlled executors and narrow driver tests where needed to prove cancellation settles before cleanup. Use synchronization barriers rather than timing sleeps, and assert behavior rather than private maps, Effect combinators, or fiber identifiers.
- [ ] Demonstrate comparison computation, cancellation, and workspace close through the app verification skill on desktop and web. Run required type, lint, and relevant test checks and resolve observed failures.

**Completion evidence:** Both runtimes preserve the comparison contract, background work remains alive after begin returns, and no Comparison work uses released resources after cancellation or workspace disposal.

## Comments

