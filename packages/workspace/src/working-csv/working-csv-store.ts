import { DataEngineError } from '../database';
import { Cause, Deferred, Effect, Exit, Latch, type Scope } from 'effect';
import { markCleanupFailed, observeStage, recordOutcome, reportFailure } from '../workspace-diagnostics';
import { databaseEffect } from '../comparison/comparison-effects';
import { toError } from '../errors';
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
import type { ComparisonExecutor } from '../comparison/comparison-executor';
import type { WorkspaceDatabase } from '../database';
import { CsvEditHistory, rowCountDelta, type CsvEditCommand, type CsvEditDraft } from './csv-edit-history';
import { serializeCsvExport } from './csv-export-serialization';
import {
  assertKnownColumn,
  buildColumnValueCountsQuery,
  buildColumnValuesQuery,
  buildRowsQuery,
  maxRowWindowLimit,
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
import { CsvSourceUnavailableError, type CsvWorkspaceHost } from '../workspace-host';
import { WorkspaceArtifactRegistry } from '../workspace-artifact-registry';

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

export class WorkingCsvStore {
  private readonly artifactRegistry = new WorkspaceArtifactRegistry();
  private workingCsvs = new Map<string, WorkingCsvState>();
  private dataChangeListeners = new Set<(workingCsvId: WorkingCsvId) => void>();
  private closingWorkingCsvs = new Set<string>();
  /** Leases per physical table. `released` completes when the last lease is returned. */
  private tableLeases = new Map<string, TableLease>();
  /** The most recently reserved mutation turn of each Working CSV. */
  private mutationTails = new Map<WorkingCsvId, Deferred.Deferred<void>>();
  private admittedWork = 0;
  /** Open while no admitted open, reopen, or worker connection is running. */
  private readonly workSettled = Latch.makeUnsafe(true);
  private comparisonExecutor: ComparisonExecutor | null = null;
  private lifecycle: 'active' | 'disposing' | 'disposed' = 'active';

  constructor(
    private readonly host: CsvWorkspaceHost,
    private readonly database: WorkspaceDatabase,
  ) {}

  beginDisposal(): void {
    if (this.lifecycle === 'active') this.lifecycle = 'disposing';
  }

  /**
   * Admits work that disposal must wait for until the scope closes: opens, reopens, and Comparison
   * worker connections. Returns false once disposal begins.
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

  /** Opens a CSV Source. The caller holds an admission from `admit` for the whole request. */
  open(sourceId: CsvSourceId, options: CsvDialectOptions = {}): Effect.Effect<OpenWorkingCsvOutcome> {
    return Effect.gen({ self: this }, function* () {
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
        Effect.catchCause((cause) => recordOpenFailure(cause).pipe(
          Effect.as({ status: 'failed', failure: workingCsvFailure('open-failed', Cause.squash(cause)) } satisfies OpenWorkingCsvOutcome),
        )),
      );
    }).pipe(Effect.uninterruptible);
  }

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
    if (!this.comparisonExecutor) {
      this.comparisonExecutor = new DuckDbComparisonExecutor(
        {
          acquireSource: (workingCsvId) => this.lease(workingCsvId).pipe(
            Effect.map((state) => ({
              tableName: state.tableName,
              columns: state.metadata.columns.map((column) => ({ ...column })),
            })),
            Effect.mapError((error) => new DataEngineError(error)),
          ),
          getOwnerConnection: () => this.database.ownerConnection(),
          connectWorker: () => Effect.scoped(Effect.gen({ self: this }, function* () {
            if (!(yield* this.admit())) return yield* Effect.fail(new DataEngineError(new Error('CSV workspace is disposing.')));
            return yield* databaseEffect(() => this.database.connectWorker());
          })),
        },
        this.artifactRegistry,
      );
    }
    return this.comparisonExecutor;
  }

  /**
   * Replaces the Working CSV's table with a freshly parsed one. The replacement is admitted work and
   * a mutation, so it runs in order with edits and replaces the state current when its turn begins.
   */
  replace(
    workingCsvId: WorkingCsvId,
    expectedDataRevision: number,
    options: CsvDialectOptions = {},
  ): Effect.Effect<ReplaceWorkingCsvOutcome> {
    return Effect.gen({ self: this }, function* () {
      if (!(yield* this.admit())) return unavailable('The CSV workspace is closing.');
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
        Effect.catchCause((cause) => recordOpenFailure(cause).pipe(
          Effect.as({ status: 'failed', failure: workingCsvFailure('replace-failed', Cause.squash(cause)) } satisfies ReplaceWorkingCsvOutcome),
        )),
      )).pipe(Effect.catch(() => Effect.succeed(unavailable('This CSV is closing.'))));
    }).pipe(Effect.scoped, Effect.uninterruptible);
  }

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

  closeWorkingCsv(workingCsvId: WorkingCsvId): Effect.Effect<void, Error> {
    return observeStage('csv.release-working-csv', Effect.gen({ self: this }, function* () {
      while (true) {
        const state = this.workingCsvs.get(workingCsvId);
        if (!state) return;

        yield* this.awaitLeases(workingCsvId);
        if (this.workingCsvs.get(workingCsvId)?.tableName !== state.tableName) continue;
        yield* attempt(async () => {
          await this.dropRetiredSourceTablesOwnedBy(workingCsvId);
          try {
            await this.retireSourceTable(state.tableName);
          } catch (error) {
            this.rollbackSourceRetirement(state.tableName);
            throw error;
          }
        });
        if (this.workingCsvs.get(workingCsvId)?.tableName !== state.tableName) continue;
        this.workingCsvs.delete(workingCsvId);
        this.closingWorkingCsvs.delete(workingCsvId);
        this.host.releaseSource(state.sourceId);
        return;
      }
    }));
  }

  /** Waits for admitted work, releases every table, then closes the database even if release failed. */
  disposeStore(): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      this.beginDisposal();
      const released = yield* Effect.exit(this.releaseAllTables());
      const teardownFailures = yield* attempt(() => this.database.close());
      this.lifecycle = 'disposed';

      const failures = Exit.isFailure(released) ? [toError(Cause.squash(released.cause)), ...teardownFailures] : teardownFailures;
      if (failures.length === 1) return yield* Effect.fail(failures[0]);
      if (failures.length > 1) {
        return yield* Effect.fail(new AggregateError(failures, 'Unable to dispose all Working CSV resources.'));
      }
    }).pipe(Effect.uninterruptible);
  }

  private releaseAllTables(): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      yield* observeStage('workspace.await-work', this.workSettled.await);
      for (const workingCsvId of this.workingCsvs.keys()) this.beginClose(workingCsvId);
      for (const workingCsvId of [...this.workingCsvs.keys()]) {
        yield* this.closeWorkingCsv(workingCsvId);
      }
      yield* attempt(async () => {
        if (this.tableLeases.size > 0) {
          throw new Error('Working CSV source lease invariant violated during disposal.');
        }
        for (const { tableName } of this.retiredSourceTables()) {
          await this.dropRetiredSourceTable(tableName);
        }
        for (const artifact of this.artifactRegistry.list()) {
          if (artifact.owner.kind === 'working-csv' && artifact.role === 'staging') {
            await dropWorkingCsvTable(this.table(artifact.tableName));
            this.artifactRegistry.remove(artifact.tableName);
          }
        }
        this.artifactRegistry.assertEmpty();
      });
    });
  }

  hasUnexportedChanges(workingCsvId: WorkingCsvId): boolean {
    const state = this.workingCsvs.get(workingCsvId);
    return state ? state.history.hasUnexportedChanges : false;
  }

  getEditState(request: CsvEditStateRequest): Effect.Effect<CsvEditState, Error> {
    return Effect.try({
      try: () => {
        this.assertAcceptingWork();
        this.assertNotClosing(request.workingCsvId);
        return buildEditState(this.requireWorkingCsv(request.workingCsvId));
      },
      catch: toError,
    });
  }

  getRows(request: CsvRowWindowRequest): Effect.Effect<CsvRowWindow, Error> {
    return this.read(request.workingCsvId, async (state) => {
      const offset = validateWindowInteger(request.offset, 'offset');
      const limit = validateWindowInteger(request.limit, 'limit');

      if (limit > maxRowWindowLimit) {
        throw new Error(`Row window limit must be ${maxRowWindowLimit} or less.`);
      }

      const query = buildRowsQuery({
        tableName: state.tableName,
        columns: state.metadata.columns,
        filters: request.filters ?? [],
        search: request.search ?? '',
        sort: request.sort ?? [],
        limit,
        offset,
      });

      const [countRow] = await this.database.readObjects(query.countSql, query.values);
      const rows = await this.database.readObjects(query.rowsSql, query.values);

      return {
        workingCsvId: state.metadata.workingCsvId,
        offset,
        filteredRowCount: normalizeCount(countRow.filtered_row_count),
        rows: rows.map(normalizeRow),
      };
    });
  }

  getColumnValues(request: CsvColumnValuesRequest): Effect.Effect<CsvColumnValues, Error> {
    return this.read(request.workingCsvId, async (state) => {
      const query = buildColumnValuesQuery({
        tableName: state.tableName,
        columns: state.metadata.columns,
        column: request.column,
        filters: request.filters ?? [],
        search: request.search ?? '',
        sort: request.sort ?? [],
      });
      const rows = await this.database.readObjects(query.sql, query.values);

      return {
        workingCsvId: state.metadata.workingCsvId,
        column: request.column,
        values: rows.map((row) => normalizeCellValue(row.column_value)),
      };
    });
  }

  getColumnValueCounts(request: CsvColumnValueCountsRequest): Effect.Effect<CsvColumnValueCounts, Error> {
    return this.read(request.workingCsvId, async (state) => {
      const { metadata } = state;

      const query = buildColumnValueCountsQuery({
        tableName: state.tableName,
        columns: metadata.columns,
        column: request.column,
        filters: request.filters ?? [],
        search: request.search ?? '',
      });
      const rows = await this.database.readObjects(query.sql, query.values);
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
    });
  }

  editCell(request: CsvCellEditRequest): Effect.Effect<CsvCellEditResult, Error> {
    return this.edit(request.workingCsvId, async (state) => {
      const knownColumns = new Set(state.metadata.columns.map((column) => column.name));
      assertKnownColumn(request.column, knownColumns);

      if (request.rowId.length === 0) {
        throw new Error('CSV row identifier is required.');
      }

      const table = this.tableFor(state);
      const oldValue = await readCellValue(table, request.rowId, request.column);
      await applyCellValue(table, request.rowId, request.column, request.value);
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
    });
  }

  deleteRows(request: CsvDeleteRowsRequest): Effect.Effect<CsvEditState, Error> {
    return this.edit(request.workingCsvId, async (state) => {
      const rowIds = normalizeRowIds(request.rowIds);

      if (rowIds.length === 0) {
        throw new Error('At least one CSV row must be selected for deletion.');
      }

      const table = this.tableFor(state);
      await assertRowsExist(table, rowIds);
      await applyRowDeletion(table, rowIds, true);
      state.history.record({ type: 'delete-rows', rowIds });
      commitDataChange(state, -rowIds.length);

      return buildEditState(state);
    });
  }

  insertRow(request: CsvInsertRowRequest): Effect.Effect<CsvEditState, Error> {
    return this.edit(request.workingCsvId, async (state) => {
      const rowIds = normalizeRowIds(request.rowIds);

      if (request.placement === 'append') {
        if (request.hasActiveQuery) {
          throw new Error('CSV rows cannot be inserted while sort, filter, or search is active.');
        }
        if (rowIds.length !== 0) {
          throw new Error('Append row requires no selected CSV rows.');
        }
      } else if (rowIds.length !== 1) {
        throw new Error('Insert above or below requires exactly one selected CSV row.');
      }

      const insertedRowId = await insertEmptyRow(
        this.tableFor(state),
        state.metadata.columns,
        request.placement,
        rowIds[0],
      );
      state.history.record({ type: 'insert-row', rowId: insertedRowId });
      commitDataChange(state, 1);

      return buildEditState(state);
    });
  }

  renameColumn(request: CsvRenameColumnRequest): Effect.Effect<CsvSchemaEditState, Error> {
    return this.edit(request.workingCsvId, async (state) => {
      const knownColumns = new Set(state.metadata.columns.map((column) => column.name));
      assertKnownColumn(request.column, knownColumns);

      const name = request.name.trim();
      if (name.length === 0) {
        throw new Error('CSV column name cannot be blank.');
      }
      if (isReservedCsvColumnName(name)) {
        throw new Error('CSV column name is reserved.');
      }
      if (hasConflictingColumnName(state.metadata.columns, name, request.column)) {
        throw new Error('CSV column name already exists.');
      }
      if (name === request.column) {
        return buildSchemaEditState(state);
      }

      return this.commitSchemaEdit(state, { type: 'rename-column', from: request.column, to: name });
    });
  }

  insertColumn(request: CsvInsertColumnRequest): Effect.Effect<CsvSchemaEditState, Error> {
    return this.edit(request.workingCsvId, async (state) => {
      const columns = state.metadata.columns;
      const anchorIndex = requireColumnIndex(columns, request.column);
      const index = anchorIndex + (request.placement === 'after' ? 1 : 0);
      const name = defaultColumnName(columns);
      return this.commitSchemaEdit(state, { type: 'insert-column', name, index });
    });
  }

  deleteColumn(request: CsvDeleteColumnRequest): Effect.Effect<CsvSchemaEditState, Error> {
    return this.edit(request.workingCsvId, async (state) => {
      const columns = state.metadata.columns;
      const index = requireColumnIndex(columns, request.column);
      if (columns.length <= 1) {
        throw new Error('The last CSV column cannot be deleted.');
      }
      const hiddenName = hiddenCsvColumnName(
        state.history.revisionSequence,
        columns.map((column) => column.name),
      );
      return this.commitSchemaEdit(state, {
        type: 'delete-column',
        name: request.column,
        index,
        columnType: columns[index].type,
        hiddenName,
      });
    });
  }

  undo(workingCsvId: WorkingCsvId): Effect.Effect<CsvSchemaEditState, Error> {
    return this.stepHistory(workingCsvId, 'undo');
  }

  redo(workingCsvId: WorkingCsvId): Effect.Effect<CsvSchemaEditState, Error> {
    return this.stepHistory(workingCsvId, 'redo');
  }

  private async commitSchemaEdit(state: WorkingCsvState, draft: CsvSchemaEditDraft): Promise<CsvSchemaEditState> {
    const next = columnsAfter(state.metadata.columns, draft, 'redo');
    await runEditCommand(this.tableFor(state), draft, 'redo');
    state.history.record(draft);
    state.metadata.columns = next;
    commitDataChange(state, 0);
    return buildSchemaEditState(state);
  }

  private stepHistory(workingCsvId: WorkingCsvId, direction: 'undo' | 'redo'): Effect.Effect<CsvSchemaEditState, Error> {
    return this.edit(workingCsvId, async (state) => {
      const table = this.tableFor(state);
      const replay = async (entry: CsvEditCommand) => {
        const next = columnsAfter(state.metadata.columns, entry, direction);
        await runEditCommand(table, entry, direction);
        state.metadata.columns = next;
      };
      const command = direction === 'undo' ? await state.history.undo(replay) : await state.history.redo(replay);
      commitDataChange(state, rowCountDelta(command, direction));
      return buildSchemaEditState(state);
    });
  }

  /**
   * Serializes the Working CSV, hands it to the runtime for delivery, then records the delivered
   * revision as exported. Delivery can involve the user, so it runs outside the Working CSV lease -
   * holding one across a prompt would block closing the Working CSV and disposing the workspace.
   * The Working CSV can therefore be closed or replaced while the prompt is open, and a delivered
   * export never fails afterwards: the exported revision is only recorded against the history it
   * was serialized from.
   */
  exportCsv(workingCsvId: WorkingCsvId): Effect.Effect<CsvExportOutcome, Error> {
    return Effect.gen({ self: this }, function* () {
      const prepared = yield* this.read(workingCsvId, async (state) => {
        const { metadata } = state;
        return {
          state,
          sourceId: state.sourceId,
          suggestedName: metadata.source.name,
          revisionId: state.history.currentRevision,
          contents: serializeCsvExport({
            columns: metadata.columns,
            rows: await readExportRows(this.tableFor(state), metadata.columns),
            delimiter: metadata.dialect.delimiter ?? state.defaultDelimiter,
            header: metadata.dialect.header !== false,
          }),
        };
      });

      const delivery = yield* observeStage('csv.deliver-export', attempt(() => this.host.deliverExport({
        sourceId: prepared.sourceId,
        suggestedName: prepared.suggestedName,
        contents: prepared.contents,
      })));
      if (delivery.status === 'cancelled') return { status: 'cancelled' } satisfies CsvExportOutcome;

      const state = this.workingCsvs.get(workingCsvId) ?? prepared.state;
      if (state.history === prepared.state.history) state.history.markExported(prepared.revisionId);
      return { status: 'exported', editState: buildEditState(state) } satisfies CsvExportOutcome;
    });
  }

  private createWorkingCsv(
    sourceId: CsvSourceId,
    options: CsvDialectOptions,
    logicalWorkingCsvId: WorkingCsvId,
    dataRevision: number,
    initialRevisionId: number,
  ) {
    return Effect.gen({ self: this }, function* () {
      const dialect = yield* Effect.try({ try: () => validateDialectOptions(options), catch: normalizeOpenError });
      const description = yield* observeStage('csv.describe-source', Effect.tryPromise({
        try: () => this.host.describeSource(sourceId), catch: normalizeOpenError,
      }));
      if (!isSupportedCsvSourceName(description.name)) {
        return yield* Effect.fail(new CsvOpenError('Unsupported file type. Choose a CSV, TSV, or text file.', 'source-access'));
      }
      yield* observeStage('csv.prepare-table', Effect.tryPromise({
        try: () => this.database.ownerConnection(), catch: normalizeEngineError,
      }));
      const tableName = buildWorkingCsvTableName(crypto.randomUUID());
      const table = this.table(tableName);
      yield* Effect.acquireRelease(
        Effect.sync(() => this.artifactRegistry.register({
          tableName, owner: { kind: 'working-csv', workingCsvId: logicalWorkingCsvId }, role: 'staging',
        })),
        () => this.releaseStagingTable(tableName),
      );
      yield* observeStage('csv.access-and-load', Effect.tryPromise({
        try: () => this.host.withEngineSource(sourceId, (reference) => createWorkingCsvTable(table, reference, dialect)),
        catch: normalizeEngineError,
      }));
      const [columns, rowCount] = yield* observeStage('csv.read-metadata', Effect.all([
        Effect.tryPromise({ try: () => readColumns(table), catch: normalizeEngineError }),
        Effect.tryPromise({ try: () => readRowCount(table), catch: normalizeEngineError }),
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
  }

  private releaseStagingTable(tableName: string) {
    return observeStage('csv.release-staging', Effect.gen({ self: this }, function* () {
      if (this.artifactRegistry.get(tableName)?.role !== 'staging') return;
      const result = yield* Effect.exit(Effect.tryPromise(() => dropWorkingCsvTable(this.table(tableName))));
      if (result._tag === 'Failure') {
        yield* recordOutcome('cleanup-failed', result.cause, 'cleanup-failed');
        yield* markCleanupFailed;
      } else {
        this.artifactRegistry.remove(tableName);
        yield* recordOutcome('succeeded', undefined, 'succeeded');
      }
    }));
  }

  private table(tableName: string): CsvTable {
    return { database: this.database, tableName };
  }

  private tableFor(state: WorkingCsvState): CsvTable {
    return this.table(state.tableName);
  }

  /** Runs promise-based table work under a lease. Reads stay off the mutation queue. */
  private read<A>(workingCsvId: WorkingCsvId, operation: (state: WorkingCsvState) => Promise<A>): Effect.Effect<A, Error> {
    return Effect.scoped(this.lease(workingCsvId).pipe(Effect.flatMap((state) => attempt(() => operation(state)))));
  }

  private edit<A>(workingCsvId: WorkingCsvId, operation: (state: WorkingCsvState) => Promise<A>): Effect.Effect<A, Error> {
    return this.mutate(workingCsvId, (state) => attempt(() => operation(state)));
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
  private mutate<A, E>(
    workingCsvId: WorkingCsvId,
    operation: (state: WorkingCsvState) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | Error> {
    return Effect.gen({ self: this }, function* () {
      const leased = yield* this.lease(workingCsvId);
      yield* this.awaitTurn(workingCsvId);
      const current = yield* Effect.try({ try: () => this.requireWorkingCsv(workingCsvId), catch: toError });
      if (current.tableName !== leased.tableName) yield* this.leaseTable(current);
      const revision = current.metadata.dataRevision;
      const result = yield* operation(current);
      if (this.workingCsvs.get(workingCsvId)?.metadata.dataRevision !== revision) {
        yield* this.notifyDataChange(workingCsvId);
      }
      return result;
    }).pipe(Effect.scoped, Effect.uninterruptible);
  }

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
      ({ turn }) => Effect.sync(() => {
        if (this.mutationTails.get(workingCsvId) === turn) this.mutationTails.delete(workingCsvId);
      }).pipe(Effect.andThen(Deferred.succeed(turn, undefined))),
    ).pipe(Effect.flatMap(({ previous }) => observeStage('csv.queue-wait', previous ? Deferred.await(previous) : Effect.void)));
  }

  /**
   * The one lease primitive for reads, export serialization, mutations, reopen, and Comparison
   * sources. It leases the Working CSV's current table until the scope closes, and rejects work
   * while the workspace disposes or the Working CSV closes.
   */
  private lease(workingCsvId: WorkingCsvId): Effect.Effect<WorkingCsvState, Error, Scope.Scope> {
    return Effect.try({
      try: () => {
        this.assertAcceptingWork();
        this.assertNotClosing(workingCsvId);
        return this.requireWorkingCsv(workingCsvId);
      },
      catch: toError,
    }).pipe(Effect.flatMap((state) => this.leaseTable(state)));
  }

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
    return observeStage('csv.release-retired', Effect.tryPromise(() => this.dropRetiredSourceTable(tableName)).pipe(
      Effect.catchCause((cause) => recordOutcome('cleanup-failed', cause, 'cleanup-failed').pipe(Effect.andThen(markCleanupFailed))),
    ));
  }

  /**
   * Waits until no lease holds any table of the Working CSV. Retired tables count too: a reader
   * admitted before a reopen, or a mutation queued behind it, still leases the retired table.
   */
  private awaitLeases(workingCsvId: WorkingCsvId): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      while (true) {
        const current = this.workingCsvs.get(workingCsvId)?.tableName;
        const owned = this.retiredSourceTables().filter((retired) => retired.workingCsvId === workingCsvId).map((retired) => retired.tableName);
        const lease = [current, ...owned].flatMap((tableName) => tableName ? this.tableLeases.get(tableName) ?? [] : [])[0];
        if (!lease) return;
        yield* Deferred.await(lease.released);
      }
    });
  }

  private async retireSourceTable(tableName: string): Promise<void> {
    this.artifactRegistry.transition(tableName, 'retired');
    if (!this.tableLeases.has(tableName)) await this.dropRetiredSourceTable(tableName);
  }

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

  private async dropRetiredSourceTablesOwnedBy(workingCsvId: WorkingCsvId): Promise<void> {
    for (const retired of this.retiredSourceTables()) {
      if (retired.workingCsvId === workingCsvId) await this.dropRetiredSourceTable(retired.tableName);
    }
  }

  private async dropRetiredSourceTable(tableName: string): Promise<void> {
    await dropWorkingCsvTable(this.table(tableName));
    this.artifactRegistry.remove(tableName);
  }

  private requireWorkingCsv(workingCsvId: WorkingCsvId): WorkingCsvState {
    const state = this.workingCsvs.get(workingCsvId);

    if (!state) {
      throw new Error('Working CSV is no longer active.');
    }

    return state;
  }

  private assertNotClosing(workingCsvId: WorkingCsvId): void {
    if (this.closingWorkingCsvs.has(workingCsvId)) {
      throw new Error('Working CSV is closing.');
    }
  }

  private assertAcceptingWork(): void {
    if (this.lifecycle !== 'active') throw new Error('CSV workspace is disposing.');
  }

  /** One failing listener cannot suppress later listeners or fail the committed change. */
  private notifyDataChange(workingCsvId: WorkingCsvId): Effect.Effect<void> {
    return Effect.forEach([...this.dataChangeListeners], (listener) => Effect.try({
      try: () => listener(workingCsvId),
      catch: toError,
    }).pipe(Effect.catchCause((cause) => reportFailure('csv.notify-data-change', cause))), { discard: true });
  }
}

/** Adapts promise-based table work. Thrown errors keep their product messages. */
function attempt<A>(operation: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({ try: operation, catch: toError });
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

function requireColumnIndex(columns: readonly { name: string }[], name: string): number {
  const index = columns.findIndex((column) => column.name === name);
  if (index < 0) throw new Error(`Unknown CSV column: ${name}`);
  return index;
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

function validateDialectOptions(options: CsvDialectOptions): CsvDialectOptions {
  const dialect: CsvDialectOptions = {};

  if (options.delimiter !== undefined && options.delimiter !== '') {
    if (options.delimiter.length !== 1) {
      throw new CsvOpenError('Delimiter must be exactly one character.', 'dialect');
    }

    dialect.delimiter = options.delimiter;
  }

  if (options.header !== undefined) {
    dialect.header = options.header;
  }

  return dialect;
}

function isSupportedCsvSourceName(name: string): boolean {
  const lowerCaseName = name.toLowerCase();
  return supportedCsvFileExtensions.some((extension) => lowerCaseName.endsWith(`.${extension}`));
}

function validateWindowInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Row window ${label} must be a non-negative integer.`);
  }

  return value;
}

function buildWorkingCsvTableName(physicalTableId: string): string {
  return `${workingCsvTablePrefix}${physicalTableId.replaceAll('-', '_')}`;
}

/** A CSV Source error with product guidance and a diagnostic category. */
class CsvOpenError extends Error {
  constructor(message: string, readonly category: 'source-access' | 'dialect' | 'engine') {
    super(message);
    this.name = 'CsvOpenError';
  }
}

function normalizeRowIds(rowIds: string[]): string[] {
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

function normalizeOpenError(cause: unknown): Error {
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

  if (cause instanceof Error) return new CsvOpenError(`Unable to open CSV: ${cause.message}`, 'source-access');

  return new CsvOpenError('Unable to open CSV.', 'source-access');
}

/** Keep driver details out of product messages and diagnostics. */
function normalizeEngineError(cause: unknown): Error {
  if (cause instanceof CsvOpenError || cause instanceof CsvSourceUnavailableError) {
    return normalizeOpenError(cause);
  }
  return new CsvOpenError('Unable to read CSV: check the delimiter, quote, and header options for this file.', 'engine');
}
