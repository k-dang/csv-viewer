Parent: [Find the Way to an Implementation-Ready Aligned CSV Comparison Specification](../map.md)
Type: grilling
Status: resolved
Blocked by: 01, 02

# Design the Comparison Data Module Interface

## Question

What minimal deep-module interface should own comparison sessions and hide key validation, result computation, summary and window retrieval, outdated transitions, refresh and cancellation, side swapping, source dependencies, and cleanup from Electron IPC and renderer callers?

Place the seam deliberately relative to the existing CsvDataService, define its invariants and error modes, and ensure callers and tests can use the same interface without exposing DuckDB query mechanics.

## Comments

### Confirmed decision 1: workspace-owned comparison facet

Deepen the existing `CsvDataService` seam into a main-process `CsvWorkspace` module. `CsvWorkspace` is the sole owner of the DuckDB instance, Working CSV identities and tables, data revisions, source-to-comparison dependencies, close ordering, and shutdown. It exposes focused Working CSV and comparison facets rather than one flat method collection:

```ts
workspace.csvs
workspace.comparisons
```

The comparison facet owns Comparison sessions, key application and refresh operations, cancellation, immutable result snapshots, summaries, bounded result windows, side orientation, and cleanup. It is not a sibling module that consumes a public `CsvDataService` interface: no DuckDB handle, table name, source revision, or `source-changed` choreography crosses the workspace seam.

Reopen/replace preserves the logical Working CSV identity, atomically replaces its physical DuckDB table, and increments its data revision. Dependent Comparisons therefore remain connected and become Outdated instead of being orphaned by a new session ID.

This is one external workspace seam with internally focused facets. The Electron main adapter requests domain intentions; it does not coordinate source revisions, Outdated transitions, dependent close, or artifact cleanup.

### Confirmed decision 2: correctness state in main, presentation state in renderer

`CsvWorkspace` owns every fact needed to decide data correctness or resource lifecycle:

- live Working CSV and Comparison session identities;
- Baseline/Candidate orientation and source dependencies;
- the applied Comparison Key;
- the active result snapshot, summary, captured source revisions, and Outdated state;
- the active generation operation and its cancellation identity; and
- snapshot/source cleanup state.

The renderer owns unapplied and presentation-only state:

- draft Comparison Key selection;
- Differences/All rows and Changed-first/CSV-order toggles;
- Candidate picker state; and
- Active Tab, focused cell, selection, column widths, and scroll position.

Changing renderer-owned state cannot mutate or regenerate the active snapshot. Apply key submits a complete draft key as one intention. Only a successful generation atomically changes the workspace-owned applied key and result. Main-process state is authoritative when a late renderer response, remount, or event conflicts with it.

### Confirmed decision 3: token-scoped operation handles

Apply key and Refresh start through one `begin` intention and return an operation handle immediately:

```ts
type BeginComparisonResult =
  | {
      status: 'accepted';
      operationId: string;
      completion: Promise<ComparisonAttemptOutcome>;
    }
  | { status: 'busy'; activeOperationId: string }
  | { status: 'rejected'; fault: ComparisonFault };
```

The handle's `completion` promise is a main-process interface value used by the Electron adapter and direct module tests; it never crosses IPC. The IPC start response contains the serializable operation ID, and ordered workspace events carry progress and terminal state to the renderer.

Cancel requires both `comparisonId` and `operationId`. It is idempotent and can return requested, already requested, already finished, operation mismatch, or comparison not found. A late Cancel therefore cannot interrupt a later generation. Only one generation may be active per Comparison; a second begin returns `busy` and never silently supersedes work.

The terminal outcome is one of applied, invalid key with diagnostics, cancelled, sources changed, or normalized failure. These are expected outcomes rather than exceptions. State is committed and its event is emitted before `completion` settles. If a source changes during generation, the workspace records `sources-changed` as the winning terminal cause and interrupts that operation's dedicated worker connection.

This is a new repository-level lifecycle pattern. Current renderer-to-main operations are single `ipcRenderer.invoke` promises, while row-window supersession only ignores late responses through a renderer-local `latestRequestId`; it does not cancel DuckDB work. Existing main-to-renderer events are menu requests rather than authoritative data-state updates. The comparison operation handle adds main-owned cancellation and state progress without changing existing short CSV operations to the new pattern.

### Confirmed decision 4: versioned Comparison events, reconciled by React

Do not introduce a workspace-wide snapshot/delta framework. React continues to own renderer state storage and rerendering. The main process publishes only comparison-specific authoritative projections:

```ts
type ComparisonEvent =
  | { kind: 'changed'; comparison: ComparisonView }
  | { kind: 'closed'; comparisonId: string };
```

Every `ComparisonView` has a monotonically increasing entity `version`. The renderer retains the projection with the greatest version for each Comparison ID and ignores late older events. Each applied result additionally has an opaque `resultToken`; row-window requests and responses carry that token so a late window from a replaced snapshot or swapped orientation cannot be rendered as current.

Events are emitted after main-process state commits. They carry complete serializable Comparison state rather than commands that require the renderer to derive Outdated or terminal operation state. React performs the map update and rerender. A generic workspace reconciliation stream and renderer-reload restoration are outside the feature requirement and are not introduced.

### Confirmed decision 5: explicit ID-based comparison interface

Expose discoverable methods with serializable request and result types rather than a generic command/query union or stateful Comparison object handles:

```ts
interface Comparisons {
  candidatesFor(baselineId: string): ComparisonCandidate[];
  open(request: OpenComparisonRequest): ComparisonOpenResult;
  getState(comparisonId: string): ComparisonView | null;
  begin(request: BeginComparisonRequest): BeginComparisonResult;
  cancel(request: CancelComparisonRequest): Promise<CancelComparisonResult>;
  getWindow(request: ComparisonWindowRequest): Promise<ComparisonWindowOutcome>;
  swap(comparisonId: string): ComparisonView;
  close(comparisonId: string): Promise<void>;
  subscribe(listener: (event: ComparisonEvent) => void): () => void;
}
```

Each method expresses one complete caller intention while hiding compatibility checks, unordered-pair identity, key validation, revisions, staging, publication, cancellation, projection, and cleanup. IDs keep direct module tests, Electron handlers, and IPC request types aligned; callers never retain a mutable session object that can become invalid after close.

`begin` discriminates Apply key from Refresh because both share the approved operation-handle lifecycle while preserving their different key semantics. Source dependency lookup and cascading source close remain workspace responsibilities and are not exposed as coordination methods on the comparison facet.

### Confirmed decision 6: stateless confirmed-impact close

Use one idempotent workspace close intention with an optional exact impact previously confirmed by the user. Do not maintain an opaque close-intent registry and never accept a generic `force: true`:

```ts
type CloseWorkingCsvRequest = {
  workingCsvId: string;
  confirmedImpact?: CloseImpact;
};

type CloseImpact = {
  dirty: boolean;
  dependentComparisons: Array<{
    comparisonId: string;
    baselineName: string;
    candidateName: string;
  }>;
};

type CloseWorkingCsvOutcome =
  | { status: 'closed'; closedWorkingCsvId: string; closedComparisonIds: string[] }
  | { status: 'confirmation-required'; impact: CloseImpact }
  | { status: 'failed'; failure: CloseFailure };
```

An unconfirmed request closes immediately only when the Working CSV is clean and has no dependent Comparisons. Otherwise it returns the exact current impact for the renderer's single combined dialog. On confirmation, the renderer resubmits that impact. The workspace recomputes and structurally compares the current dirty/dependency impact: a match authorizes only those consequences; a mismatch returns `confirmation-required` again with the new impact.

After a match, the workspace prevents new dependents, cancels and awaits dependent operations, drops their artifacts, closes their sessions, then closes the Working CSV. It returns all closed IDs for React state removal. Failure leaves every still-live entity represented and reports a normalized failure. Direct Comparison close remains immediate and idempotent. Workspace/window close can aggregate and reuse the same confirmed-impact principle without a server-held token.

### Confirmed decision 7: indexed bounded result windows

Result-window requests carry the current opaque `resultToken`, an offset, a hard-bounded limit of at most 1,000, and the renderer-owned row/column presentation modes. Responses repeat the token and return column metadata once plus rows whose arrays align with that metadata:

```ts
type ComparisonWindow = {
  comparisonId: string;
  resultToken: string;
  offset: number;
  totalRowCount: number;
  keyColumns: string[];
  valueColumns: Array<{ name: string; changedRowCount: number }>;
  rows: ComparisonRow[];
};

type ComparisonRow = {
  classification: 'changed' | 'baseline-only' | 'candidate-only' | 'unchanged';
  keyValues: string[];
  baseline: { rowId: string; values: Array<string | null> } | null;
  candidate: { rowId: string; values: Array<string | null> } | null;
  changed: boolean[];
};
```

`keyValues` aligns with `keyColumns`; both side `values` arrays and `changed` align with `valueColumns`. A null side means the row is absent, a null array entry is a null cell in a present row, and `''` is an exact empty-string cell. This distinction is never inferred from display text.

The module orders `valueColumns` according to Changed-first or Baseline CSV order and projects rows accordingly. It returns only the requested bounded window; the renderer may convert it to AG Grid row objects. A request with an old `resultToken` returns a typed result-replaced outcome, and a late response whose token is no longer current is ignored by the renderer.

### Confirmed decision 8: typed expected outcomes

Every condition the application can reasonably encounter is a discriminated, serializable outcome rather than an exception. This includes existing unordered pairs, identical or incompatible sources, busy comparisons, missing applied keys, invalid key data, cancellation, sources changing during generation, replaced result tokens, close races, confirmation requirements, and cleanup failures.

Generation completion is applied, invalid-key with bounded diagnostics, cancelled, sources-changed, or normalized failure. Operational failures expose only stable codes such as resource-exhausted, source-unavailable, query-failed, and cleanup-failed plus a safe message and retryability. DuckDB error strings, SQL, stack traces, physical table names, connections, and revisions never cross the interface.

Exceptions are reserved for implementation defects and violated internal invariants, such as an impossible classification or corrupt artifact registry. The Electron adapter serializes typed outcomes without interpreting them and logs unexpected exceptions as internal failures.

### Resolved interface contract

The external seam is `CsvWorkspace`, with focused `csvs` and `comparisons` facets. The Comparison interface is the explicit ID-based surface in confirmed decision 5, plus versioned Comparison events. `CsvWorkspace` itself owns stateless confirmed-impact close and final disposal.

The complete interface obeys these invariants:

- Comparison identity is the unordered pair of two distinct live Working CSV IDs. Reopening an existing pair preserves its current orientation and state.
- Compatibility is exact column-name-set equality; order and inferred types do not matter.
- Working CSV identity survives replacement. Its data revision increments after each successful edit, insert, delete, undo, redo, or replacement, and not after query/view changes or Save As.
- Renderer draft key and presentation state never enter the active snapshot. Apply key or Refresh publishes the applied key, result table pointer, captured source revisions, summary, version, and result token atomically.
- Invalid key, cancellation, failure, or source change preserves the entire prior applied result. A source revision mismatch immediately before publication prevents a newly Outdated result from being committed.
- At most one generation runs per Comparison. Cancel is comparison- and operation-token scoped. Events reflect committed state before the completion promise settles.
- Side swap is rejected while busy. Otherwise it reorients the active snapshot without recomputation, flips classifications and source mappings, preserves freshness by source identity, increments entity version, and mints a new result token.
- Result windows are capped at 1,000 rows, use exact deterministic composite-key ordering, carry a current result token, and never expose complete files to the renderer.
- Closing a Comparison is idempotent and cleans its work and artifacts. Confirmed source close authorizes an exact dirty/dependency impact, closes dependents before the source, and never removes an unconfirmed new dependent.
- Disposal cancels and awaits operations, releases read leases and connections, drops every owned staging/active/retired table, and then closes DuckDB. It is idempotent.

DuckDB is local-substitutable, so module tests use the real in-memory engine and temporary CSV fixtures through this same external interface. Database ports, SQL-runner interfaces, and public source-table descriptors are rejected as hypothetical seams.
