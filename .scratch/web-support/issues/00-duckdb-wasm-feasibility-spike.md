# 00 - DuckDB-Wasm feasibility spike (throwaway)

**What to build:** Nothing shippable. A throwaway branch that answers the three load-bearing DuckDB-Wasm questions the rest of this plan is built on, before any seam is designed around the answers. Wire `@duckdb/duckdb-wasm` directly against the current `WorkingCsvStore` and `DuckDbComparisonExecutor` - no interface, no extraction, no cleanliness - and measure. The code is deleted when the findings are recorded.

**Blocked by:** None - can start immediately.

**Blocks:** 03 (host interface shape), 05 (cancellation assertions), 06 (adapter and interface design).

**Status:** ready-for-agent

- [ ] **Core parity.** Determine the newest DuckDB core version available in both `@duckdb/node-api` and `@duckdb/duckdb-wasm` today, and the exact package versions that carry it. Record whether reaching parity requires downgrading native DuckDB from the current `1.5.2-r.1`, and by how much. If no shared core exists, record what the closest pairing is and which DuckDB features the gap covers.
- [ ] **Existing suite against the parity pairing.** If parity requires moving native DuckDB, run the current native test suite on the proposed native version and record what breaks. A parity pairing that regresses green comparison behavior is a finding, not a detail.
- [ ] **Cancellation.** Establish what cancellation `@duckdb/duckdb-wasm` actually offers on the single-threaded asynchronous Worker build: whether any per-connection preemptive interrupt equivalent to native `connection.interrupt()` exists, and if not, what the achievable granularity is. Reproduce the `DuckDbComparisonExecutor` cancellation path against it (`duckdb-comparison-executor.ts:217-222`) on a comparison large enough to take seconds.
- [ ] **Concurrency.** Measure whether an owner-connection row-window query returns promptly while a long comparison query runs on a second connection. Report the observed owner-connection latency. This confirms or refutes the PRD's claim that connection separation is logical rather than concurrent.
- [ ] **Chunking.** If cancellation is cooperative and/or the owner connection is starved, determine whether issuing comparison work as bounded statements restores acceptable cancellation latency and owner responsiveness, and roughly what statement size is needed. This is the input that decides whether `ComparisonExecutor` needs restructuring in ticket 06.
- [ ] **Ingest shape.** Confirm how a browser-selected file reaches SQL: buffer registration and the `read_csv_auto` call shape it produces, versus the current path-based call at `working-csv-store.ts:341`. Note any dialect-sniffing or option differences from the native path.
- [ ] **Row materialization.** Confirm the cost and shape of turning Wasm query results into the row objects the workspace expects, versus native `runAndReadAll().getRowObjectsJS()`. Note type and null differences observed on the existing fixtures.
- [ ] Findings are written to `.scratch/web-support/spike-findings.md`: one section per question, each with the observed answer, the evidence, and its consequence for tickets 03, 05, and 06. Where a finding contradicts the PRD's "Engine Constraints That Shape the Design" section, the PRD is corrected.
- [ ] The spike branch is deleted. No spike code is merged, and no ticket depends on it existing.
