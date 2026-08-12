# 06 - DuckDB-Wasm adapter + extracted internal database interface

**What to build:** A DuckDB-Wasm implementation that makes the full engine-parameterized contract pass, and - extracted from it together with the native driver - the internal database interface both engines sit behind.

The interface is extracted **here**, not earlier, and in this order: get DuckDB-Wasm working against the concentrated native-DuckDB modules from ticket 03, observe where the two engines actually diverge, then lift the interface that both need. An interface designed while only the native driver exists encodes `@duckdb/node-api` assumptions; this sequencing means it is derived from observed friction instead of guessed.

**Blocked by:** 00 - DuckDB-Wasm feasibility spike, 05 - Engine-parameterized contract suite.

**Status:** ready-for-agent

### Engine and pinning

- [ ] The adapter uses the official DuckDB-Wasm package's single-threaded asynchronous Worker build; no cross-origin isolation, no experimental multithreading.
- [ ] Native DuckDB and DuckDB-Wasm are pinned to the exact package versions ticket 00 identified as sharing a DuckDB core version (parity is defined by the bundled core, not the npm version). If ticket 00 found that parity requires moving native DuckDB, that move lands here with the existing native suite green.
- [ ] Any unattainable parity difference is recorded in `.scratch/web-support/allowed-divergences.md` in the required entry format, with a linked tracking issue. A divergence observed by the contract suite and absent from that file blocks release.

### The extracted interface

- [ ] All DuckDB access routes through one internal interface, extracted from the two working implementations rather than authored ahead of them. It covers only what both engines actually needed: parameter binding, row results, connection lifecycle, cancellation, and error normalization.
- [ ] The interface is shaped by what the workspace needs, not by either driver's API; no driver types leak through it in either direction.
- [ ] SQL construction, storage schema, edit history, comparison orchestration, and result normalization stay outside the adapters - the adapters remain narrow.
- [ ] The existing `ComparisonExecutor` remains the domain module for Aligned Comparison execution above the interface; `DuckDbComparisonExecutor` is refactored to use interface connections rather than `@duckdb/node-api` types, and no competing comparison path is introduced.
- [ ] Type, null, and error normalization differences between engines are absorbed by the adapters, not the workspace.

### Engine constraints made explicit

- [ ] Connection separation is preserved as transaction/artifact ownership and cleanup isolation on both engines. Where ticket 00 confirmed that the single-threaded Worker serializes execution, comparison work is issued as bounded statements so the owner connection stays responsive to row-window queries during a comparison, and the measured owner-connection latency is recorded.
- [ ] Cancellation is an explicit capability with two shapes - preemptive (native `interrupt()`) and cooperative (statement boundary). The comparison executor is correct under the weaker shape. Observable outcome is identical on both: a cancelled operation reports cancelled, publishes nothing, and releases its artifacts.
- [ ] The native adapter preserves dedicated owner/worker connection behavior, operation cancellation, publication ordering, artifact ownership and cleanup, read survival, and deterministic disposal, with observable assertions unchanged.

### Isolation and cost

- [ ] The database is in-memory only: no origin-private filesystem, IndexedDB persistence, or spill storage.
- [ ] Remote CSV URLs, runtime CDNs, dynamic extension installation, and extension autoload fetching are disabled, with tests or build assertions proving it.
- [ ] The full contract suite from ticket 05 passes against the Wasm adapter in a Node-hosted run (real-browser runs come in ticket 10).
- [ ] The added wall-clock of the dual-engine run is measured and recorded. If a full per-commit dual-engine run is not sustainable, split it from that measurement: full contract against native per commit, full contract against Wasm on a scheduled and pre-release run, fast Wasm subset per commit. Document what the per-commit run does and does not cover.
