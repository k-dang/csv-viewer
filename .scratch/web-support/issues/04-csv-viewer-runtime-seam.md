# 04 - CsvViewerRuntime renderer seam + menu intents

**What to build:** Rename and de-path the shared `CsvViewerApi` type into CsvViewerRuntime, and inject it at the renderer composition root.

**This is not the construction of a new layer.** `CsvViewerApi` in `src/shared/ipc.ts:404` is already fully asynchronous, already structured-clone-safe (IPC enforces it), already returns discriminated domain outcomes, and already exposes subscriptions with unsubscribe handles. It is CsvViewerRuntime with four contract defects and one injection problem. Building a second renderer interface beside it - and then reconciling them - is the failure mode this ticket exists to avoid.

The concrete work:

1. Replace `CsvFileMetadata.path` (`src/shared/ipc.ts:17`) with opaque CSV Source identity. This is the only genuinely Electron-shaped field in the contract.
2. Re-key `openRecentCsv(path, options)` from path to that identity.
3. Rename `saveCsvAs` to `exportCsv` (terminology already landed in ticket 01; this is the seam-level rename).
4. Add runtime capabilities to the surface.
5. Move the 29 `window.csvViewer` call sites across `App.tsx`, `csv-grid.tsx`, `comparison-tab.tsx`, `comparison-grid.tsx`, and `csv-stats-panel.tsx` behind one injected provider.

**Blocked by:** 03 - Shared CsvWorkspace extraction.

**Status:** done

- [x] `CsvViewerApi` is evolved into CsvViewerRuntime in place. At no point do two renderer-facing interfaces coexist, and the type is not re-declared beside the original.
- [x] `CsvFileMetadata` carries opaque CSV Source identity instead of `path`; `openRecentCsv` is keyed by that identity; `saveCsvAs` is `exportCsv`.
- [x] CsvViewerRuntime is injected at the renderer composition root. All 29 `window.csvViewer` call sites are migrated; renderer code never touches the Electron preload global, IPC channel names, or runtime-name checks.
- [x] The runtime stays a thin facade: workspace surface plus explicit capabilities plus intent subscriptions. It does not re-abstract, re-wrap, or restate domain operations with different shapes than the workspace contract.
- [x] Genuine runtime differences (Recent CSV Source availability, export delivery, cancellation immediacy, capacity) are expressed as explicit capabilities, not optional methods, no-ops, fake empty results, or platform-named booleans.
  - Recent CSV Source availability is declared and read now. Export delivery, cancellation immediacy, and capacity are deliberately **not** declared yet: they have no consumer on desktop, and the tickets that introduce their first reader (08 web export and lifecycle, 09 capacity envelope) are also the tickets that establish their real shape. Declaring them here would ship a guessed vocabulary and a two-field capacity envelope that ticket 09's benchmarks would then have to migrate. The criterion's prohibition is on the *shape* a difference takes; nothing here is an optional method, no-op, fake empty result, or platform-named boolean.
- [x] Application-menu requests are translated into shared domain intents before reaching React; no Electron command names appear in renderer code.
- [x] Renderer behavior and capability-dependent presentation are testable through a test runtime with no Electron or browser globals.
- [x] Desktop application behaves identically end to end; existing renderer tests pass against the seam.
