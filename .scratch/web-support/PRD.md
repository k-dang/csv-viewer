Status: ready-for-agent

## Problem Statement

CSV Viewer is currently available only as an Electron desktop application. Users who cannot or do not want to install the desktop package cannot open a browser and use the same local-first CSV workflow.

The renderer already uses web technologies, but it depends directly on an Electron-injected interface. CSV acquisition, Recent CSV Sources, export delivery, native DuckDB access, application-menu commands, and filesystem identity all assume a desktop runtime. Running the renderer as an ordinary Vite site would therefore fail and would not provide safe or complete web support.

Users need one CSV Viewer product across desktop and web. The web runtime must preserve Local Processing and the full Working CSV and Aligned Comparison behavior without uploading data, while acknowledging explicit browser capability and capacity limits.

Before adding web, the desktop implementation also needs three confirmed corrections. The product language changes from Save As to Export CSV; an export must be prevented from overwriting its CSV Source; and Unexported Changes must be tracked independently from undo and redo history.

## Solution

Refactor CSV Viewer around one injected CsvViewerRuntime module and one shared, runtime-neutral CsvWorkspace implementation. React depends only on domain operations and explicit capabilities. Electron, web, and tests provide adapters at the runtime seam, while native DuckDB and DuckDB-Wasm provide adapters at a smaller internal database seam.

Implement the refactor in two major stages. First, extract the shared modules around the existing desktop application, make the confirmed desktop corrections, and keep native behavior green through the new shared contracts. Second, add a browser adapter using the official DuckDB-Wasm package, portable single-file selection, browser download delivery for Export CSV, and a static web composition root.

The first web release processes all CSV contents, Working CSV state, edit history, and comparison artifacts in memory on the user's device. It uses a single-threaded asynchronous DuckDB-Wasm Worker, self-hosts all executable engine assets, performs no server-side processing, and stores no workspace data in origin-private browser storage.

Web support is complete only when the same domain behavior available on desktop—Working CSV querying, sorting, filtering, search, statistics, editing, undo/redo, Export CSV, and Aligned Comparison—passes against DuckDB-Wasm. Runtime differences are limited to explicit capabilities such as Recent CSV Source availability, export delivery, and capacity.

## Architectural Rationale

- **Local, network-isolated processing:** CSV Viewer uses an in-browser data engine instead of uploading CSV data for server-side processing. The engine accepts only user-selected local CSV Sources and self-hosted executable assets; remote CSV access, runtime CDNs, and dynamically fetched extensions are rejected because they would weaken the Local Processing boundary. The tradeoff is a lower supported capacity on web and responsibility for packaging the pinned Worker, WebAssembly modules, and approved extension assets.
- **One shared product architecture:** Desktop and web share the renderer, `CsvViewerRuntime` contract, and runtime-neutral `CsvWorkspace` instead of maintaining separate workspaces or an independently evolving web edition. This prevents domain behavior from drifting and keeps Electron and browser mechanics behind narrow host and database adapters. Genuine runtime differences are represented as explicit capabilities rather than platform checks, optional no-ops, or duplicated product rules.
- **DuckDB-Wasm in the browser:** The web runtime uses the official `@duckdb/duckdb-wasm` package rather than a JavaScript CSV parser with separate query, edit, statistics, and comparison algorithms. Reusing DuckDB preserves the existing SQL-oriented workspace and allows native DuckDB and DuckDB-Wasm to satisfy the same behavioral contract. Both engines are pinned to the same DuckDB core version wherever possible; observable differences must be normalized by the adapter or recorded in a reviewed allowed-divergence list rather than creating runtime-specific domain semantics.

## User Stories

1. As a CSV Viewer user, I want to open CSV Viewer in a supported desktop browser, so that I can work without installing the desktop application.
2. As a CSV Viewer user, I want my CSV data to remain on my device, so that using the web runtime preserves the Local Processing promise.
3. As a CSV Viewer user, I want to select one local CSV Source through a normal browser file picker, so that opening a file works across supported browsers.
4. As a CSV Viewer user, I want CSV, TSV, and text CSV Sources to have the same dialect behavior on web and desktop, so that runtime choice does not change parsing.
5. As a CSV Viewer user, I want delimiter and header overrides to work on web, so that irregular CSV Sources remain usable.
6. As a CSV Viewer user, I want opening a CSV Source to create and focus a CSV Tab, so that the web workspace follows the desktop Tab model.
7. As a CSV Viewer user, I want a browser selection to be treated as a new CSV Source when sameness cannot be established, so that CSV Viewer does not make unsafe identity guesses.
8. As a CSV Viewer user, I want CSV Viewer never to infer CSV Source identity from matching names, sizes, timestamps, or contents, so that distinct files are not incorrectly merged.
9. As a CSV Viewer user, I want a known CSV Source to occupy at most one CSV Tab, so that runtimes with trustworthy identity retain deduplication behavior.
10. As a web user, I want the first release to omit unactionable Recent CSV Sources, so that the interface does not promise reopening it cannot perform.
11. As a web user, I want to be told that files must be selected again after reload, so that the workspace lifetime is clear.
12. As a desktop user, I want existing Recent CSV Source behavior to remain available, so that web limitations do not regress desktop capabilities.
13. As a CSV Viewer user, I want bounded row windows instead of loading all rows into React, so that large supported CSV Sources remain responsive.
14. As a CSV Viewer user, I want sorting, filtering, and global search to behave identically on web and desktop, so that query results are predictable.
15. As a CSV Viewer user, I want Column Value Counts and Live Stats to use the same Count Scope on web and desktop, so that statistics do not vary by runtime.
16. As a CSV Viewer user, I want the Stats Panel to behave identically on web and desktop, so that web is not a reduced viewer.
17. As a CSV Viewer user, I want cell editing to work on web, so that I can perform the same cleanup workflow without installing the desktop application.
18. As a CSV Viewer user, I want row insertion and append behavior to follow the same active-query restrictions on web, so that edits remain unambiguous.
19. As a CSV Viewer user, I want row deletion to target stable row identities on web, so that filters and sorting do not change which rows are removed.
20. As a CSV Viewer user, I want undo and redo to work on web, so that editing remains reversible.
21. As a CSV Viewer user, I want Export CSV to preserve my current Working CSV, active delimiter, header choice, edits, inserts, deletes, and source order, so that the output reflects my work.
22. As a CSV Viewer user, I want Export CSV never to overwrite or replace the Working CSV's CSV Source, so that the original remains safe.
23. As a desktop user, I want CSV Viewer to reject choosing the opened CSV Source as an export destination, so that the source-protection promise is enforced rather than suggested by a default filename.
24. As a CSV Viewer user, I want the command to be named Export CSV rather than Save As, so that it accurately describes a separate output.
25. As a CSV Viewer user, I want the Active Tab to remain associated with its original CSV Source after export, so that exporting does not silently rebind the workspace.
26. As a CSV Viewer user, I want a successful export to clear Unexported Changes, so that CSV Viewer does not warn after my current data has been delivered.
27. As a CSV Viewer user, I want successful export to preserve undo and redo history, so that writing an output does not destroy editing capability.
28. As a CSV Viewer user, I want undoing away from the last exported state to create Unexported Changes, so that close warnings reflect the current Working CSV.
29. As a CSV Viewer user, I want redoing back to the last exported state to clear Unexported Changes, so that the warning state follows data rather than stack length.
30. As a web user, I want a generated export to download through my browser, so that Export CSV works without a browser-specific filesystem interface.
31. As a web user, I want browser handoff of an export to count as success, so that CSV Viewer can use an observable and deterministic completion point.
32. As a web user, I want the confirmation to say "Download started" rather than "Saved," so that it does not overstate what the browser can verify.
33. As a CSV Viewer user, I want two open Working CSVs to be eligible for Aligned Comparison on web, so that comparison is not a desktop-only feature.
34. As a CSV Viewer user, I want Comparison-Compatible CSVs, Comparison Keys, key validation, row classification, summaries, and comparison windows to behave identically on web and desktop.
35. As a CSV Viewer user, I want edits to make an existing Aligned Comparison Outdated on web, so that comparison freshness remains accurate.
36. As a CSV Viewer user, I want comparison refresh, swap, cancellation, and close behavior to remain consistent across runtimes.
37. As a web user, I want CSV Viewer to reject a CSV Source that exceeds the supported per-source limit before ingestion, so that my browser tab does not fail unpredictably.
38. As a web user, I want CSV Viewer to reject a new open, export, or comparison operation that would exceed the workspace budget, so that existing Tabs and work remain intact.
39. As a web user, I want a capacity rejection to explain the applicable limit, so that I understand why the operation cannot run.
40. As a web user, I want a capacity rejection to direct me to the desktop application, so that I have a path for larger work.
41. As a web user, I want one predictable capacity envelope across supported browsers, so that the limit does not change unexpectedly by browser or device.
42. As a web user, I want CSV Viewer to check required Worker and Wasm capabilities before file selection, so that unsupported browsers fail clearly before I grant file access.
43. As a web user, I want an unsupported-browser state to list supported browsers and the desktop fallback, so that I know how to continue.
44. As a web user, I want refresh or page close to end the workspace, so that the first release does not pretend to restore memory-only state.
45. As a web user, I want a navigation warning when any Working CSV has Unexported Changes, so that an accidental refresh does not silently discard work.
46. As a web user, I want no navigation warning when all Working CSVs match their initial or latest exported state, so that exported work does not create needless prompts.
47. As a web user, I want a fatal DuckDB-Wasm failure to produce one clear workspace error and reload action, so that the application does not continue with corrupted partial state.
48. As a privacy-conscious user, I want no CSV contents or derived data written to browser-managed persistent storage, so that workspace data does not survive the memory-only session.
49. As a privacy-conscious user, I want the data engine unable to read remote URLs or fetch arbitrary extensions, so that Local Processing is enforced.
50. As a privacy-conscious user, I want no automatic analytics, performance telemetry, or crash reporting, so that operational data does not leave my device.
51. As a web user, I want the web application to be delivered over HTTPS with self-hosted engine assets, so that browser security features and deterministic versions are available.
52. As a web user, I want current stable Chrome, Edge, Firefox, and Safari desktop releases to be supported, so that web use is not restricted to Chromium.
53. As a web user, I want the application to omit mobile-specific promises, so that unsupported phone and tablet workflows are not represented as production-ready.
54. As a web user, I want the application to remain a normal hosted site, so that PWA installation and offline lifecycle do not complicate the initial release.
55. As a maintainer, I want React to depend on one injected CsvViewerRuntime module, so that feature code does not know about Electron or browser mechanics.
56. As a maintainer, I want runtime differences represented as explicit domain capabilities, so that unsupported behavior cannot hide behind optional methods, no-ops, or fake empty results.
57. As a maintainer, I want application-menu actions translated into shared domain intents, so that Electron commands do not leak into React.
58. As a maintainer, I want one shared CsvWorkspace implementation, so that Working CSV and Aligned Comparison rules do not drift across runtimes.
59. As a maintainer, I want native DuckDB and DuckDB-Wasm behind a small internal database interface, so that runtime mechanics vary without duplicating domain behavior.
60. As a maintainer, I want SQL construction, storage schema, edit history, comparison orchestration, and result normalization owned by the shared workspace, so that database adapters remain narrow.
61. As a maintainer, I want desktop refactoring and corrections completed before the web adapter is added, so that two runtimes are not moving during the same architectural extraction.
62. As a maintainer, I want native DuckDB and DuckDB-Wasm pinned deliberately, so that engine changes are reviewed rather than inherited accidentally.
63. As a maintainer, I want the same behavioral contract to run against both engines, so that any observable SQL or workspace difference not recorded in the reviewed allowed-divergence list blocks release.
64. As a maintainer, I want browser-specific file input and download behavior covered through adapter tests, so that portable workflows remain reliable.
65. As a maintainer, I want the web build to produce a static artifact containing every required Worker and Wasm asset, so that deployment requires no application server.
66. As a deployer, I want deterministic cache rules and correct Worker/Wasm MIME types, so that a release cannot combine incompatible JavaScript and engine assets.
67. As a deployer, I want a restrictive Content Security Policy, so that the network-isolated data-engine posture is enforced by the host.
68. As a product owner, I want web support withheld until all existing domain features pass, so that CSV Viewer Web does not become a permanently reduced edition.

## Implementation Decisions

- Preserve one product across desktop and web. Domain behavior does not branch by runtime; only explicit capabilities and the benchmark-derived capacity envelope may differ.
- Implement a desktop-first refactor before adding web. Keep the desktop application green while introducing the shared seams and correcting existing export behavior.
- Rename the product operation from Save As to Export CSV across shared types, renderer labels, desktop menus, prompts, documentation, and tests.
- Prevent Export CSV from targeting the opened CSV Source. Desktop must compare the chosen destination against canonical source identity and reject or re-prompt before writing.
- Keep an exported destination separate from the Active Tab's CSV Source. Export does not rename the Tab, rebind the Working CSV, or automatically create a Recent CSV Source.
- Separate Unexported Changes from undo and redo availability. Track the last preserved state independently from edit-history stacks so export can clear Unexported Changes without deleting history, and undo/redo can move away from or back to the exported state.
- Introduce one CsvViewerRuntime module at the renderer seam. It owns the domain-facing interface, runtime capabilities, domain outcomes, and subscriptions used by React.
- Inject CsvViewerRuntime at the renderer composition root. React must not access the Electron preload global, IPC channel names, browser File objects, file handles, download elements, Workers, or runtime-name checks.
- Represent genuine runtime differences with explicit capabilities. Do not use optional operations, silent no-ops, fake empty collections, or booleans named after platforms.
- Translate Electron application-menu requests into shared domain intents before they reach React.
- Introduce one shared, runtime-neutral CsvWorkspace implementation for Working CSV lifecycle, row windows, filtering, sorting, search, Column Value Counts, editing, history, Unexported Changes, export state, capacity outcomes, and Aligned Comparison.
- Instantiate the shared CsvWorkspace in the Electron main process on desktop and in the browser page on web. Desktop's CsvViewerRuntime is an IPC proxy over the main-process workspace; web's is direct in-page wiring over the same implementation. The CsvViewerRuntime and CsvWorkspace surfaces are therefore IPC-serializable by construction: every operation is asynchronous, every request, result, and subscription event is structured-clone-safe, and the contract contains no live objects, callbacks inside results, or synchronous accessors.
- Move Node-independent query construction, storage schema, comparison orchestration, and result normalization into the shared workspace area. Shared modules must not import Electron or Node filesystem primitives.
- Define a small internal DuckDB database interface around the execution behavior CSV Viewer needs. Native DuckDB and DuckDB-Wasm adapters normalize parameters, row results, connection lifecycle, cancellation, and errors behind this interface.
- Keep file acquisition, export delivery, and Recent CSV Source storage behind internal host interfaces. These interfaces use CSV Viewer language and opaque source identity, not paths or browser handles.
- Replace path as universal CSV Source identity. Desktop may use canonical paths internally; future enhanced browsers may use trustworthy persistent-handle equality. Portable browser selections receive runtime-scoped opaque identity and may represent the same physical file more than once.
- Preserve desktop Recent CSV Sources. The first web release exposes the explicit capability that Recent CSV Sources are unavailable and omits that interface from the rendered web experience.
- Use the official DuckDB-Wasm package for the web database adapter. Pin native DuckDB and DuckDB-Wasm to exact package versions built on the same DuckDB core version; the DuckDB-Wasm package version does not track core versions, so parity is defined by the bundled core. When the available DuckDB-Wasm core lags the native binding, pin the native binding back to the newest core available to both.
- If same-core pinning is unattainable for a release, record every observable behavioral difference in a reviewed allowed-divergence list. A divergence absent from that list blocks release; the list is a release artifact, not a standing exemption.
- Use DuckDB-Wasm's single-threaded asynchronous Worker build. Do not require cross-origin isolation or adopt experimental multithreading in the first release.
- Keep the web database in memory. Do not use origin-private filesystem storage, IndexedDB workspace persistence, or spill storage for CSV contents, edits, or derived tables.
- Treat Worker failure or unusable engine state as fatal to the entire web workspace. Show a reload action and do not attempt partial reconstruction.
- Run a startup capability check before enabling file selection. Check the actual features needed by the pinned Worker/Wasm build rather than relying only on browser identity.
- Use portable input-based file selection in web. Open exactly one CSV Source per picker action. Reuse the existing CSV, TSV, and text acceptance rules.
- Use browser download delivery for Export CSV. Successful output generation and handoff to the browser count as success and clear Unexported Changes; communicate this as "Download started."
- Account for export memory in the web workspace capacity budget. Do not begin export if the tested budget cannot accommodate output generation and handoff safely.
- Enforce one conservative web capacity envelope across all supported browsers. It contains one per-source byte limit and one whole-workspace budget covering open Working CSVs, export work, and Aligned Comparison artifacts.
- Derive numeric capacity limits through repeatable benchmarks on representative low-end supported desktop hardware and the weakest supported browser. Do not guess limits in implementation.
- Reject an operation before allocating its expensive work when it would exceed the capacity envelope. Preserve all existing Tabs and return a domain capacity outcome that includes the applicable limit and desktop fallback.
- Preserve the existing workspace lifetime model. Desktop application exit and web page refresh/close end the workspace; open Tabs, edit history, and comparisons are not restored.
- Install a web navigation guard only while at least one Working CSV has Unexported Changes. Browser-provided confirmation copy is acceptable where custom text is unavailable.
- Self-host the pinned DuckDB-Wasm Worker, Wasm modules, and any approved engine assets. Disable remote CSV URLs, runtime CDNs, dynamic extension installation, and extension autoload fetching.
- Produce a static web artifact with no application backend, account system, authentication, uploads, or server-side session state.
- Configure the static host for HTTPS, correct Worker/Wasm content types, a restrictive Content Security Policy, and cache rules that prevent incompatible application and engine assets from being mixed.
- Keep desktop packaging and the static web artifact as separate composition/build outputs over the shared renderer and workspace modules.
- Support only current stable desktop Chrome, Edge, Firefox, and Safari for the first release. Gate actual required capabilities at runtime.
- Send no automatic analytics, performance telemetry, or crash reports. Add no user-facing support-report feature in this scope.
- Release web only after Working CSV querying, statistics, editing, Export CSV, and Aligned Comparison pass the shared behavioral contract.

## Testing Decisions

- Good tests assert observable behavior through the highest practical interface: domain results, capability-dependent renderer states, exported bytes, and user-visible outcomes. Tests must not depend on private SQL helper structure, IPC channel names, DuckDB driver internals, React implementation details, or browser element plumbing.
- The primary product seam is CsvViewerRuntime. Use it to test the renderer's shared behavior and capability-dependent presentation without Electron or browser globals.
- The primary domain seam is CsvWorkspace. Run one extensive behavioral contract against a native-DuckDB-backed workspace and a DuckDB-Wasm-backed workspace.
- The shared workspace contract covers CSV Source opening, dialect overrides, metadata, row windows, sorting, filters, search, Column Value Counts, edit operations, stable row identity, insert restrictions, deletion, undo, redo, Unexported Changes, export state, close impact, and resource release.
- The shared comparison contract covers candidate discovery, Comparison-Compatible CSVs, Comparison Key validation, invalid-key diagnostics, comparison execution, cancellation, summaries, row classifications, result windows, swapping, Outdated Comparison behavior, refresh, source closing, and artifact cleanup.
- Export contract tests compare output bytes for headers, delimiters, quoting, null/empty values, edits, inserted rows, deleted rows, row order, and exclusion of internal columns.
- Export-state tests prove that successful export clears Unexported Changes without removing undo/redo, undoing away from the export creates Unexported Changes, and returning to the exported revision clears them.
- Desktop adapter tests prove canonical CSV Source identity, Recent CSV Source behavior, destination selection, source-overwrite prevention, IPC translation, and application-menu intent translation.
- Web adapter tests prove one-file input, runtime-scoped source identity, absence of Recent CSV Sources, download handoff, "Download started" presentation, navigation warning, startup capability rejection, capacity rejection, resource cleanup, and fatal Worker behavior.
- Run shared browser behavior automatically against Chromium, Firefox, and WebKit. Smoke-test current stable Chrome, Edge, Firefox, and Safari before release.
- Add a deterministic build test that verifies all pinned Worker, Wasm, and approved extension assets are included locally and no runtime engine asset points to a CDN.
- Add security-oriented tests or build assertions for remote-source rejection, disabled dynamic extension fetching, and the required Content Security Policy contract.
- Add capacity benchmark fixtures covering large, wide, long-cell, edited, multi-Tab, export, and Aligned Comparison workloads. Record peak memory, completion time, and failure behavior on representative low-end supported hardware.
- Set the public per-source limit and workspace budget only after benchmark evidence is reviewed. Add regression fixtures immediately below the limits and rejection tests immediately above them.
- Use existing CSV data behavior tests as prior art for parsing, queries, editing, export serialization, large-file row windows, and error normalization.
- Use existing workspace tests as prior art for Unexported Changes, close impact, and dependent Comparison Tab behavior.
- Use existing comparison tests as prior art for orchestration, cancellation, key diagnostics, summaries, windows, freshness, and cleanup.
- Use existing renderer state and data-source tests as prior art for request mapping, stale-response protection, Tab state, loading, ready, empty, and error presentation.
- Keep a desktop regression gate throughout phase one. No web work begins by bypassing or weakening existing native behavior tests.

## Out of Scope

- Uploading CSV Sources or derived data to a server.
- Any application backend, account system, authentication, authorization, or server-side session state.
- Remote CSV URLs, cloud-storage connectors, or network-backed DuckDB sources.
- A reduced viewer-only or read-only web edition.
- Phone or tablet support.
- Legacy browser versions or a support promise for browser forks.
- PWA installation, a service worker, offline startup, or an offline-use promise.
- Persisting or restoring open Tabs, Working CSVs, edits, history, or Aligned Comparisons across runtime sessions.
- Origin-private filesystem or IndexedDB storage for workspace data.
- DuckDB-Wasm spill storage or out-of-core browser processing.
- DuckDB-Wasm experimental multithreading or a cross-origin-isolation requirement.
- Persistent browser file handles and web Recent CSV Sources.
- Native browser save-picker enhancement or direct writes to an opened CSV Source.
- Opening multiple CSV Sources in one picker action.
- Drag-and-drop file opening.
- Inferring source identity from filename, size, timestamp, or content hashing.
- Adaptive capacity limits by browser, device, available memory, or runtime heuristics.
- Best-effort attempts above the supported capacity envelope.
- Automatic recovery after a fatal DuckDB-Wasm Worker failure.
- Automatic analytics, performance telemetry, or crash reporting.
- A user-facing diagnostic or support-report feature.
- Choosing a production hosting provider, public domain, or release URL.
- Choosing numeric capacity limits before benchmarks are complete.
- Redesigning existing CSV querying, editing, statistics, or Aligned Comparison semantics.
- Adding new CSV formats, structural column editing, typed cell validation, or new comparison modes.

## Further Notes

The [root glossary](../../CONTEXT.md) is a normative input to this specification. In particular, use CSV Source, Recent CSV Source, Export CSV, Unexported Changes, Working CSV, and Aligned Comparison consistently; platform-shaped synonyms should not re-enter shared interfaces.

The current desktop implementation does not yet match all confirmed semantics. It still exposes an Electron-shaped global interface, uses path as universal identity, names the operation Save As, allows a user-selected destination to equal the source path, derives dirty state from undo-stack length, and clears undo/redo on export. Correcting those gaps is intentional phase-one feature work, not incidental cleanup.

The exact internal TypeScript interface shapes remain implementation work, but their ownership and placement are settled: CsvViewerRuntime is the renderer seam, CsvWorkspace is the shared domain module running in the Electron main process on desktop and in the page on web, and native/Wasm database execution plus host file behavior are internal adapters. Because desktop reaches the workspace over IPC, every shared surface must remain asynchronous and structured-clone-safe.

The exact capacity numbers remain deliberately unresolved. Benchmarks are part of implementation and release readiness; the outcome must be one conservative envelope shared by all supported browsers.

The web feature is not complete when a page renders or a CSV opens. It is complete only when the shared domain contract, web adapter behavior, browser matrix, capacity enforcement, static deployment requirements, and full Aligned Comparison workflow all pass.
