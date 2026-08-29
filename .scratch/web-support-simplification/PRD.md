Status: ready-for-agent

## Problem Statement

CSV Viewer has completed the first five stages of its web-support work, but the architecture now expresses the same product operation several times. A renderer operation appears in a shared operations type, a runtime type, an Electron channel list, a preload forwarding method, a main-process handler, and a workspace method. Reopen CSV has different result types on opposite sides of that chain. Desktop-only health checking also sits in the shared renderer even though the browser has no Electron main process or IPC connection.

The duplication makes the product look more complicated than the behavior requires. Adding or changing one operation can require edits across several modules that contain no product logic. Tests also use two fixture lifecycle patterns and expose an internal Comparison Executor through CsvWorkspace construction.

CSV Viewer still needs real complexity for Local Processing, Working CSV edit history, Unexported Changes, bounded queries, Aligned Comparison publication, cancellation, source leases, mutation ordering, artifact cleanup, desktop source identity, and the future DuckDB-Wasm engine. That complexity should remain behind one small interface. Transport wiring and test setup should not multiply it.

## Solution

Replace the separate renderer runtime and workspace operation interfaces with one deep CsvViewer module. Its interface has one typed request entry point, one event subscription, and the capabilities that React currently reads. Each product operation is declared once as a discriminated request with its corresponding result type.

Desktop carries requests through one Electron IPC request channel and events through one Electron IPC event channel. The browser calls the same CsvViewer module directly in the page. React receives CsvViewer through its existing composition-root injection and does not know whether calls cross IPC.

Keep host behavior and database execution as internal seams because each has two concrete adapters: desktop and browser hosts, then native DuckDB and DuckDB-Wasm databases. Keep the Working CSV store, comparison orchestration, edit history, mutation queues, source leases, and artifact registry as internal implementation. They contain current product rules and cleanup invariants.

Delete desktop-only health checking from the shared renderer. Give Reopen CSV one operation and one result shape. CsvViewer owns the Unexported Changes check and asks its host adapter to confirm discarding changes, so main-process transport does not wrap or translate the operation.

## User Stories

1. As a CSV Viewer user, I want desktop behavior to remain unchanged after the simplification, so that the refactor does not interrupt my current workflow.
2. As a CSV Viewer user, I want the browser and desktop applications to use the same product behavior, so that runtime choice does not change how my CSVs work.
3. As a CSV Viewer user, I want CSV contents and derived data to remain on my device, so that the simplification preserves Local Processing.
4. As a CSV Viewer user, I want to choose a CSV Source and open a Working CSV, so that the simplified interface still supports the primary workflow.
5. As a CSV Viewer user, I want CSV, TSV, and text CSV Sources to retain their delimiter and header behavior, so that parsing does not regress.
6. As a CSV Viewer user, I want a known CSV Source to occupy at most one CSV Tab when its identity is trustworthy, so that duplicate Tabs are not introduced.
7. As a browser user, I want separate selections to remain separate when identity cannot be established, so that CSV Viewer does not guess from names, sizes, timestamps, or contents.
8. As a desktop user, I want Recent CSV Sources to remain available, so that the browser limitation does not remove a desktop capability.
9. As a browser user, I want Recent CSV Sources omitted when the runtime cannot reopen them, so that the interface does not promise unavailable behavior.
10. As a CSV Viewer user, I want bounded row windows, sorting, filtering, and search to behave as they do today, so that large supported Working CSVs remain usable.
11. As a CSV Viewer user, I want Column Value Counts and Live Stats to use the current Count Scope, so that statistics remain correct.
12. As a CSV Viewer user, I want cell editing, row insertion, and row deletion to retain stable row targeting, so that active queries cannot redirect a mutation.
13. As a CSV Viewer user, I want undo and redo to retain their current behavior, so that edits remain reversible.
14. As a CSV Viewer user, I want Unexported Changes to remain based on revision identity, so that export and history state stay independent.
15. As a CSV Viewer user, I want Export CSV to preserve the Working CSV, dialect, edits, row order, and internal-column exclusions, so that exported bytes remain correct.
16. As a CSV Viewer user, I want Export CSV never to overwrite or replace the Working CSV's CSV Source, so that the original remains protected.
17. As a CSV Viewer user, I want a successful Export CSV to clear Unexported Changes without clearing undo or redo, so that export does not erase edit history.
18. As a CSV Viewer user, I want Reopen CSV to ask before discarding Unexported Changes, so that a runtime adapter cannot bypass the warning.
19. As a CSV Viewer user, I want cancelling Reopen CSV to leave the Working CSV untouched, so that declining the warning is safe.
20. As a CSV Viewer user, I want an unavailable CSV Source during reopen to produce one useful failure, so that I can understand what happened.
21. As a CSV Viewer user, I want Comparison-Compatible CSVs and Comparison Key validation to retain their current rules, so that Aligned Comparison remains predictable.
22. As a CSV Viewer user, I want Aligned Comparison execution, cancellation, refresh, swap, and Outdated Comparison behavior to remain unchanged, so that simplification does not weaken comparison correctness.
23. As a CSV Viewer user, I want a cancelled Aligned Comparison to publish no result and release its artifacts, so that cancellation cannot expose partial data.
24. As a CSV Viewer user, I want closing a Working CSV or Comparison Tab to retain current confirmation and cleanup behavior, so that dependent work is not leaked or silently discarded.
25. As a CSV Viewer user, I want application-menu commands to keep reaching the shared renderer, so that desktop shortcuts continue to work.
26. As a browser user, I want the shared interface to contain no IPC or main-process concepts, so that the browser does not display desktop-only status.
27. As a CSV Viewer maintainer, I want every product operation declared once, so that changing an operation does not require synchronized edits through several forwarding layers.
28. As a CSV Viewer maintainer, I want Electron transport to carry typed product requests without restating their shapes, so that transport remains mechanical.
29. As a CSV Viewer maintainer, I want the browser to call the same CsvViewer interface directly, so that browser support does not require a second product interface.
30. As a CSV Viewer maintainer, I want one event stream for workspace changes and runtime intents, so that subscribers have one ordering and cleanup model.
31. As a CSV Viewer maintainer, I want host mechanics hidden behind desktop and browser adapters, so that paths, browser File objects, file handles, and download elements do not reach React.
32. As a CSV Viewer maintainer, I want native DuckDB and DuckDB-Wasm hidden behind one internal database interface derived from both implementations, so that driver differences stay local.
33. As a CSV Viewer maintainer, I want Working CSV and Aligned Comparison rules tested through CsvViewer, so that tests exercise the same interface as React.
34. As a CSV Viewer maintainer, I want adapter-specific behavior tested at its adapter seam, so that the shared contract does not encode desktop or browser mechanics.
35. As a CSV Viewer maintainer, I want test fixture creation and cleanup to use one standard pattern, so that setup failures cannot leak resources.
36. As a CSV Viewer maintainer, I want Comparison Executor injection kept inside workspace-owned testing code, so that callers do not learn internal comparison orchestration.
37. As a CSV Viewer maintainer, I want CSV Source terminology in shared types and state, so that the code matches the project's domain language.
38. As a CSV Viewer maintainer, I want expected operation outcomes to retain their specific domain types, so that one generic error abstraction does not erase useful information.
39. As a CSV Viewer maintainer, I want no client-side mirror of workspace state, so that the refactor does not introduce sequencing, reconciliation, or cache invalidation rules.
40. As a CSV Viewer maintainer, I want the current test, typecheck, and lint suites green throughout migration, so that simplification does not hide regressions.

## Implementation Decisions

- CsvViewer becomes the sole external product seam used by React and by the behavioral contract suite.
- The interface shape below came from the design comparison performed before this spec. It records the decision, not a complete implementation:

  ```ts
  interface CsvViewer {
    readonly capabilities: CsvViewerCapabilities;

    call<R extends CsvViewerRequest>(
      request: R,
    ): Promise<CsvViewerResult<R>>;

    onEvent(listener: (event: CsvViewerEvent) => void): () => void;
  }
  ```

- CsvViewerRequest is a discriminated union. Each request has one namespaced operation name and the fields required by that operation. CSV Viewer declares every operation exactly once in this union and maps it to its operation-specific result type.
- The request protocol covers CSV Source selection and reopening, Working CSV reads and mutations, Column Value Counts, Export CSV, close behavior, Aligned Comparison lifecycle, bounded comparison reads, and deterministic disposal.
- The protocol does not split reads and commands into separate entry points. That distinction would add an interface rule without changing transport or caller behavior.
- The protocol does not introduce a generic Outcome type. Existing operation-specific success, cancellation, validation, conflict, and cleanup results remain distinct. Unexpected implementation faults reject the promise.
- Requests, results, capabilities, and events remain asynchronous where applicable and structured-clone-safe. No callback appears inside a request or result.
- Desktop uses one IPC request channel. The main process forwards each validated CsvViewerRequest to CsvViewer and returns its result without translating domain outcomes.
- Desktop uses one IPC event channel. CsvViewerEvent includes workspace events and application-menu intents. The preload adapter validates event kinds before invoking renderer callbacks.
- Web constructs CsvViewer in the page and calls it directly. React uses the same injected interface on both runtimes.
- React keeps the current composition-root provider. The refactor does not return to an ambient browser global.
- CsvViewerCapabilities contains only differences with a current reader. Recent CSV Source availability remains. Export delivery, cancellation immediacy, capacity, and future runtime distinctions are added only when current behavior needs them.
- The desktop-only health check and its badge are removed. Browser startup support and fatal engine health are product outcomes handled by the web composition root, not a shared IPC status operation.
- Reopen CSV has one request and one result shape. CsvViewer checks Unexported Changes, asks the internal host adapter for confirmation, revalidates the Working CSV before replacement, and returns cancelled, reopened, or failed. It does not expose a special renderer/workspace desynchronization result.
- An unknown Working CSV during reopen is an ordinary failed operation. React does not maintain recovery logic for a state with no current reproduction path.
- The internal host seam owns CSV Source selection, opaque identity, description, temporary engine exposure, Recent CSV Source behavior, discard confirmation, and Export CSV delivery. Desktop and browser provide concrete adapters.
- The internal database seam is extracted from the working native DuckDB and DuckDB-Wasm implementations. It covers only parameter binding, row results, connection lifecycle, cancellation, and normalized errors that both implementations require.
- Comparison Executor remains internal to CsvViewer. Production and ordinary test callers cannot inject it through CsvViewer construction.
- Working CSV storage, edit history, query construction, export serialization, comparison orchestration, mutation queues, source leases, revision checks, artifact ownership, and deterministic cleanup remain internal modules.
- Internal modules are not merged merely to reduce file count. Merge or inline a module only when deleting it removes an interface and does not spread its invariants across callers.
- Shared types use CSV Source language. CsvFileMetadata becomes CsvSourceMetadata, and Working CSV state refers to source rather than file.
- Desktop filesystem identity and browser selection objects never cross the CsvViewer seam.
- The implementation does not add a client snapshot cache, global event sequence, confirmation-token system, generic plugin mechanism, generated RPC layer, or runtime-named branching in React.
- The migration removes the separate workspace-operations and renderer-runtime types, per-operation IPC channel names, per-operation preload methods, per-operation main handlers, the second Reopen CSV result type, desktop health types and UI, and test-only Comparison Executor construction from the external seam.
- Test infrastructure keeps one factory registry for engine variants. It uses the test runner's built-in parameterization and one fixture lifecycle pattern instead of a custom per-test wrapper beside suite-level setup.
- Full-workspace contract cases live in workspace contract suites. Internal comparison tests contain only invariants that cannot be observed through CsvViewer.
- The mocked Export CSV destination-loop test is removed because the desktop host test covers the same behavior with real canonical identity and delivery.
- No schema or persistent-data migration is required.

## Testing Decisions

- The highest test seam is CsvViewer. The behavioral contract calls `call`, observes operation-specific results, and subscribes through `onEvent`, exactly as React does.
- The full contract runs against a native DuckDB CsvViewer factory and, once implemented, a DuckDB-Wasm CsvViewer factory. Adding the second engine changes the factory registry, not contract cases or expected results.
- The shared contract covers CSV Source opening, dialect overrides, metadata, bounded rows, sorting, filtering, search, Column Value Counts, editing, stable row identity, insert restrictions, deletion, undo, redo, Unexported Changes, Export CSV state, close impact, resource release, Aligned Comparison, cancellation, Outdated Comparison behavior, and artifact cleanup.
- Contract tests assert observable values, events, delivered bytes, and cleanup outcomes. They do not assert SQL text, private maps, queue structure, driver objects, IPC channel names, or the internal dispatcher layout.
- Desktop host adapter tests cover canonical CSV Source identity, hard-link identity, Recent CSV Sources, Export CSV destination selection, source-overwrite prevention, moved sources, and actual delivery.
- Browser host adapter tests cover one-file selection, runtime-scoped identity, unavailable Recent CSV Sources, download delivery, reload lifetime, and fatal Worker presentation when those adapters are implemented.
- Database adapter tests cover parameter binding, normalized rows and errors, owner and worker connection ownership, cancellation, cleanup, and the prohibition on remote engine assets. They do not repeat Working CSV or Aligned Comparison domain cases.
- IPC adapter tests prove that one valid request reaches CsvViewer unchanged, one result returns unchanged, unsupported request kinds are rejected, and events unsubscribe cleanly. They do not repeat every request in the product union.
- Application-menu adapter tests prove that desktop commands become CsvViewer intent events. React behavior tests prove that those intents invoke the expected CsvViewer request.
- Internal module tests remain only where an invariant cannot be observed reliably through CsvViewer, such as a controlled publication race or low-level driver cancellation. Internal tests may use workspace-owned construction helpers without widening the production interface.
- Fixture creation owns partial-setup cleanup. Every successfully created fixture is disposed in `finally`, and a setup failure releases resources created before the failure.
- Existing parameterized workspace tests are migrated rather than copied. Duplicate mock-heavy regression tests are deleted when a higher test proves the same behavior.
- The baseline is the currently green suite of 23 test files and 147 tests, plus passing typecheck and lint. Each migration step must keep tests, typecheck, and lint green.

## Out of Scope

- Adding DuckDB-Wasm itself, the browser composition root, browser Export CSV, capacity limits, deployment hardening, or the browser support matrix. Those follow this simplification.
- Changing user-visible Working CSV, Stats Panel, Export CSV, Tab, or Aligned Comparison behavior except removing the desktop-only IPC health badge.
- Replacing the current React provider with a global runtime object.
- Moving desktop workspace execution into the renderer, a utility process, or a new Worker.
- Adding a client-side workspace snapshot, cache, event replay log, reconnect protocol, or state reconciliation mechanism.
- Adding a general RPC framework, code generator, plugin system, command registry, or configurable middleware pipeline.
- Adding speculative capabilities for work that has no current consumer.
- Rewriting query construction, edit history, comparison algorithms, or artifact management solely to reduce line counts.
- Persistent browser CSV Sources, browser Recent CSV Sources, direct writes to an opened CSV Source, or browser-managed workspace persistence.
- Server-side processing or uploading CSV contents or derived data.

## Further Notes

- This spec preserves the product requirements of the original web-support plan but supersedes its architectural decision to expose separate CsvWorkspaceOperations and CsvViewerRuntime method sets.
- The point is deletion. A successful implementation removes repeated transport declarations and special cases while retaining the concurrency and cleanup rules that current behavior needs.
- The request union is broad because CSV Viewer has broad behavior. Breadth declared once is simpler than the same breadth mirrored through several layers.
- The current branch passes all tests, typecheck, and lint before this migration begins.
