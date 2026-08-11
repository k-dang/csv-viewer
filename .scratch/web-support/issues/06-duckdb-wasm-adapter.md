# 06 - DuckDB-Wasm adapter passes the shared contract

**What to build:** A DuckDB-Wasm implementation of the internal database interface that makes the full engine-parameterized contract pass, proving the shared workspace runs unmodified on the browser engine before any web UI exists.

**Blocked by:** 05 - Engine-parameterized contract suite.

**Status:** ready-for-agent

- [ ] The adapter uses the official DuckDB-Wasm package's single-threaded asynchronous Worker build; no cross-origin isolation, no experimental multithreading.
- [ ] Native DuckDB and DuckDB-Wasm are pinned to exact package versions built on the same DuckDB core version (parity is defined by the bundled core, not the npm version; pin the native binding back if the Wasm core lags). Any unattainable parity difference goes in a reviewed allowed-divergence list.
- [ ] The database is in-memory only: no origin-private filesystem, IndexedDB persistence, or spill storage.
- [ ] Remote CSV URLs, runtime CDNs, dynamic extension installation, and extension autoload fetching are disabled, with tests or build assertions proving it.
- [ ] The full contract suite from ticket 05 passes against the Wasm adapter in a per-commit Node-hosted run (real-browser runs come in ticket 10).
- [ ] Type, null, and error normalization differences between engines are absorbed by the adapters, not the workspace.
