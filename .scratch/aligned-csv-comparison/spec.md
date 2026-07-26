# Aligned CSV Comparison — Implementation-Ready Specification

Status: ready for implementation

Decision sources:

- [Interaction contract](issues/01-choose-comparison-tab-interaction-contract.md)
- [DuckDB execution model](issues/02-choose-comparison-execution-model.md)
- [Workspace comparison interface](issues/03-design-comparison-data-module-interface.md)
- [Verification contract](issues/04-define-comparison-verification-contract.md)

## 1. Outcome and scope

Add persistent, read-only Comparison Tabs. A user explicitly starts from one open CSV Tab, selects another open Comparison-Compatible Working CSV as Candidate, selects and applies a Comparison Key inside the new Tab, and receives one aligned result row for every key present in either Working CSV.

The comparison always uses the complete non-deleted Working CSVs, including unsaved edits, inserts, deletes, undo, and redo. Source sort, filter, search, Stats state, and Tab activation never limit comparison scope. Equality is exact parsed text equality.

The renderer receives metadata, bounded diagnostics, summaries, and bounded result windows only. Complete Working CSVs and complete comparison results remain in main-process DuckDB storage.

The first version does not edit or export results, infer a key, match by row position, coerce incompatible schemas, add arbitrary result filters/search, compare more than two CSVs, restore Comparison Tabs after process restart, or compare directly from source files on disk.

Canonical product language is defined in [CONTEXT.md](../../CONTEXT.md). Implementations and UI copy use Baseline, Candidate, Comparison Key, Valid Comparison Key, Comparison-Compatible CSVs, Comparison Tab, Outdated Comparison, Changed Row, Unchanged Row, Baseline-only Row, Candidate-only Row, and Working CSV.

## 2. Entry, identity, and Tab behavior

### 2.1 Compare entry

- Show **Compare…** when a CSV Tab is active.
- The active Working CSV is the proposed Baseline.
- Compare opens a Candidate picker before creating or entering a Comparison Tab.
- List all other open CSV Tabs. Compatible choices appear first; incompatible choices are disabled and name columns missing from either side.
- Disable Compare when no other CSV Tab exists.
- Candidate ordering is compatible first, then incompatible; within each group order by displayed file name and path.

### 2.2 One Comparison per pair

Comparison identity is the unordered pair of two distinct live Working CSV IDs. Opening `(A, B)` after `(B, A)` already exists focuses the existing Comparison and preserves its current Baseline/Candidate orientation, applied key, draft key, result, freshness, and view state.

A new Comparison initially uses the initiating CSV as Baseline and selected CSV as Candidate. Its Tab uses a comparison glyph and compact `Baseline ⇄ Candidate` label. CSV dirty markers stay on CSV Tabs. An Outdated Comparison gets an amber Tab marker.

Comparison Tabs persist while switching Tabs but are not restored after the application process exits.

## 3. Comparison Tab interaction contract

### 3.1 Layout

One Comparison Tab contains:

1. A fixed configuration header with Baseline and Candidate cards, **Swap sides**, **Refresh comparison**, a multi-column draft-key selector, and **Apply key**.
2. A status region for validation, phases, Outdated state, cancellation, and failures.
3. Before first success, an instructional setup/empty state.
4. After success, a summary and presentation-toggle bar above one aligned virtualized result grid.

At the application minimum width, header controls wrap while remaining reachable. The aligned grid scrolls horizontally; it never becomes two independent grids or vertically stacked record cards. Result classification and Comparison Key columns stay pinned.

### 3.2 Draft key, Apply key, and Refresh

- The renderer owns the draft key. Changing it never changes the applied key or current result.
- Draft key order is composite-key order. It must contain one or more distinct compatible column names.
- **Apply key** validates the entire draft and, if valid, computes a replacement in one cancellable operation.
- **Refresh comparison** uses the applied key, never an unapplied draft. Disable it before first success.
- Applied key, snapshot, captured revisions, summary, entity version, and result token publish atomically.
- Invalid key, cancellation, source change, or operational failure preserves the complete prior applied state.
- If no prior result exists, the operation occupies the empty-state area. If a result exists, keep it readable under an operation banner until replacement commits.
- Report coarse phases only: `validating`, `comparing`, and `summarizing`. Do not invent percentages.
- Show **Cancel** only while an operation is active.

### 3.3 Result presentation

Summary counts include Changed, Baseline-only, Candidate-only, Unchanged, and total rows plus the Changed Row count for each non-key column.

The renderer owns two per-Comparison toggles:

- Rows: **Differences** by default (Changed + Baseline-only + Candidate-only), or **All rows**.
- Columns: **Changed first** by default, or **All in CSV order**.

Key columns appear once in applied-key order. Every non-key column appears as an adjacent Baseline/Candidate pair. Changed-first orders positive-count columns by changed-row count descending, using current Baseline column order for ties, followed by zero-change columns in Baseline order. All-in-CSV-order uses current Baseline order. A side swap may therefore change tied/all-column order without recomputing the snapshot.

Rows use composite Comparison Key ascending in exact binary text order. Changed cells use complementary Baseline/Candidate styling plus non-color indicators and accessible text. Equal pairs are neutral. A missing row side is labelled explicitly and is never rendered as a null or empty cell. Null and empty string use distinct labels.

No edit, Save, export, arbitrary search, or arbitrary filter controls appear in a Comparison Tab.

### 3.4 Outdated, failure, and cancellation

Successful edit, insert, delete, undo, redo, or Working CSV replacement immediately marks dependent applied results Outdated. The banner names which source or sources changed. Old results and their applied key remain readable. Refresh is always explicit.

An initial failure is a retryable empty error state. A replacement failure is an inline error above the preserved result. Cancellation returns to setup when no result exists; otherwise it preserves the result and presents a dismissible cancellation confirmation.

### 3.5 Swap

Disable Swap while an operation runs. Otherwise Swap reorients the active snapshot without recomputation: exchange Baseline/Candidate references and paired values, flip Baseline-only/Candidate-only classification and summary labels, increment the Comparison version, and mint a new result token. Preserve applied key and freshness by source identity.

## 4. Ownership and state model

Deepen the current `CsvDataService` into a main-process `CsvWorkspace` module with focused `csvs` and `comparisons` facets. `CsvWorkspace` owns the DuckDB instance, physical Working CSV tables, stable Working CSV IDs, revisions, source-to-comparison index, close ordering, artifact cleanup, and disposal.

The renderer owns only unapplied and presentation state.

| Main-process `CsvWorkspace` | Renderer |
|---|---|
| Working CSV and Comparison identities | Active Tab |
| Baseline/Candidate orientation | Candidate dialog state |
| Applied key | Draft key |
| Active snapshot, summary, result token | Differences/All toggle |
| Captured revisions and freshness | Changed-first/CSV-order toggle |
| Operation ID, phase, and terminal outcome | Grid selection, widths, scroll, focus |
| Dependencies and artifact lifecycle | Dismissed presentation notices |

Main state wins if a renderer event or window conflicts with a newer entity version or result token.

## 5. Main-process interface

Names below are normative in behavior; minor TypeScript naming changes are allowed only when semantics remain identical.

```ts
type WorkingCsvId = string;
type ComparisonId = string;
type ComparisonOperationId = string;
type ComparisonResultToken = string;

type ComparisonSide = 'baseline' | 'candidate';
type ComparisonPhase = 'validating' | 'comparing' | 'summarizing';

type WorkingCsvView = {
  workingCsvId: WorkingCsvId;
  dataRevision: number;
  file: CsvFileMetadata;
  columns: CsvColumn[];
  rowCount: number;
  dialect: CsvDialectOptions;
  editState: CsvEditState;
};

type WorkingCsvRef = Pick<WorkingCsvView, 'workingCsvId' | 'file' | 'columns'>;

interface CsvWorkspace {
  readonly csvs: WorkingCsvs;
  readonly comparisons: Comparisons;

  closeWorkingCsv(request: CloseWorkingCsvRequest): Promise<CloseWorkingCsvOutcome>;
  dispose(): Promise<void>;
}

interface WorkingCsvs {
  open(filePath: string, dialect?: CsvDialectOptions): Promise<OpenWorkingCsvOutcome>;
  replace(workingCsvId: WorkingCsvId, dialect?: CsvDialectOptions): Promise<ReplaceWorkingCsvOutcome>;
  getState(workingCsvId: WorkingCsvId): WorkingCsvView | null;
  getRows(request: WorkingCsvRowWindowRequest): Promise<CsvRowWindow>;
  getColumnValueCounts(request: WorkingCsvValueCountsRequest): Promise<CsvColumnValueCounts>;
  editCell(request: WorkingCsvCellEditRequest): Promise<CsvEditState>;
  deleteRows(request: WorkingCsvDeleteRowsRequest): Promise<CsvEditState>;
  insertRow(request: WorkingCsvInsertRowRequest): Promise<CsvEditState>;
  undo(workingCsvId: WorkingCsvId): Promise<CsvEditState>;
  redo(workingCsvId: WorkingCsvId): Promise<CsvEditState>;
  saveAs(workingCsvId: WorkingCsvId, filePath: string): Promise<CsvEditState>;
}

interface Comparisons {
  candidatesFor(baselineId: WorkingCsvId): ComparisonCandidate[];
  open(request: OpenComparisonRequest): ComparisonOpenResult;
  getState(comparisonId: ComparisonId): ComparisonView | null;
  begin(request: BeginComparisonRequest): BeginComparisonResult;
  cancel(request: CancelComparisonRequest): Promise<CancelComparisonResult>;
  getWindow(request: ComparisonWindowRequest): Promise<ComparisonWindowOutcome>;
  swap(comparisonId: ComparisonId): ComparisonMutationOutcome;
  close(comparisonId: ComparisonId): Promise<CloseComparisonOutcome>;
  subscribe(listener: (event: ComparisonEvent) => void): () => void;
}
```

The `WorkingCsvs` facet retains the existing open/read/edit/insert/delete/undo/redo/Save As/value-count intentions with `workingCsvId` replacing `sessionId`, and adds staged replacement behind a stable ID. It routes every data mutation through one private revision commit path. Its method names may be migrated mechanically from the current `CsvDataService`; comparison behavior must not depend on renderer query descriptors.

### 5.1 Candidate and open types

```ts
type ComparisonCandidate = {
  workingCsv: WorkingCsvView;
  compatibility:
    | { kind: 'compatible' }
    | {
        kind: 'incompatible';
        missingFromBaseline: string[];
        missingFromCandidate: string[];
      };
};

type OpenComparisonRequest = {
  baselineId: WorkingCsvId;
  candidateId: WorkingCsvId;
};

type ComparisonOpenResult =
  | { status: 'created'; comparison: ComparisonView }
  | { status: 'existing'; comparison: ComparisonView }
  | { status: 'rejected'; fault: ComparisonFault };
```

Open canonicalizes the unordered pair. Existing preserves its orientation. Reject missing, identical, or incompatible sources with typed faults.

### 5.2 State projection and events

```ts
type ComparisonView = {
  comparisonId: ComparisonId;
  version: number;
  baseline: WorkingCsvRef;
  candidate: WorkingCsvRef;
  availableKeyColumns: string[];
  operation: null | {
    operationId: ComparisonOperationId;
    intent: 'apply-key' | 'refresh';
    phase: ComparisonPhase;
  };
  applied: null | {
    key: string[];
    resultToken: ComparisonResultToken;
    freshness:
      | { kind: 'current' }
      | { kind: 'outdated'; changedSides: ComparisonSide[] };
    summary: ComparisonSummary;
  };
  lastAttempt: ComparisonAttemptOutcomeView | null;
};

type ComparisonAttemptOutcomeView =
  | { status: 'applied' }
  | { status: 'invalid-key'; diagnostics: ComparisonKeyDiagnostics }
  | { status: 'cancelled' }
  | { status: 'sources-changed'; changedSides: ComparisonSide[] }
  | { status: 'failed'; failure: ComparisonFailure };

type ComparisonEvent =
  | { kind: 'changed'; comparison: ComparisonView }
  | { kind: 'closed'; comparisonId: ComparisonId };
```

Every committed Comparison change increments `version` and emits a complete serializable projection. React retains only the greatest version for an ID. Do not add a generic workspace snapshot/delta framework.

### 5.3 Operations

```ts
type BeginComparisonRequest =
  | { kind: 'apply-key'; comparisonId: ComparisonId; key: string[] }
  | { kind: 'refresh'; comparisonId: ComparisonId };

type BeginComparisonResult =
  | {
      status: 'accepted';
      operationId: ComparisonOperationId;
      completion: Promise<ComparisonAttemptOutcome>;
    }
  | { status: 'busy'; activeOperationId: ComparisonOperationId }
  | { status: 'rejected'; fault: ComparisonFault };

type ComparisonAttemptOutcome =
  | { status: 'applied'; comparison: ComparisonView }
  | {
      status: 'invalid-key';
      diagnostics: ComparisonKeyDiagnostics;
      comparison: ComparisonView;
    }
  | { status: 'cancelled'; comparison: ComparisonView }
  | {
      status: 'sources-changed';
      changedSides: ComparisonSide[];
      comparison: ComparisonView;
    }
  | {
      status: 'failed';
      failure: ComparisonFailure;
      comparison: ComparisonView;
    };

type CancelComparisonResult =
  | { status: 'requested' }
  | { status: 'already-requested' }
  | { status: 'already-finished' }
  | { status: 'operation-mismatch' }
  | { status: 'comparison-not-found' };
```

The completion promise is main-process-only. IPC returns the operation ID immediately and reports later state through Comparison events. Cancel requires both Comparison and operation IDs. It is idempotent and returns requested, already-requested, already-finished, operation-mismatch, or comparison-not-found. A late Cancel never interrupts newer work.

Expected conditions are typed outcomes. Only implementation defects and violated private invariants throw.

### 5.4 Summary, diagnostics, and windows

```ts
type ComparisonSummary = {
  rows: {
    changed: number;
    baselineOnly: number;
    candidateOnly: number;
    unchanged: number;
    total: number;
  };
  changedColumns: Array<{ name: string; changedRowCount: number }>;
};

type SourceKeyDiagnostics = {
  blankRowCount: number;
  duplicateGroupCount: number;
  blankExamples: Array<{
    rowId: string;
    keyValues: Array<string | null>;
  }>;
  duplicateExamples: Array<{
    keyValues: string[];
    rowCount: number;
    rowIds: string[];
  }>;
};

type ComparisonKeyDiagnostics = {
  key: string[];
  baseline: SourceKeyDiagnostics;
  candidate: SourceKeyDiagnostics;
};

type ComparisonWindowRequest = {
  comparisonId: ComparisonId;
  resultToken: ComparisonResultToken;
  offset: number;
  limit: number;
  rows: 'differences' | 'all';
  columns: 'changed-first' | 'csv-order';
};

type ComparisonWindow = {
  comparisonId: ComparisonId;
  resultToken: ComparisonResultToken;
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

type ComparisonWindowOutcome =
  | { status: 'ready'; window: ComparisonWindow }
  | {
      status: 'result-replaced';
      currentResultToken: ComparisonResultToken | null;
    }
  | { status: 'comparison-not-found' }
  | { status: 'rejected'; fault: ComparisonFault };

type ComparisonMutationOutcome =
  | { status: 'changed'; comparison: ComparisonView }
  | { status: 'rejected'; fault: ComparisonFault };

type CloseComparisonOutcome =
  | { status: 'closed'; comparisonId: ComparisonId }
  | { status: 'failed'; failure: ComparisonFailure };
```

Diagnostic counts are complete. Return at most five blank examples, five duplicate groups, and five row IDs per duplicate group. Blank examples use source order. Duplicate groups use composite-key binary order and include only rows with all key parts present. Duplicate row IDs use source order.

Window limits are integers from 0 through 1,000. Array alignment is part of the interface. Null side means absent row; null array entry means null cell; `''` means empty-string cell. An old result token returns `result-replaced` with the current token rather than reading the retired snapshot.

### 5.5 Faults and failures

Typed faults include source/comparison not found, same source, incompatible columns, invalid key shape/unknown column, no applied key, busy, invalid window, result replaced, and operation mismatch:

```ts
type ComparisonFault = {
  code:
    | 'source-not-found'
    | 'comparison-not-found'
    | 'same-source'
    | 'incompatible-columns'
    | 'invalid-key-shape'
    | 'unknown-key-column'
    | 'no-applied-key'
    | 'busy'
    | 'invalid-window'
    | 'result-replaced'
    | 'operation-mismatch';
  message: string;
};
```

Operational failures expose stable codes only:

```ts
type ComparisonFailure = {
  code:
    | 'resource-exhausted'
    | 'source-unavailable'
    | 'query-failed'
    | 'cleanup-failed';
  message: string;
  retryable: boolean;
};
```

Never expose SQL, table names, DuckDB connection state, raw DuckDB messages, or stack traces.

## 6. DuckDB execution contract

### 6.1 Working CSV storage and revisions

Continue parsing with `all_varchar = true`. Preserve internal row ID, source order, and deleted flag. A stable logical Working CSV ID points to its current physical table and monotonic data revision.

Increment revision exactly once after each successful edit, insert, delete, undo, redo, or Working CSV replacement. Do not increment after a failed mutation, sorting, filtering, searching, Stats changes, Tab activation, or Save As. A submitted edit may increment even when the text equals the prior value; callers do not decide physical no-op semantics.

Replacement stages and validates a new table, atomically swaps it behind the existing Working CSV ID, clears edit history, increments revision, and retires the old table. Parse failure leaves identity, table, revision, and dependents unchanged.

Replacement may change the column-name set. Existing dependent snapshots remain readable and become Outdated. When the current sources are no longer Comparison-Compatible, Apply key and Refresh return `incompatible-columns` without touching the old applied key/result; Candidate/application code never silently closes the Comparison. `availableKeyColumns` reflects the exact shared set for display, but Apply remains disabled/rejected until the complete sets match again.

### 6.2 Key validation

Validate both complete non-deleted Working CSVs. Every selected column must exist on both sides. A row is blank-keyed if any part is null or empty string. A duplicate group contains more than one row with the same complete, nonblank composite key. Any blank row or duplicate group makes the key invalid.

Compute complete counts and bounded examples as specified in section 5.4. Do not infer, normalize, trim, case-fold, coerce, or fall back to row position.

### 6.3 Materialized snapshot

Each published generation owns one DuckDB table with one row per unioned valid key. Store:

- classification;
- Baseline and Candidate internal row IDs;
- each key value once;
- Baseline and Candidate exact `VARCHAR` value for every non-key column; and
- one changed boolean per non-key column for matched rows.

Join by equality on every validated key part. Compare cells with `IS NOT DISTINCT FROM`: null/null is equal, null/empty differs, and case/whitespace/leading-zero differences remain exact differences. Determine Changed when any non-key changed flag is true. A key-only matched pair is Unchanged.

Compatibility and SQL projection are name-based. Use Baseline order only for presentation metadata.

Do not use a live result view or re-run the full join per window; both break immutable Outdated results. Do not materialize separate input snapshots plus a live result unless a later measured constraint requires reconsideration.

### 6.4 Generation publication

For Apply key or Refresh:

1. Validate request and reserve the single operation slot.
2. Generate a unique operation ID, commit `validating`, increment version, and emit state.
3. Capture source IDs, revisions, and physical-table read leases.
4. On a dedicated worker connection, validate the key.
5. For a valid key, create a uniquely named registered staging result and emit `comparing`.
6. Aggregate summary/changed-column counts and emit `summarizing`.
7. Under the workspace lifecycle lock, recheck both source identities and revisions.
8. If either changed, retire staging and complete `sources-changed`.
9. Otherwise atomically publish staging pointer, applied key, captured revisions, summary, new result token, and new Comparison version.
10. Emit committed state, retire the prior active snapshot, release leases/worker, and settle completion.

Invalid key, cancellation, failure, or sources-changed retires only staging state and preserves the prior applied state. Events reflect committed state before the completion promise settles.

### 6.5 Cancellation, reads, and artifacts

Each generation gets a dedicated connection to the same DuckDB instance. `interrupt()` is operation-token scoped. Never share that worker connection with Working CSV reads/edits, other Comparisons, or active snapshot reads.

Result reads acquire a short lease on the active snapshot. Replaced/closed tables become retired immediately and physically drop after leases reach zero. Track every Working CSV and Comparison table in a private artifact registry with owner, role (`current`, `staging`, `active`, `retired`), and operation ID where applicable.

Closing and disposal reject new leases/work, interrupt and await operations, release connections, drop owned artifacts, and remove logical state only after cleanup succeeds. `dispose()` is idempotent and closes the DuckDB instance last.

The internal `ComparisonExecutor` seam has a real DuckDB adapter and a scripted lifecycle-test adapter. It is not exported through the workspace, IPC, or preload interfaces.

## 7. Close and shutdown contract

Closing a Comparison is immediate and idempotent. It cancels/awaits its operation, retires/drops its artifacts, removes dependency indexes/state, and emits `closed`.

Source close uses a stateless confirmed-impact request:

```ts
type CloseImpact = {
  dirty: boolean;
  dependentComparisons: Array<{
    comparisonId: ComparisonId;
    baselineName: string;
    candidateName: string;
  }>;
};

type CloseWorkingCsvRequest = {
  workingCsvId: WorkingCsvId;
  confirmedImpact?: CloseImpact;
};

type CloseWorkingCsvOutcome =
  | {
      status: 'closed';
      closedWorkingCsvId: WorkingCsvId;
      closedComparisonIds: ComparisonId[];
    }
  | { status: 'confirmation-required'; impact: CloseImpact }
  | {
      status: 'failed';
      failure: {
        code: 'source-unavailable' | 'cleanup-failed';
        message: string;
        retryable: boolean;
      };
    };
```

Without confirmation, a clean source with no dependents closes; otherwise return `confirmation-required` with exact current impact. On resubmission, structurally compare confirmed and current impact. If different, return the new confirmation requirement. Never accept `force: true`.

After a match, mark source/dependents closing, reject new work, cancel and await dependent operations, clean/remove Comparisons, then clean/remove the Working CSV. Return every closed ID. On failure, preserve every still-live logical entity and return a normalized failure.

The same principle aggregates application quit impact. Electron `before-quit` must await `workspace.dispose()` rather than fire-and-forget cleanup.

## 8. IPC and preload contract

Add serializable IPC channels for Candidate listing, Comparison open/state/begin/cancel/window/swap/close, Comparison events, and confirmed-impact Working CSV close. Extend the preload interface with matching typed methods and one `onComparisonEvent` subscription returning an unsubscribe function.

The begin handler calls the main-process interface, attaches rejection logging to the internal completion promise, and serializes only accepted operation ID, busy, or rejected fault. Later complete states arrive through `comparison:state-changed` events.

Electron handlers are adapters only: no revision arithmetic, key validation, dependency traversal, SQL construction, result reshaping, or cleanup sequencing belongs in `main.ts`.

## 9. Renderer contract

Replace the CSV-only `tabs: CsvSessionMetadata[]` assumption with a discriminated renderer Tab union:

```ts
type RendererTab =
  | { kind: 'csv'; workingCsvId: WorkingCsvId }
  | {
      kind: 'comparison';
      comparisonId: ComparisonId;
      draftKey: string[];
      rows: 'differences' | 'all';
      columns: 'changed-first' | 'csv-order';
    };
```

Keep authoritative `WorkingCsvView` and `ComparisonView` maps separate from renderer Tab presentation state. A Comparison event reducer ignores projections whose version is not greater than the stored version and removes closed IDs. A result data source ignores responses whose token differs from the active result.

Use 100-row Comparison grid blocks, at most six cached blocks, and at most two concurrent window requests. Convert indexed bounded rows to AG Grid objects inside the renderer data source; never accumulate complete result pages in React state.

Implement the interaction and accessibility requirements from sections 3 and 11. Comparison cells are never editable.

## 10. Migration and implementation sequence

### Phase 1 — stabilize workspace ownership

1. Introduce `WorkingCsvId` and `WorkingCsvView` with `dataRevision`.
2. Move the DuckDB instance, connection creation, session registry, and table ownership into `CsvWorkspace`.
3. Route all existing mutations through one revision-aware commit path while preserving current CSV behavior/tests.
4. Change Reopen into staged replacement behind the same logical ID.
5. Add awaited idempotent disposal and artifact/read-lease primitives.

Rename current serialized `sessionId` to `workingCsvId` in one mechanical shared/preload/renderer migration. Internal physical table IDs remain private UUIDs. There is no compatibility need for the old in-process wire name across application versions.

### Phase 2 — comparison data module

1. Add the unordered-pair/session/dependency indexes and versioned state projection.
2. Implement key validation/diagnostics and snapshot SQL behind the internal executor.
3. Implement operation handles, worker interruption, atomic publication, summaries, token-guarded windows, Swap, close, and cleanup.
4. Build the authoritative real-DuckDB matrix and scripted lifecycle tests before renderer integration.

### Phase 3 — IPC and dependent close

1. Add shared serializable request/outcome/event types and channels.
2. Add preload methods/subscription and thin main handlers.
3. Replace existing dirty-only `closeCsv` confirmation with confirmed dirty + dependent impact.
4. Gate window quit on awaited aggregate close/disposal.

### Phase 4 — renderer Tab model and UI

1. Convert App/TabStrip to the discriminated Tab union without changing current CSV rendering.
2. Add Compare Candidate dialog and pair focus/reuse.
3. Add Comparison configuration/status/summary/grid views and event reconciliation.
4. Apply accessibility behavior and responsive/wide-grid styling.

### Phase 5 — release verification

1. Add deterministic small comparison fixtures and generation scripts for the million-row pair.
2. Add IPC/renderer/accessibility tests.
3. Run test, typecheck, build, the three manual passes, and record stress observations.

### Migration impact

- No persistent database, CSV file, or recent-file format migrates; all workspace tables and Comparison sessions are process-memory state.
- Existing Working CSV tests should be preserved at the new workspace seam, then obsolete shallow-service tests removed rather than duplicated.
- Current renderer `activeSessionId`, dirty-ID sets, CSV-only TabStrip props, and mapped CSV views must become kind-aware.
- Current `reopenSession` replacement-by-new-ID behavior is intentionally incompatible and must change before Comparisons land.
- Existing row-window APIs stay bounded and semantically unchanged apart from the Working CSV ID rename.
- Current menu request events remain; Comparison state events add a separate typed channel.
- Recent files, dialect controls, Stats Panel, CSV query state, editing, and Save As remain CSV-Tab-only.

## 11. Verification and acceptance

The detailed normative contract is [issue 04](issues/04-define-comparison-verification-contract.md). At minimum:

- Authoritative behavior tests cross `CsvWorkspace` with real in-memory DuckDB and explicit fixture-authored expected results.
- The full compatibility/key/equality/classification/mutation/replacement/concurrency/swap/lifecycle/boundary/out-of-scope matrix passes.
- Scripted-executor tests deterministically cover every operation phase, source-change publication race, close race, failure, and obsolete completion.
- Real integration proves worker interruption, owner/read survival, and artifact cleanup.
- IPC windows never exceed 1,000 rows; the grid caches at most six 100-row blocks with at most two concurrent requests.
- Cancel completes and cleans staging within two seconds on the stress fixture; a source window renders within one second during generation.
- Five Refresh cycles do not show monotonic settled-memory growth. No total comparison-time release threshold exists.
- WCAG 2.2 AA requirements pass automated semantic/focus checks and the focused keyboard/NVDA/manual pass.
- The functional, visual/accessibility, and stress/lifecycle manual release passes all pass.
- `pnpm run test`, `pnpm run typecheck`, and `pnpm run build` pass.

## 12. Rejected designs

- A sibling Comparison service consuming public `CsvDataService` table/revision access: leaks lifecycle coordination and database mechanics.
- One flat workspace method collection: obscures focused CSV and Comparison intentions.
- Generic `change`/`read` command unions: fewer methods but worse discoverability than explicit ID-based intentions.
- Stateful Comparison object handles: map poorly to IPC and can outlive closed sessions.
- Workspace-wide renderer snapshots/deltas: unnecessary because React reconciles complete versioned Comparison projections.
- Opaque server-held close-intent tokens: exact confirmed impact gives the same safety with less lifecycle state.
- Live result views or per-window full joins: cannot preserve immutable Outdated results and repeat expensive work.
- Public DuckDB/SQL ports or mocked query correctness: DuckDB is local-substitutable and real in-memory tests are available.
