# 04 - CsvViewerRuntime renderer seam + menu intents

**What to build:** React depends on one injected CsvViewerRuntime module and nothing else about its host. On desktop the runtime is an IPC proxy over the main-process CsvWorkspace; application-menu commands arrive as shared domain intents. This is the seam a web composition root will later plug into.

**Blocked by:** 03 - Shared CsvWorkspace extraction.

**Status:** ready-for-agent

- [ ] CsvViewerRuntime is injected at the renderer composition root; renderer code never touches the Electron preload global, IPC channel names, or runtime-name checks.
- [ ] The runtime is a thin facade: workspace surface plus explicit capabilities plus intent subscriptions - it does not re-abstract or restate domain operations with different shapes.
- [ ] Genuine runtime differences (Recent CSV Source availability, export delivery, capacity) are expressed as explicit capabilities, not optional methods, no-ops, fake empty results, or platform-named booleans.
- [ ] Application-menu requests are translated into shared domain intents before reaching React; no Electron command names appear in renderer code.
- [ ] Renderer behavior and capability-dependent presentation are testable through a test runtime with no Electron or browser globals.
- [ ] Desktop application behaves identically end to end; existing renderer tests pass against the seam.
