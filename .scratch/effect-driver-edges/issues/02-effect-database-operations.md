# 02 — Add Effect database operations on both runtimes

**What to build:** Native DuckDB and DuckDB-Wasm expose database Effects that classify driver failures at the runtime edge and make interruption safe for every caller. Interrupting a cancellable query stops and awaits its driver work; interrupting a non-cancellable query waits for the driver to settle. Database acquisition, startup checks, and release also arrive at the workspace as Effects, preserving the existing lifetime behavior.

**Blocked by:** None — can start immediately. The resource-lifetime changes are implemented; remaining web UI verification is carried into ticket 06.

**Status:** ready-for-agent

- [ ] Expand the database and connection interfaces with Effect-returning operations alongside the existing query surface so unmigrated consumers still compile and behave correctly. Keep compatibility limited to what tickets 03 and 04 require; ticket 06 removes it completely.
- [ ] Provide typed `DataEngineError` failures for running queries, reading objects, cancellable query variants, obtaining the owner connection, acquiring workers, and closing connections. Preserve caller ownership of workers and runtime ownership of the database.
- [ ] Both adapters use one shared driver-Promise helper exported by the shared database module. Runtime adapters invoke this helper to normalize driver rejections once. Workspace consumers compose the resulting Effects without invoking a Promise adapter. Any temporary legacy normalization has no new independent classification policy.
- [ ] State and implement the interruption rule on the interface: cancellable work requests cancellation and waits for the pending driver operation to settle before interruption completes; non-cancellable work is uninterruptible from start through settlement. Keep Wasm's cancellable result stream separate from concurrent short owner-connection queries.
- [ ] Migrate runtime composition's database acquisition, startup check, acquisition-failure cleanup, owner-connection release, and engine release to Effect inputs. No database Promise callback is adapted inside the workspace runtime after this ticket.
- [ ] Preserve interrupted startup, fatal engine stop, partial-acquisition cleanup, release ordering, and memoized disposal failures. Query interruption rules must not make interrupted web startup wait forever for a stopped Worker.
- [ ] Extend native and Wasm adapter tests on real drivers: cancellation waits for settlement, publishes no result table, and leaves the connection usable; non-cancellable interruption completes only after settlement; driver errors produce sanitized `DataEngineError` failures without driver text. Use synchronization barriers rather than sleeps.
- [ ] Preserve invariant defects from pure result normalization. Preserve existing diagnostic stages, outcomes, cleanup reporting, and privacy rules.
- [ ] Update runtime callers, contract fixtures, and failure-injection seams for the expanded interface without weakening behavioral assertions. Relevant adapter, composition, startup, and shared contract suites pass on both runtimes; type and lint checks pass.

## Comments

- This is the expand step of the approved migration. It makes the new contract independently verifiable while retaining only the legacy surface needed by consumers awaiting migration. `cancelRunning` is absent from the new interface and remains only as long as legacy consumers require it.
