import { DataEngineError, WorkspaceDatabase, type WorkspaceDatabaseConnection } from '../database';
import { Cause, Context, Deferred, Effect, Exit, Latch, Layer, Result, type Scope, type Types } from 'effect';
import { observeCleanup, observeStage, recordOutcome, reportFailure, markCleanupFailed } from '../workspace-diagnostics';
import { WorkspaceRequestError } from '../errors';
import { csvInternalRowIdField, supportedCsvFileExtensions } from '../csv-viewer';
import type {
  CsvCellEditRequest,
  CsvCellEditResult,
  CsvColumnValues,
  CsvColumnValuesRequest,
  CsvColumnValueCounts,
  CsvColumnValueCountsRequest,
  CsvDeleteColumnRequest,
  CsvDeleteRowsRequest,
  CsvDialectOptions,
  CsvEditState,
  CsvExportOutcome,
  CsvViewExportRequest,
  CsvViewExportOutcome,
  CsvViewExportEvent,
  CancelViewExportRequest,
  CancelViewExportOutcome,
  CsvEditStateRequest,
  CsvInsertColumnRequest,
  CsvInsertRowRequest,
  CsvRenameColumnRequest,
  CsvRowWindow,
  CsvRowWindowRequest,
  CsvSchemaEditState,
  CsvSourceId,
  WorkingCsvId,
  WorkingCsvView,
} from '../csv-viewer';
import { ComparisonExecutor } from '../comparison/comparison-executor';
import { CsvEditHistory, rowCountDelta, type CsvEditDraft } from './csv-edit-history';
import { serializeCsvExport, serializeCsvViewExport } from './csv-export-serialization';
import {
  buildColumnValueCountsQuery,
  buildColumnValuesQuery,
  buildRowsQuery,
  buildViewExportQuery,
  maxRowWindowLimit,
  requireKnownColumn,
} from '../query/csv-query';
import { normalizeCellValue, normalizeCount, normalizeRow } from '../query/csv-result-normalization';
import {
  applyCellValue,
  applyRowDeletion,
  assertRowsExist,
  columnsAfter,
  createWorkingCsvTable,
  dropWorkingCsvTable,
  insertEmptyRow,
  readCellValue,
  readColumns,
  readExportRows,
  readRowCount,
  runEditCommand,
  type CsvTable,
} from './csv-working-csv-table';
import { csvDeletedField, csvHiddenColumnPrefix, csvSourceOrderField, hiddenCsvColumnName } from './csv-storage-schema';
import { DuckDbComparisonExecutor } from '../comparison/duckdb-comparison-executor';
import { CsvSourceUnavailableError, CsvWorkspaceHost } from '../workspace-host';
import { WorkspaceArtifactRegistry } from '../workspace-artifact-registry';

type WorkingCsvOperationError = WorkspaceRequestError | DataEngineError;

type WorkingCsvFailure = {
  code: 'open-failed' | 'replace-failed';
  message: string;
  retryable: boolean;
};

type OpenWorkingCsvOutcome =
  | { status: 'opened'; workingCsv: WorkingCsvView }
  | { status: 'existing'; workingCsv: WorkingCsvView }
  | { status: 'failed'; failure: WorkingCsvFailure };

type ReplaceWorkingCsvOutcome =
  | { status: 'replaced'; workingCsv: WorkingCsvView }
  | { status: 'revision-changed'; workingCsv: WorkingCsvView }
  | { status: 'failed'; failure: WorkingCsvFailure };

const workingCsvTablePrefix = 'csv_working_';

type WorkingCsvState = {
  metadata: Omit<WorkingCsvView, 'editState'>;
  tableName: string;
  sourceId: CsvSourceId;
  defaultDelimiter: string;
  history: CsvEditHistory;
};

type TableLease = { count: number; released: Deferred.Deferred<void> };

/**
 * The workspace's Working CSVs: their lifecycle, reads, edits, history, and export. Leases,
 * the mutation queue, and admission coordinate the work, as the workspace README describes.
 */
export interface WorkingCsvs {
  beginDisposal(): void;
  admit(): Effect.Effect<boolean, never, Scope.Scope>;
  open(sourceId: CsvSourceId, options?: CsvDialectOptions): Effect.Effect<OpenWorkingCsvOutcome, WorkspaceRequestError>;
  getState(workingCsvId: WorkingCsvId): WorkingCsvView | null;
  has(workingCsvId: WorkingCsvId): boolean;
  list(): WorkingCsvView[];
  subscribeToDataChanges(listener: (workingCsvId: WorkingCsvId) => void): () => void;
  isClosing(workingCsvId: WorkingCsvId): boolean;
  beginClose(workingCsvId: WorkingCsvId): boolean;
  endClose(workingCsvId: WorkingCsvId): void;
  waitForActiveWork(workingCsvId: WorkingCsvId): Effect.Effect<void>;
  replace(workingCsvId: WorkingCsvId, expectedDataRevision: number, options?: CsvDialectOptions): Effect.Effect<ReplaceWorkingCsvOutcome>;
  closeWorkingCsv(workingCsvId: WorkingCsvId): Effect.Effect<void, DataEngineError>;
  disposeStore(): Effect.Effect<void, DataEngineError>;
  releaseSourcesAfterEngineStop(): void;
  hasUnexportedChanges(workingCsvId: WorkingCsvId): boolean;
  getEditState(request: CsvEditStateRequest): Effect.Effect<CsvEditState, WorkspaceRequestError>;
  getRows(request: CsvRowWindowRequest): Effect.Effect<CsvRowWindow, WorkingCsvOperationError>;
  getColumnValues(request: CsvColumnValuesRequest): Effect.Effect<CsvColumnValues, WorkingCsvOperationError>;
  getColumnValueCounts(request: CsvColumnValueCountsRequest): Effect.Effect<CsvColumnValueCounts, WorkingCsvOperationError>;
  editCell(request: CsvCellEditRequest): Effect.Effect<CsvCellEditResult, WorkingCsvOperationError>;
  deleteRows(request: CsvDeleteRowsRequest): Effect.Effect<CsvEditState, WorkingCsvOperationError>;
  insertRow(request: CsvInsertRowRequest): Effect.Effect<CsvEditState, WorkingCsvOperationError>;
  renameColumn(request: CsvRenameColumnRequest): Effect.Effect<CsvSchemaEditState, WorkingCsvOperationError>;
  insertColumn(request: CsvInsertColumnRequest): Effect.Effect<CsvSchemaEditState, WorkingCsvOperationError>;
  deleteColumn(request: CsvDeleteColumnRequest): Effect.Effect<CsvSchemaEditState, WorkingCsvOperationError>;
  undo(workingCsvId: WorkingCsvId): Effect.Effect<CsvSchemaEditState, WorkingCsvOperationError>;
  redo(workingCsvId: WorkingCsvId): Effect.Effect<CsvSchemaEditState, WorkingCsvOperationError>;
  exportCsv(workingCsvId: WorkingCsvId): Effect.Effect<CsvExportOutcome, WorkingCsvOperationError | CsvSourceUnavailableError>;
  exportView(request: CsvViewExportRequest): Effect.Effect<CsvViewExportOutcome, WorkingCsvOperationError | CsvSourceUnavailableError>;
  cancelViewExport(request: CancelViewExportRequest): Effect.Effect<CancelViewExportOutcome>;
  subscribeToViewExports(listener: (event: CsvViewExportEvent) => void): () => void;
}

export const WorkingCsvs = Context.Service<WorkingCsvs>('csv-viewer/WorkingCsvs');

/**
 * Builds the Working CSV store on the host and database, with the DuckDB Comparison executor that
 * shares its table leases, admission, and artifact registry.
 */
export const workingCsvsLayer = Layer.effectContext(Effect.gen(function* () {
  const store = new WorkingCsvStore(yield* CsvWorkspaceHost, yield* WorkspaceDatabase);
  return Context.make(WorkingCsvs, store).pipe(Context.add(ComparisonExecutor, store.createComparisonExecutor()));
}));

class WorkingCsvStore implements WorkingCsvs {
  private readonly artifactRegistry = new WorkspaceArtifactRegistry();
  private workingCsvs = new Map<string, WorkingCsvState>();
  private dataChangeListeners = new Set<(workingCsvId: WorkingCsvId) => void>();
  private closingWorkingCsvs = new Set<string>();
  /** Leases per physical table. `released` completes when the last lease is returned. */
  private tableLeases = new Map<string, TableLease>();
  /** The most recently reserved mutation turn of each Working CSV. */
  private mutationTails = new Map<WorkingCsvId, Deferred.Deferred<void>>();
  /** The table release in flight for each closing Working CSV. */
  private readonly pendingCloses = new Map<WorkingCsvId, Effect.Effect<void, DataEngineError>>();
  /** Export workers whose close failed. Disposal retries them before the database is released. */
  private readonly unreleasedExportWorkers = new Set<WorkspaceDatabaseConnection>();
  private readonly busyExports = new Set<WorkingCsvId>();
  private readonly viewExports = new Map<WorkingCsvId, { operationId: string; cancel: Deferred.Deferred<void>; preparing: boolean }>();
  private readonly viewExportListeners = new Set<(event: CsvViewExportEvent) => void>();
  private admittedWork = 0;
  /** Open while no admitted open, reopen, or worker connection setup is running. */
  private readonly workSettled = Latch.makeUnsafe(true);
  private lifecycle: 'active' | 'disposing' | 'disposed' = 'active';

  constructor(
    private readonly host: CsvWorkspaceHost,
    private readonly database: WorkspaceDatabase,
  ) {}

  beginDisposal(): void {
    if (this.lifecycle === 'active') this.lifecycle = 'disposing';
    for (const workingCsvId of this.viewExports.keys()) this.cancelPreparation(workingCsvId);
  }

  /**
   * Admits work that disposal must wait for until the scope closes: opens, reopens, and Comparison
   * worker connection setup. Returns false once disposal begins.
   */
  admit(): Effect.Effect<boolean, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => {
        if (this.lifecycle !== 'active') return false;
        this.admittedWork += 1;
        this.workSettled.closeUnsafe();
        return true;
      }),
      (admitted) => Effect.sync(() => {
        if (!admitted) return;
        this.admittedWork -= 1;
        if (this.admittedWork === 0) this.workSettled.openUnsafe();
      }),
    );
  }

  /**
   * Opens a CSV Source as admitted work, so it cannot start once disposal begins. A caller that
   * must also cover later steps, such as the Recent CSV Source write, holds its own admission.
   */
  readonly open = Effect.fnUntraced(function* (
    this: WorkingCsvStore,
    sourceId: CsvSourceId,
    options: CsvDialectOptions = {},
  ): Effect.fn.Return<OpenWorkingCsvOutcome, WorkspaceRequestError, Scope.Scope> {
    if (!(yield* this.admit())) {
      return { status: 'failed', failure: { code: 'open-failed', message: 'The CSV workspace is closing.', retryable: false } } satisfies OpenWorkingCsvOutcome;
    }
    const existing = this.findBySource(sourceId);
    if (existing) return { status: 'existing', workingCsv: existing } satisfies OpenWorkingCsvOutcome;
    return yield* this.createWorkingCsv(sourceId, options, crypto.randomUUID(), 0, 0).pipe(
      Effect.map((state): OpenWorkingCsvOutcome => {
        const alreadyOpen = this.findBySource(sourceId);
        if (alreadyOpen) return { status: 'existing', workingCsv: alreadyOpen };
        const view = buildWorkingCsvView(state);
        this.artifactRegistry.transition(state.tableName, 'current');
        this.workingCsvs.set(state.metadata.workingCsvId, state);
        return { status: 'opened', workingCsv: view };
      }),
      Effect.scoped,
      Effect.catchCause((cause) => {
        if (!isDeclaredOpenFailure(cause)) return Effect.failCause(cause);
        return recordOpenFailure(cause).pipe(
          Effect.as({ status: 'failed', failure: workingCsvFailure('open-failed', Cause.squash(cause)) } satisfies OpenWorkingCsvOutcome),
        );
      }),
    );
  }, Effect.scoped, Effect.uninterruptible);

  private findBySource(sourceId: CsvSourceId): WorkingCsvView | null {
    for (const state of this.workingCsvs.values()) {
      if (state.sourceId === sourceId) return buildWorkingCsvView(state);
    }
    return null;
  }

  getState(workingCsvId: WorkingCsvId): WorkingCsvView | null {
    const state = this.workingCsvs.get(workingCsvId);
    return state ? buildWorkingCsvView(state) : null;
  }

  /** Existence without the cost of projecting a whole Working CSV view. */
  has(workingCsvId: WorkingCsvId): boolean {
    return this.workingCsvs.has(workingCsvId);
  }

  list(): WorkingCsvView[] {
    return [...this.workingCsvs.values()].map(buildWorkingCsvView);
  }

  subscribeToDataChanges(listener: (workingCsvId: WorkingCsvId) => void): () => void {
    this.dataChangeListeners.add(listener);
    return () => this.dataChangeListeners.delete(listener);
  }

  isClosing(workingCsvId: WorkingCsvId): boolean {
    return this.closingWorkingCsvs.has(workingCsvId);
  }

  beginClose(workingCsvId: WorkingCsvId): boolean {
    if (!this.workingCsvs.has(workingCsvId) || this.closingWorkingCsvs.has(workingCsvId)) return false;
    this.closingWorkingCsvs.add(workingCsvId);
    this.cancelPreparation(workingCsvId);
    return true;
  }

  endClose(workingCsvId: WorkingCsvId): void {
    this.closingWorkingCsvs.delete(workingCsvId);
  }

  /** Waits for admitted reads and queued mutations, so close impact reflects their results. */
  waitForActiveWork(workingCsvId: WorkingCsvId): Effect.Effect<void> {
    return observeStage('csv.await-leases', this.awaitLeases(workingCsvId));
  }

  createComparisonExecutor(): ComparisonExecutor {
    return new DuckDbComparisonExecutor(
      {
        acquireSource: (workingCsvId) => this.lease(workingCsvId).pipe(
          Effect.map((state) => ({
            tableName: state.tableName,
            columns: state.metadata.columns.map((column) => ({ ...column })),
          })),
        ),
        getOwnerConnection: () => this.database.ownerConnection(),
        connectWorker: () => Effect.scoped(Effect.gen({ self: this }, function* () {
          if (!(yield* this.admit())) return yield* Effect.fail(new WorkspaceRequestError({ message: 'CSV workspace is disposing.' }));
          return yield* this.database.connectWorker();
        })),
      },
      this.artifactRegistry,
    );
  }

  /**
   * Replaces the Working CSV's table with a freshly parsed one. The replacement is admitted work and
   * a mutation, so it runs in order with edits and replaces the state current when its turn begins.
   */
  readonly replace = Effect.fnUntraced(function* (
    this: WorkingCsvStore,
    workingCsvId: WorkingCsvId,
    expectedDataRevision: number,
    options: CsvDialectOptions = {},
  ): Effect.fn.Return<ReplaceWorkingCsvOutcome, never, Scope.Scope> {
    if (!(yield* this.admit())) return unavailable('The CSV workspace is closing.');
    this.cancelPreparation(workingCsvId);
    return yield* this.mutate(workingCsvId, (existing) => Effect.gen({ self: this }, function* () {
      if (existing.metadata.dataRevision !== expectedDataRevision) {
        return { status: 'revision-changed', workingCsv: buildWorkingCsvView(existing) } satisfies ReplaceWorkingCsvOutcome;
      }
      const state = yield* this.createWorkingCsv(
        existing.sourceId, options, workingCsvId, existing.metadata.dataRevision + 1,
        existing.history.revisionSequence,
      );
      yield* Effect.sync(() => this.publishReplacement(existing, state));
      return { status: 'replaced', workingCsv: buildWorkingCsvView(state) } satisfies ReplaceWorkingCsvOutcome;
    }).pipe(
      Effect.scoped,
      Effect.catchCause((cause) => {
        if (!isDeclaredOpenFailure(cause)) return Effect.failCause(cause);
        return recordOpenFailure(cause).pipe(
          Effect.as({ status: 'failed', failure: workingCsvFailure('replace-failed', Cause.squash(cause)) } satisfies ReplaceWorkingCsvOutcome),
        );
      }),
    )).pipe(Effect.catch(() => Effect.succeed(unavailable('This CSV is closing.'))));
  }, Effect.scoped, Effect.uninterruptible);

  /** No await or observer runs between the role changes and the state swap. */
  private publishReplacement(existing: WorkingCsvState, replacement: WorkingCsvState): void {
    try {
      this.artifactRegistry.transition(existing.tableName, 'retired');
      this.artifactRegistry.transition(replacement.tableName, 'current');
      this.workingCsvs.set(existing.metadata.workingCsvId, replacement);
    } catch (error) {
      this.workingCsvs.set(existing.metadata.workingCsvId, existing);
      if (this.artifactRegistry.get(replacement.tableName)?.role === 'current') {
        this.artifactRegistry.transition(replacement.tableName, 'staging');
      }
      if (this.artifactRegistry.get(existing.tableName)?.role === 'retired') {
        this.artifactRegistry.transition(existing.tableName, 'current');
      }
      throw error;
    }
  }

  /**
   * Releases the Working CSV's tables and forgets it. One release runs per Working CSV at a time:
   * a caller that arrives while another is running, such as disposal during a user close, awaits
   * that release rather than dropping the same tables twice.
   */
  closeWorkingCsv(workingCsvId: WorkingCsvId): Effect.Effect<void, DataEngineError> {
    return Effect.suspend(() => {
      const pending = this.pendingCloses.get(workingCsvId);
      if (pending) return pending;
      return Effect.cached(this.releaseWorkingCsv(workingCsvId).pipe(
        Effect.ensuring(Effect.sync(() => this.pendingCloses.delete(workingCsvId))),
      )).pipe(Effect.flatMap((close) => {
        this.pendingCloses.set(workingCsvId, close);
        return close;
      }));
    });
  }

  private readonly releaseWorkingCsv = Effect.fnUntraced(function* (
    this: WorkingCsvStore,
    workingCsvId: WorkingCsvId,
  ): Effect.fn.Return<void, DataEngineError> {
    while (true) {
      const state = this.workingCsvs.get(workingCsvId);
      if (!state) return;

      yield* this.awaitLeases(workingCsvId);
      if (this.workingCsvs.get(workingCsvId)?.tableName !== state.tableName) continue;
      yield* this.dropRetiredSourceTablesOwnedBy(workingCsvId);
      yield* this.retireSourceTable(state.tableName).pipe(
        Effect.onError(() => Effect.sync(() => this.rollbackSourceRetirement(state.tableName))),
      );
      if (this.workingCsvs.get(workingCsvId)?.tableName !== state.tableName) continue;
      this.workingCsvs.delete(workingCsvId);
      this.closingWorkingCsvs.delete(workingCsvId);
      this.host.releaseSource(state.sourceId);
      return;
    }
  }, (effect) => observeStage('csv.release-working-csv', effect));

  /**
   * Waits for admitted work, releases every table, then retries failed export worker releases even
   * if a table release failed. A failed retry is reported as cleanup failure. The runtime releases
   * the database afterward.
   */
  readonly disposeStore = Effect.fnUntraced(function* (
    this: WorkingCsvStore,
  ): Effect.fn.Return<void, DataEngineError> {
    this.beginDisposal();
    const tableRelease = yield* Effect.exit(this.releaseAllTables());
    const workerReleases = yield* Effect.forEach([...this.unreleasedExportWorkers], (worker) => Effect.exit(this.releaseExportWorker(worker)));
    yield* Exit.asVoidAll([tableRelease, ...workerReleases]);
  }, Effect.ensuring(Effect.sync(() => { this.lifecycle = 'disposed'; })), Effect.uninterruptible);

  /** For a stopped engine, forget browser-held sources without issuing table queries. */
  releaseSourcesAfterEngineStop(): void {
    for (const state of this.workingCsvs.values()) this.host.releaseSource(state.sourceId);
    this.workingCsvs.clear();
    this.lifecycle = 'disposed';
  }

  private readonly releaseAllTables = Effect.fnUntraced(function* (
    this: WorkingCsvStore,
  ): Effect.fn.Return<void, DataEngineError> {
    yield* observeStage('workspace.await-work', this.workSettled.await);
    for (const workingCsvId of this.workingCsvs.keys()) this.beginClose(workingCsvId);
    // Every close waits for its Working CSV's leases, so attempt each one even after a failure.
    const closes = yield* Effect.forEach([...this.workingCsvs.keys()], (workingCsvId) => Effect.exit(this.closeWorkingCsv(workingCsvId)));
    yield* Exit.asVoidAll(closes);
    if (this.tableLeases.size > 0) {
      throw new Error('Working CSV source lease invariant violated during disposal.');
    }
    for (const { tableName } of this.retiredSourceTables()) {
      yield* this.dropRetiredSourceTable(tableName);
    }
    for (const artifact of this.artifactRegistry.list()) {
      if (artifact.owner.kind === 'working-csv' && artifact.role === 'staging') {
        yield* dropWorkingCsvTable(this.table(artifact.tableName));
        this.artifactRegistry.remove(artifact.tableName);
      }
    }
    this.artifactRegistry.assertEmpty();
  });

  hasUnexportedChanges(workingCsvId: WorkingCsvId): boolean {
    const state = this.workingCsvs.get(workingCsvId);
    return state ? state.history.hasUnexportedChanges : false;
  }

  readonly getEditState = Effect.fnUntraced(function* (
    this: WorkingCsvStore,
    request: CsvEditStateRequest,
  ): Effect.fn.Return<CsvEditState, WorkspaceRequestError> {
    yield* this.assertAcceptingWork();
    yield* this.assertNotClosing(request.workingCsvId);
    return buildEditState(yield* this.requireWorkingCsv(request.workingCsvId));
  });

  getRows(request: CsvRowWindowRequest): Effect.Effect<CsvRowWindow, WorkingCsvOperationError> {
    return this.read(request.workingCsvId, (state) => Effect.gen({ self: this }, function* () {
      const { offset, limit } = request;
      if (limit > maxRowWindowLimit) {
        return yield* Effect.fail(new WorkspaceRequestError({ message: `Row window limit must be ${maxRowWindowLimit} or less.` }));
      }

      const query = yield* Effect.fromResult(buildRowsQuery({
        tableName: state.tableName,
        columns: state.metadata.columns,
        filters: request.filters ?? [],
        search: request.search ?? '',
        sort: request.sort ?? [],
        limit,
        offset,
      }));

      const [countRow] = yield* this.database.readObjects(query.countSql, query.values);
      const rows = yield* this.database.readObjects(query.rowsSql, query.values);

      return {
        workingCsvId: state.metadata.workingCsvId,
        offset,
        filteredRowCount: normalizeCount(countRow.filtered_row_count),
        totalRowCount: state.metadata.rowCount,
        rows: rows.map(normalizeRow),
      };
    }));
  }

  getColumnValues(request: CsvColumnValuesRequest): Effect.Effect<CsvColumnValues, WorkingCsvOperationError> {
    return this.read(request.workingCsvId, (state) => Effect.gen({ self: this }, function* () {
      const query = yield* Effect.fromResult(buildColumnValuesQuery({
        tableName: state.tableName,
        columns: state.metadata.columns,
        column: request.column,
        filters: request.filters ?? [],
        search: request.search ?? '',
        sort: request.sort ?? [],
      }));
      const rows = yield* this.database.readObjects(query.sql, query.values);

      return {
        workingCsvId: state.metadata.workingCsvId,
        column: request.column,
        values: rows.map((row) => normalizeCellValue(row.column_value)),
      };
    }));
  }

  getColumnValueCounts(request: CsvColumnValueCountsRequest): Effect.Effect<CsvColumnValueCounts, WorkingCsvOperationError> {
    return this.read(request.workingCsvId, (state) => Effect.gen({ self: this }, function* () {
      const { metadata } = state;

      const query = yield* Effect.fromResult(buildColumnValueCountsQuery({
        tableName: state.tableName,
        columns: metadata.columns,
        column: request.column,
        filters: request.filters ?? [],
        search: request.search ?? '',
      }));
      const rows = yield* this.database.readObjects(query.sql, query.values);
      const scopeRowCount = rows.length > 0 ? normalizeCount(rows[0].scope_row_count) : 0;

      return {
        workingCsvId: metadata.workingCsvId,
        column: request.column,
        scopeRowCount,
        values: rows.map((row) => ({
          value: normalizeCellValue(row.counted_value),
          count: normalizeCount(row.value_count),
          percentOfScope: Number(row.percent_of_scope),
        })),
      };
    }));
  }

  editCell(request: CsvCellEditRequest): Effect.Effect<CsvCellEditResult, WorkingCsvOperationError> {
    return this.mutate(request.workingCsvId, (state) => Effect.gen({ self: this }, function* () {
      const knownColumns = new Set(state.metadata.columns.map((column) => column.name));
      yield* Effect.fromResult(requireKnownColumn(request.column, knownColumns));

      if (request.rowId.length === 0) {
        return yield* Effect.fail(new WorkspaceRequestError({ message: 'CSV row identifier is required.' }));
      }

      const table = this.tableFor(state);
      const oldValue = yield* readCellValue(table, request.rowId, request.column);
      yield* applyCellValue(table, request.rowId, request.column, request.value);
      state.history.record({
        type: 'cell-edit',
        rowId: request.rowId,
        column: request.column,
        oldValue,
        newValue: request.value,
      });
      commitDataChange(state);

      return {
        rowId: request.rowId,
        column: request.column,
        ...buildEditState(state),
      };
    }));
  }

  deleteRows(request: CsvDeleteRowsRequest): Effect.Effect<CsvEditState, WorkingCsvOperationError> {
    return this.mutate(request.workingCsvId, (state) => Effect.gen({ self: this }, function* () {
      const rowIds = normalizeRowIds(request.rowIds);

      if (rowIds.length === 0) {
        return yield* Effect.fail(new WorkspaceRequestError({ message: 'At least one CSV row must be selected for deletion.' }));
      }

      const table = this.tableFor(state);
      yield* assertRowsExist(table, rowIds);
      yield* applyRowDeletion(table, rowIds, true);
      state.history.record({ type: 'delete-rows', rowIds });
      commitDataChange(state, -rowIds.length);

      return buildEditState(state);
    }));
  }

  insertRow(request: CsvInsertRowRequest): Effect.Effect<CsvEditState, WorkingCsvOperationError> {
    return this.mutate(request.workingCsvId, (state) => Effect.gen({ self: this }, function* () {
      const rowIds = normalizeRowIds(request.rowIds);

      if (request.placement === 'append') {
        if (request.hasActiveQuery) {
          return yield* Effect.fail(new WorkspaceRequestError({ message: 'CSV rows cannot be inserted while sort, filter, or search is active.' }));
        }
        if (rowIds.length !== 0) {
          return yield* Effect.fail(new WorkspaceRequestError({ message: 'Append row requires no selected CSV rows.' }));
        }
      } else if (rowIds.length !== 1) {
        return yield* Effect.fail(new WorkspaceRequestError({ message: 'Insert above or below requires exactly one selected CSV row.' }));
      }

      const insertedRowId = yield* insertEmptyRow(
        this.tableFor(state),
        state.metadata.columns,
        request.placement,
        rowIds[0],
      );
      state.history.record({ type: 'insert-row', rowId: insertedRowId });
      commitDataChange(state, 1);

      return buildEditState(state);
    }));
  }

  renameColumn(request: CsvRenameColumnRequest): Effect.Effect<CsvSchemaEditState, WorkingCsvOperationError> {
    return this.mutate(request.workingCsvId, (state) => Effect.gen({ self: this }, function* () {
      const knownColumns = new Set(state.metadata.columns.map((column) => column.name));
      yield* Effect.fromResult(requireKnownColumn(request.column, knownColumns));

      const name = request.name.trim();
      if (name.length === 0) {
        return yield* Effect.fail(new WorkspaceRequestError({ message: 'CSV column name cannot be blank.' }));
      }
      if (isReservedCsvColumnName(name)) {
        return yield* Effect.fail(new WorkspaceRequestError({ message: 'CSV column name is reserved.' }));
      }
      if (hasConflictingColumnName(state.metadata.columns, name, request.column)) {
        return yield* Effect.fail(new WorkspaceRequestError({ message: 'CSV column name already exists.' }));
      }
      if (name === request.column) {
        return buildSchemaEditState(state);
      }

      return yield* this.commitSchemaEdit(state, { type: 'rename-column', from: request.column, to: name });
    }));
  }

  insertColumn(request: CsvInsertColumnRequest): Effect.Effect<CsvSchemaEditState, WorkingCsvOperationError> {
    return this.mutate(request.workingCsvId, (state) => Effect.gen({ self: this }, function* () {
      const columns = state.metadata.columns;
      const anchorIndex = yield* Effect.fromResult(requireColumnIndex(columns, request.column));
      const index = anchorIndex + (request.placement === 'after' ? 1 : 0);
      const name = defaultColumnName(columns);
      return yield* this.commitSchemaEdit(state, { type: 'insert-column', name, index });
    }));
  }

  deleteColumn(request: CsvDeleteColumnRequest): Effect.Effect<CsvSchemaEditState, WorkingCsvOperationError> {
    return this.mutate(request.workingCsvId, (state) => Effect.gen({ self: this }, function* () {
      const columns = state.metadata.columns;
      const index = yield* Effect.fromResult(requireColumnIndex(columns, request.column));
      if (columns.length <= 1) {
        return yield* Effect.fail(new WorkspaceRequestError({ message: 'The last CSV column cannot be deleted.' }));
      }
      const hiddenName = hiddenCsvColumnName(
        state.history.revisionSequence,
        columns.map((column) => column.name),
      );
      return yield* this.commitSchemaEdit(state, {
        type: 'delete-column',
        name: request.column,
        index,
        columnType: columns[index].type,
        hiddenName,
      });
    }));
  }

  undo(workingCsvId: WorkingCsvId): Effect.Effect<CsvSchemaEditState, WorkingCsvOperationError> {
    return this.stepHistory(workingCsvId, 'undo');
  }

  redo(workingCsvId: WorkingCsvId): Effect.Effect<CsvSchemaEditState, WorkingCsvOperationError> {
    return this.stepHistory(workingCsvId, 'redo');
  }

  private readonly commitSchemaEdit = Effect.fnUntraced(function* (
    this: WorkingCsvStore,
    state: WorkingCsvState,
    draft: CsvSchemaEditDraft,
  ): Effect.fn.Return<CsvSchemaEditState, WorkingCsvOperationError> {
    const next = yield* Effect.fromResult(columnsAfter(state.metadata.columns, draft, 'redo'));
    yield* runEditCommand(this.tableFor(state), draft, 'redo');
    state.history.record(draft);
    state.metadata.columns = next;
    commitDataChange(state, 0);
    return buildSchemaEditState(state);
  });

  private stepHistory(workingCsvId: WorkingCsvId, direction: 'undo' | 'redo'): Effect.Effect<CsvSchemaEditState, WorkingCsvOperationError> {
    return this.mutate(workingCsvId, (state) => Effect.gen({ self: this }, function* () {
      const { command, commit } = yield* Effect.fromResult(state.history.step(direction));
      const next = yield* Effect.fromResult(columnsAfter(state.metadata.columns, command, direction));
      yield* runEditCommand(this.tableFor(state), command, direction);
      state.metadata.columns = next;
      commit();
      commitDataChange(state, rowCountDelta(command, direction));
      return buildSchemaEditState(state);
    }));
  }

  /**
   * Serializes the Working CSV, hands it to the runtime for delivery, then records the delivered
   * revision as exported. Delivery can involve the user, so it runs outside the Working CSV lease -
   * holding one across a prompt would block closing the Working CSV and disposing the workspace.
   * The Working CSV can therefore be closed or replaced while the prompt is open, and a delivered
   * export never fails afterwards: the exported revision is only recorded against the history it
   * was serialized from. A failed worker release rejects the export before delivery, and the store
   * keeps that worker for disposal to retry.
   */
  readonly exportCsv = Effect.fnUntraced(function* (
    this: WorkingCsvStore,
    workingCsvId: WorkingCsvId,
  ): Effect.fn.Return<CsvExportOutcome, WorkingCsvOperationError | CsvSourceUnavailableError> {
    let releaseFailure: DataEngineError | undefined;
    const prepared = yield* this.read(workingCsvId, (state) => Effect.gen({ self: this }, function* () {
      const { metadata } = state;
      const connection = yield* Effect.acquireRelease(
        this.database.connectWorker(),
        // Finalizers cannot return typed failures; report one after the scope closes.
        (worker) => this.releaseExportWorker(worker).pipe(Effect.catch((error) => Effect.sync(() => {
          releaseFailure = error;
        }))),
      );
      const rows = yield* readExportRows(connection, state.tableName, metadata.columns);
      return {
        state,
        sourceId: state.sourceId,
        suggestedName: metadata.source.name,
        revisionId: state.history.currentRevision,
        contents: serializeCsvExport({
          columns: metadata.columns,
          rows,
          delimiter: metadata.dialect.delimiter ?? state.defaultDelimiter,
          header: metadata.dialect.header !== false,
        }),
      };
    }));
    if (releaseFailure) return yield* Effect.fail(releaseFailure);

    const delivery = yield* observeStage('csv.deliver-export', this.host.deliverExport({
      sourceId: prepared.sourceId,
      suggestedName: prepared.suggestedName,
      contents: prepared.contents,
    }));
    if (delivery.status === 'cancelled') return { status: 'cancelled' } satisfies CsvExportOutcome;

    const state = this.workingCsvs.get(workingCsvId) ?? prepared.state;
    if (state.history === prepared.state.history) state.history.markExported(prepared.revisionId);
    return { status: 'exported', editState: buildEditState(state) } satisfies CsvExportOutcome;
  }, (effect, workingCsvId) => this.withExportSlot(workingCsvId, effect));

  /** Captures a queued read, then prepares cancellable bytes independently of subsequent edits. */
  readonly exportView = Effect.fnUntraced(function* (
    this: WorkingCsvStore,
    request: CsvViewExportRequest,
  ): Effect.fn.Return<CsvViewExportOutcome, WorkingCsvOperationError | CsvSourceUnavailableError> {
    const operation = { operationId: request.operationId, cancel: Deferred.makeUnsafe<void>(), preparing: true };
    this.viewExports.set(request.workingCsvId, operation);
    let releaseFailure: DataEngineError | undefined;
    const preparation = Effect.gen({ self: this }, function* () {
      const snapshot = yield* this.inTurn(request.workingCsvId, (state) => Effect.gen({ self: this }, function* () {
        const { metadata } = state;
        const query = yield* Effect.fromResult(buildViewExportQuery({
          tableName: state.tableName, columns: metadata.columns,
          sort: request.sort ?? [], filters: request.filters ?? [], search: request.search ?? '',
        }));
        const connection = yield* Effect.acquireRelease(this.database.connectWorker(), (worker) =>
          this.releaseExportWorker(worker).pipe(Effect.catch((error) => Effect.sync(() => { releaseFailure = error; }))),
        );
        const rows = yield* connection.readObjectsCancellable(query.sql, query.values);
        return {
          sourceId: state.sourceId,
          suggestedName: metadata.source.name.replace(/(\.[^.]+)$/, '-view$1'),
          columns: metadata.columns.map((column) => ({ ...column })), rows,
          delimiter: metadata.dialect.delimiter ?? state.defaultDelimiter, header: metadata.dialect.header !== false,
        };
        }).pipe(Effect.scoped));
      const contents = yield* serializeCsvViewExport(snapshot);
      return { sourceId: snapshot.sourceId, suggestedName: snapshot.suggestedName, rowCount: snapshot.rows.length, contents };
    });
    const result = yield* Effect.exit(Effect.raceFirst(preparation,
      Deferred.await(operation.cancel).pipe(Effect.andThen(Effect.interrupt)),
    ));
    if (releaseFailure) {
      const cleanup = Cause.fail(releaseFailure);
      return yield* Effect.failCause(Exit.isFailure(result) && !Cause.hasInterruptsOnly(result.cause)
        ? Cause.combine(result.cause, cleanup) : cleanup);
    }
    if (Exit.isFailure(result)) {
      if (Cause.hasInterruptsOnly(result.cause)) return { status: 'cancelled' } satisfies CsvViewExportOutcome;
      return yield* Effect.failCause(result.cause);
    }
    if (Deferred.isDoneUnsafe(operation.cancel)) return { status: 'cancelled' } satisfies CsvViewExportOutcome;
    const prepared = result.value;
    if (prepared.rowCount === 0) return { status: 'empty' } satisfies CsvViewExportOutcome;
    operation.preparing = false;
    yield* Effect.forEach([...this.viewExportListeners], (listener) => Effect.sync(() => listener({
      workingCsvId: request.workingCsvId, operationId: request.operationId, phase: 'delivering',
    })).pipe(Effect.catchCause((cause) => reportFailure('csv.notify-export', cause))), { discard: true });
    const delivery = yield* observeStage('csv.deliver-view-export', this.host.deliverExport({ ...prepared, kind: 'view' }));
    return delivery.status === 'cancelled'
      ? { status: 'cancelled' } satisfies CsvViewExportOutcome
      : { status: 'exported', rowCount: prepared.rowCount } satisfies CsvViewExportOutcome;
  }, (effect, request) => this.withExportSlot(request.workingCsvId, effect.pipe(
    Effect.ensuring(Effect.sync(() => { this.viewExports.delete(request.workingCsvId); })),
  )));

  cancelViewExport(request: CancelViewExportRequest): Effect.Effect<CancelViewExportOutcome> {
    return Effect.sync(() => {
      const operation = this.viewExports.get(request.workingCsvId);
      if (!operation?.preparing) return { status: 'already-finished' };
      if (operation.operationId !== request.operationId) return { status: 'operation-mismatch' };
      this.cancelPreparation(request.workingCsvId);
      return { status: 'requested' };
    });
  }

  subscribeToViewExports(listener: (event: CsvViewExportEvent) => void): () => void {
    this.viewExportListeners.add(listener);
    return () => { this.viewExportListeners.delete(listener); };
  }

  private cancelPreparation(workingCsvId: WorkingCsvId): void {
    const operation = this.viewExports.get(workingCsvId);
    if (operation?.preparing) Deferred.doneUnsafe(operation.cancel, Effect.void);
  }

  private withExportSlot<A, E>(workingCsvId: WorkingCsvId, operation: Effect.Effect<A, E>): Effect.Effect<A, E | WorkspaceRequestError> {
    return Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (this.busyExports.has(workingCsvId)) return Effect.fail(new WorkspaceRequestError({ message: 'An export is already in progress for this CSV.' }));
        this.busyExports.add(workingCsvId);
        return Effect.void;
      }),
      () => operation,
      () => Effect.sync(() => { this.busyExports.delete(workingCsvId); }),
    );
  }

  /** A failed close is reported as cleanup failure and keeps the worker owned by the store, so disposal can retry it. */
  private releaseExportWorker(worker: WorkspaceDatabaseConnection): Effect.Effect<void, DataEngineError> {
    return worker.close().pipe(
      Effect.onExit((exit) => Effect.sync(() => {
        if (Exit.isSuccess(exit)) this.unreleasedExportWorkers.delete(worker);
        else this.unreleasedExportWorkers.add(worker);
      })),
      Effect.tapError(() => markCleanupFailed),
    );
  }

  private readonly createWorkingCsv = Effect.fnUntraced(function* (
    this: WorkingCsvStore,
    sourceId: CsvSourceId,
    options: CsvDialectOptions,
    logicalWorkingCsvId: WorkingCsvId,
    dataRevision: number,
    initialRevisionId: number,
  ): Effect.fn.Return<WorkingCsvState, CsvOpenError, Scope.Scope> {
    const dialect = yield* Effect.fromResult(validateDialectOptions(options));
    const description = yield* observeStage('csv.describe-source', this.host.describeSource(sourceId).pipe(Effect.mapError(normalizeOpenError)));
    if (!isSupportedCsvSourceName(description.name)) {
      return yield* Effect.fail(new CsvOpenError('Unsupported file type. Choose a CSV, TSV, or text file.', 'source-access'));
    }
    yield* observeStage('csv.prepare-table', this.database.ownerConnection().pipe(Effect.mapError(normalizeEngineError)));
    const tableName = buildWorkingCsvTableName(crypto.randomUUID());
    const table = this.table(tableName);
    yield* Effect.acquireRelease(
      Effect.sync(() => this.artifactRegistry.register({
        tableName, owner: { kind: 'working-csv', workingCsvId: logicalWorkingCsvId }, role: 'staging',
      })),
      () => this.releaseStagingTable(tableName),
    );
    yield* observeStage('csv.access-and-load', this.host.acquireEngineSource(sourceId).pipe(
      Effect.flatMap((reference) => createWorkingCsvTable(table, reference, dialect)),
      Effect.scoped,
      Effect.mapError(normalizeEngineError),
    ));
    const [columns, rowCount] = yield* observeStage('csv.read-metadata', Effect.all([
      readColumns(table).pipe(Effect.mapError(normalizeEngineError)),
      readRowCount(table).pipe(Effect.mapError(normalizeEngineError)),
    ]));
    return {
      metadata: {
        workingCsvId: logicalWorkingCsvId, dataRevision,
        source: { sourceId, name: description.name, location: description.location, sizeBytes: description.sizeBytes },
        columns, rowCount, dialect,
      },
      tableName, sourceId, defaultDelimiter: description.defaultDelimiter,
      history: new CsvEditHistory(initialRevisionId),
    } satisfies WorkingCsvState;
  });

  private readonly releaseStagingTable = Effect.fnUntraced(function* (
    this: WorkingCsvStore,
    tableName: string,
  ): Effect.fn.Return<void, DataEngineError> {
    if (this.artifactRegistry.get(tableName)?.role !== 'staging') return;
    yield* dropWorkingCsvTable(this.table(tableName));
    this.artifactRegistry.remove(tableName);
  }, (effect) => observeCleanup('csv.release-staging', effect));

  private table(tableName: string): CsvTable {
    return { database: this.database, tableName };
  }

  private tableFor(state: WorkingCsvState): CsvTable {
    return this.table(state.tableName);
  }

  /** Reads hold a lease without joining the mutation queue. */
  private read<A, E>(workingCsvId: WorkingCsvId, operation: (state: WorkingCsvState) => Effect.Effect<A, E, Scope.Scope>): Effect.Effect<A, E | WorkspaceRequestError> {
    return Effect.scoped(this.lease(workingCsvId).pipe(Effect.flatMap(operation)));
  }

  /**
   * Runs one mutation at a time per Working CSV, in call order. A lease keeps a table alive across
   * an await but does not exclude anything, and every mutation reads engine or history state before
   * it writes: two inserts would read the same next row identifier, and two undos would replay and
   * pop the same command twice.
   *
   * The lease and the queue position are both taken when the request starts, so a close
   * waits for queued work. The operation receives the state current when its turn begins, so work
   * queued behind a reopen runs against the replacement, under a second lease on its table.
   * Dependents are notified once the operation advances the data revision.
   */
  private mutate<A, E>(workingCsvId: WorkingCsvId, operation: (state: WorkingCsvState) => Effect.Effect<A, E>): Effect.Effect<A, E | WorkspaceRequestError> {
    return this.inTurn(workingCsvId, operation).pipe(Effect.uninterruptible);
  }

  private readonly inTurn = Effect.fnUntraced(function* <A, E>(
    this: WorkingCsvStore,
    workingCsvId: WorkingCsvId,
    operation: (state: WorkingCsvState) => Effect.Effect<A, E>,
  ): Effect.fn.Return<A, E | WorkspaceRequestError, Scope.Scope> {
    const leased = yield* this.lease(workingCsvId);
    yield* this.awaitTurn(workingCsvId);
    const current = yield* this.requireWorkingCsv(workingCsvId);
    if (current.tableName !== leased.tableName) yield* this.leaseTable(current);
    const revision = current.metadata.dataRevision;
    const result = yield* operation(current);
    if (this.workingCsvs.get(workingCsvId)?.metadata.dataRevision !== revision) {
      yield* this.notifyDataChange(workingCsvId);
    }
    return result;
  }, Effect.scoped);

  /**
   * Reserves the Working CSV's next mutation turn immediately, then waits for the turns reserved
   * before it. The turn passes on when the scope closes.
   */
  private awaitTurn(workingCsvId: WorkingCsvId): Effect.Effect<void, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => {
        const previous = this.mutationTails.get(workingCsvId);
        const turn = Deferred.makeUnsafe<void>();
        this.mutationTails.set(workingCsvId, turn);
        return { previous, turn };
      }),
      ({ previous, turn }) => (previous ? Deferred.await(previous) : Effect.void).pipe(Effect.andThen(Effect.sync(() => {
        if (this.mutationTails.get(workingCsvId) === turn) this.mutationTails.delete(workingCsvId);
      })), Effect.andThen(Deferred.succeed(turn, undefined))),
    ).pipe(Effect.flatMap(({ previous }) => observeStage('csv.queue-wait', previous ? Deferred.await(previous) : Effect.void)));
  }

  /**
   * The one lease primitive for reads, export serialization, mutations, reopen, and Comparison
   * sources. It leases the Working CSV's current table until the scope closes, and rejects work
   * while the workspace disposes or the Working CSV closes.
   */
  private readonly lease = Effect.fnUntraced(function* (
    this: WorkingCsvStore,
    workingCsvId: WorkingCsvId,
  ): Effect.fn.Return<WorkingCsvState, WorkspaceRequestError, Scope.Scope> {
    yield* this.assertAcceptingWork();
    yield* this.assertNotClosing(workingCsvId);
    return yield* this.leaseTable(yield* this.requireWorkingCsv(workingCsvId));
  });

  private leaseTable(state: WorkingCsvState): Effect.Effect<WorkingCsvState, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => {
        const lease = this.tableLeases.get(state.tableName) ?? { count: 0, released: Deferred.makeUnsafe<void>() };
        lease.count += 1;
        this.tableLeases.set(state.tableName, lease);
        return state;
      }),
      () => this.releaseTable(state.tableName),
    );
  }

  /** The last release of a retired table drops it. */
  private releaseTable(tableName: string): Effect.Effect<void> {
    return observeStage('csv.release-lease', Effect.suspend(() => {
      const lease = this.tableLeases.get(tableName);
      if (!lease) return Effect.die(new Error('Working CSV source lease invariant violated.'));
      lease.count -= 1;
      if (lease.count > 0) return Effect.void;
      this.tableLeases.delete(tableName);
      const drop = this.artifactRegistry.get(tableName)?.role === 'retired' ? this.dropRetiredLeaseTable(tableName) : Effect.void;
      return drop.pipe(Effect.ensuring(Deferred.succeed(lease.released, undefined)));
    }));
  }

  /** A failed drop keeps the table registered, so close or disposal can retry it. */
  private dropRetiredLeaseTable(tableName: string): Effect.Effect<void> {
    return observeCleanup('csv.release-retired', this.dropRetiredSourceTable(tableName));
  }

  /**
   * Waits until no lease holds any table of the Working CSV. Retired tables count too: a reader
   * admitted before a reopen, or a mutation queued behind it, still leases the retired table.
   */
  private readonly awaitLeases = Effect.fnUntraced(function* (
    this: WorkingCsvStore,
    workingCsvId: WorkingCsvId,
  ): Effect.fn.Return<void> {
    while (true) {
      const current = this.workingCsvs.get(workingCsvId)?.tableName;
      const owned = this.retiredSourceTables().filter((retired) => retired.workingCsvId === workingCsvId).map((retired) => retired.tableName);
      const lease = [current, ...owned].flatMap((tableName) => tableName ? this.tableLeases.get(tableName) ?? [] : [])[0];
      if (!lease) return;
      yield* Deferred.await(lease.released);
    }
  });

  private readonly retireSourceTable = Effect.fnUntraced(function* (
    this: WorkingCsvStore,
    tableName: string,
  ): Effect.fn.Return<void, DataEngineError> {
    this.artifactRegistry.transition(tableName, 'retired');
    if (!this.tableLeases.has(tableName)) yield* this.dropRetiredSourceTable(tableName);
  });

  private rollbackSourceRetirement(tableName: string): void {
    if (this.artifactRegistry.get(tableName)?.role === 'retired') {
      this.artifactRegistry.transition(tableName, 'current');
    }
  }

  /** Comparison artifacts are retired by the executor, never through this path. */
  private retiredSourceTables(): { tableName: string; workingCsvId: WorkingCsvId }[] {
    return this.artifactRegistry.list().flatMap((artifact) =>
      artifact.role === 'retired' && artifact.owner.kind === 'working-csv'
        ? [{ tableName: artifact.tableName, workingCsvId: artifact.owner.workingCsvId }]
        : [],
    );
  }

  private dropRetiredSourceTablesOwnedBy(workingCsvId: WorkingCsvId) {
    return Effect.forEach(this.retiredSourceTables().filter((retired) => retired.workingCsvId === workingCsvId),
      (retired) => this.dropRetiredSourceTable(retired.tableName), { discard: true });
  }

  private dropRetiredSourceTable(tableName: string) {
    return dropWorkingCsvTable(this.table(tableName)).pipe(
      Effect.tap(() => Effect.sync(() => this.artifactRegistry.remove(tableName))),
    );
  }

  private requireWorkingCsv(workingCsvId: WorkingCsvId): Effect.Effect<WorkingCsvState, WorkspaceRequestError> {
    return Effect.suspend(() => {
      const state = this.workingCsvs.get(workingCsvId);
      return state ? Effect.succeed(state) : Effect.fail(new WorkspaceRequestError({ message: 'Working CSV is no longer active.' }));
    });
  }

  private assertNotClosing(workingCsvId: WorkingCsvId): Effect.Effect<void, WorkspaceRequestError> {
    return Effect.suspend(() => this.closingWorkingCsvs.has(workingCsvId)
      ? Effect.fail(new WorkspaceRequestError({ message: 'Working CSV is closing.' })) : Effect.void);
  }

  private assertAcceptingWork(): Effect.Effect<void, WorkspaceRequestError> {
    return Effect.suspend(() => this.lifecycle !== 'active'
      ? Effect.fail(new WorkspaceRequestError({ message: 'CSV workspace is disposing.' })) : Effect.void);
  }

  /** One failing listener cannot suppress later listeners or fail the committed change. */
  private notifyDataChange(workingCsvId: WorkingCsvId): Effect.Effect<void> {
    return Effect.forEach([...this.dataChangeListeners], (listener) =>
      Effect.sync(() => listener(workingCsvId)).pipe(
        Effect.catchCause((cause) => reportFailure('csv.notify-data-change', cause)),
      ), { discard: true });
  }
}

function commitDataChange(state: WorkingCsvState, rowCountDelta = 0): void {
  state.metadata = {
    ...state.metadata,
    dataRevision: state.metadata.dataRevision + 1,
    rowCount: state.metadata.rowCount + rowCountDelta,
  };
}

function unavailable(message: string): ReplaceWorkingCsvOutcome {
  return { status: 'failed', failure: { code: 'replace-failed', message, retryable: true } };
}

function recordOpenFailure(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause);
  return recordOutcome('failed', cause).pipe(
    Effect.andThen(error instanceof CsvOpenError ? Effect.annotateCurrentSpan('csvFailureCategory', error.category) : Effect.void),
  );
}

function buildEditState(state: WorkingCsvState): CsvEditState {
  return {
    workingCsvId: state.metadata.workingCsvId,
    hasUnexportedChanges: state.history.hasUnexportedChanges,
    canUndo: state.history.canUndo,
    canRedo: state.history.canRedo,
  };
}

function buildSchemaEditState(state: WorkingCsvState): CsvSchemaEditState {
  return {
    ...buildEditState(state),
    columns: state.metadata.columns.map((column) => ({ ...column })),
  };
}

type CsvSchemaEditDraft = Extract<
  CsvEditDraft,
  { type: 'rename-column' | 'insert-column' | 'delete-column' }
>;

function isReservedCsvColumnName(name: string): boolean {
  const needle = name.toLowerCase();
  return (
    needle === csvInternalRowIdField.toLowerCase() ||
    needle === csvSourceOrderField.toLowerCase() ||
    needle === csvDeletedField.toLowerCase() ||
    needle.startsWith(csvHiddenColumnPrefix.toLowerCase())
  );
}

function defaultColumnName(columns: readonly { name: string }[]): string {
  const taken = new Set(columns.map((column) => column.name.toLowerCase()));
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? 'New column' : `New column ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function requireColumnIndex(columns: readonly { name: string }[], name: string): Result.Result<number, WorkspaceRequestError> {
  const index = columns.findIndex((column) => column.name === name);
  if (index < 0) return Result.fail(new WorkspaceRequestError({ message: `Unknown CSV column: ${name}` }));
  return Result.succeed(index);
}

function hasConflictingColumnName(
  columns: WorkingCsvState['metadata']['columns'],
  name: string,
  except: string,
): boolean {
  const needle = name.toLowerCase();
  return columns.some((column) => column.name !== except && column.name.toLowerCase() === needle);
}

function buildWorkingCsvView(state: WorkingCsvState): WorkingCsvView {
  return {
    ...state.metadata,
    columns: state.metadata.columns.map((column) => ({ ...column })),
    source: { ...state.metadata.source },
    dialect: { ...state.metadata.dialect },
    editState: buildEditState(state),
  };
}

function validateDialectOptions(options: CsvDialectOptions): Result.Result<CsvDialectOptions, CsvOpenError> {
  const dialect: Types.Mutable<CsvDialectOptions> = {};

  if (options.delimiter !== undefined && options.delimiter !== '') {
    if (options.delimiter.length !== 1) {
      return Result.fail(new CsvOpenError('Delimiter must be exactly one character.', 'dialect'));
    }

    dialect.delimiter = options.delimiter;
  }

  if (options.header !== undefined) {
    dialect.header = options.header;
  }

  return Result.succeed(dialect);
}

function isSupportedCsvSourceName(name: string): boolean {
  const lowerCaseName = name.toLowerCase();
  return supportedCsvFileExtensions.some((extension) => lowerCaseName.endsWith(`.${extension}`));
}

function buildWorkingCsvTableName(physicalTableId: string): string {
  return `${workingCsvTablePrefix}${physicalTableId.replaceAll('-', '_')}`;
}

/** A CSV Source error with product guidance and a diagnostic category. */
class CsvOpenError extends WorkspaceRequestError {
  constructor(message: string, readonly category: 'source-access' | 'dialect' | 'engine') {
    super({ message });
    this.name = 'CsvOpenError';
  }
}

function isDeclaredOpenFailure(cause: Cause.Cause<unknown>): boolean {
  return cause.reasons.length === 1 && cause.reasons[0]._tag === 'Fail' && cause.reasons[0].error instanceof CsvOpenError;
}

function normalizeRowIds(rowIds: readonly string[]): string[] {
  const normalizedRowIds = rowIds.map((rowId) => rowId.trim()).filter((rowId) => rowId.length > 0);
  return [...new Set(normalizedRowIds)];
}

function workingCsvFailure(code: WorkingCsvFailure['code'], cause: unknown): WorkingCsvFailure {
  return {
    code,
    message: cause instanceof CsvOpenError ? cause.message : 'Unable to open CSV.',
    retryable: true,
  };
}

function normalizeOpenError(cause: WorkspaceRequestError | CsvSourceUnavailableError): CsvOpenError {
  if (cause instanceof CsvOpenError) return cause;

  if (cause instanceof CsvSourceUnavailableError) {
    if (cause.code === 'missing-source') {
      return new CsvOpenError('Unable to open CSV: the file no longer exists.', 'source-access');
    }
    if (cause.code === 'permission-denied') {
      return new CsvOpenError('Unable to open CSV: permission was denied for this file.', 'source-access');
    }
    return new CsvOpenError('Unable to open CSV: the file could not be read.', 'source-access');
  }

  return new CsvOpenError('Unable to open CSV.', 'source-access');
}

/** Keep driver details out of product messages and diagnostics. */
function normalizeEngineError(cause: WorkspaceRequestError | DataEngineError | CsvSourceUnavailableError): CsvOpenError {
  if (cause instanceof CsvOpenError || cause instanceof CsvSourceUnavailableError) {
    return normalizeOpenError(cause);
  }
  return new CsvOpenError('Unable to read CSV: check the delimiter, quote, and header options for this file.', 'engine');
}
