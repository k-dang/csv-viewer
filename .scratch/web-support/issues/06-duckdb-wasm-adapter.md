# 06 - DuckDB-Wasm adapter + extracted internal database interface

**What to build:** A DuckDB-Wasm implementation that makes the full engine-parameterized contract pass, and - extracted from it together with the native driver - the internal database interface both engines sit behind.

The interface is extracted **here**, not earlier, and in this order: get DuckDB-Wasm working against the concentrated native-DuckDB modules from ticket 03, observe where the two engines actually diverge, then lift the interface that both need. An interface designed while only the native driver exists encodes `@duckdb/node-api` assumptions; this sequencing means it is derived from observed friction instead of guessed.

**Blocked by:** 00 - DuckDB-Wasm feasibility spike, 05 - Engine-parameterized contract suite.

**Status:** done

### Engine and pinning

- [x] The adapter uses the official DuckDB-Wasm package's single-threaded asynchronous Worker build; no cross-origin isolation, no experimental multithreading.
- [x] Native DuckDB and DuckDB-Wasm are pinned to the exact package versions ticket 00 identified as sharing a DuckDB core version (parity is defined by the bundled core, not the npm version). If ticket 00 found that parity requires moving native DuckDB, that move lands here with the existing native suite green.
- [x] Any unattainable parity difference is recorded in `.scratch/web-support/allowed-divergences.md` in the required entry format, with a linked tracking issue. A divergence observed by the contract suite and absent from that file blocks release.

### The extracted interface

- [x] All DuckDB access routes through one internal interface, extracted from the two working implementations rather than authored ahead of them. It covers only what both engines actually needed: parameter binding, row results, connection lifecycle, cancellation, and error normalization.
- [x] The interface is shaped by what the workspace needs, not by either driver's API; no driver types leak through it in either direction.
- [x] SQL construction, storage schema, edit history, comparison orchestration, and result normalization stay outside the adapters - the adapters remain narrow.
- [x] The existing `ComparisonExecutor` remains the domain module for Aligned Comparison execution above the interface; `DuckDbComparisonExecutor` is refactored to use interface connections rather than `@duckdb/node-api` types, and no competing comparison path is introduced.
- [x] Type, null, and error normalization differences between engines are absorbed by the adapters, not the workspace.

### Engine constraints made explicit

- [x] Connection separation is preserved as transaction/artifact ownership and cleanup isolation on both engines. Long Wasm comparison work uses the pending-query `send()` path so the single Worker can schedule owner-connection row windows while one comparison statement is running. The measured owner-connection latency is recorded. Bounded SQL statements are added only if representative measurements show that the pending-query path is insufficient.
- [x] The database interface exposes cancellable long-running execution without exposing driver-specific cancellation modes. The native adapter pairs that operation with `interrupt()` and the Wasm adapter pairs `send()` with `cancelSent()`. Both normalize cancellation errors to the same observable outcome: a cancelled operation reports cancelled, publishes nothing, and releases its artifacts.
- [x] The native adapter preserves dedicated owner/worker connection behavior, operation cancellation, publication ordering, artifact ownership and cleanup, read survival, and deterministic disposal, with observable assertions unchanged.

### Isolation and cost

- [x] The database is in-memory only: no origin-private filesystem, IndexedDB persistence, or spill storage.
- [x] Remote CSV URLs, runtime CDNs, dynamic extension installation, and extension autoload fetching are disabled, with tests or build assertions proving it.
- [x] The full contract suite from ticket 05 passes against the Wasm adapter in a Node-hosted run (real-browser runs come in ticket 10).
- [x] The added wall-clock of the dual-engine run is measured and recorded. If a full per-commit dual-engine run is not sustainable, split it from that measurement: full contract against native per commit, full contract against Wasm on a scheduled and pre-release run, fast Wasm subset per commit. Document what the per-commit run does and does not cover.

## Comments

Implemented with `@duckdb/node-api@1.5.5-r.4` and `@duckdb/duckdb-wasm@1.33.1-dev64.0`, both reporting DuckDB core v1.5.5. The Node-hosted fixture uses the single-threaded MVP Worker and the same workspace contract factories as native DuckDB. No contract divergence was observed, so `allowed-divergences.md` remains empty.

On 2026-08-30, the same T3 workstation described in `spike-findings.md` returned an owner-connection `SELECT 42` in 119.71 ms while a one-trillion-pair CTAS was pending through `send()`. The pending statement was then cancelled through `cancelSent()`. No table was published and the worker connection remained usable. Bounded comparison statements were not needed.

The five contract files ran 84 native cases in 3.23 seconds and 168 dual-engine cases in 29.51 seconds, an added wall-clock cost of 26.28 seconds. The full native and Wasm contract remains part of the ordinary Vitest run; there is no scheduled-only coverage split.
