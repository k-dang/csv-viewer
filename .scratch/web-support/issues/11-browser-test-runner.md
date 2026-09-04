# 11 - Browser test runner for shared web behavior

**What to build:** The repository's first browser-based test runner, and the shared web behavior suite running on it across Chromium, Firefox, and WebKit.

This is infrastructure, not a checklist item. Today Vitest in Node is the only runner (`vitest.config.ts`), so nothing in the repository executes against a real browser engine. Ticket 10 depends on this existing and should not absorb standing it up.

**Blocked by:** 08 - Web Export CSV + lifecycle.

**Status:** ready-for-agent

- [ ] Start from Vitest's browser mode with the Playwright provider so the existing runner, aliases, and `packages/workspace` contract helpers are reused rather than duplicated under a second framework. Adopt standalone Playwright only if the shared suite cannot run under browser mode, and record why.
- [ ] Shared web behavior runs automatically against Chromium, Firefox, and WebKit. "Shared web behavior" means the web adapter surface that only a real engine can exercise: Worker startup and the capability check, file input selection, download delivery, the navigation guard, and fatal Worker handling.
- [ ] Node-run contract tests stay in Node. Do not move the DuckDB-Wasm workspace contract into the browser runner; it already runs headlessly through `workspaceContractFactories`.
- [ ] The browser suite runs in CI on a schedule or pre-release rather than per commit if a per-commit run is not sustainable. Decide from a measured run time, and record the measurement.
- [ ] Document how to run the browser suite locally, including engine installation.
