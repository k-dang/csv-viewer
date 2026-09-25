import { DataEngineError } from '../database';
import { Cause, Effect } from 'effect';
import { observeStage, recordOutcome } from '../workspace-diagnostics';
import { toError } from '../errors';
import { csvInternalRowIdField, supportedCsvFileExtensions } from '../csv-viewer';
import type {
  CsvCellEditRequest,
  CsvCellEditResult,
  CsvColumnValues,
  CsvColumnValuesRequest,
  CsvColumnValueCounts,
  CsvColumnValueCountsRequest,
  CsvDeleteRowsRequest,
  CsvDialectOptions,
  CsvEditState,
  CsvExportOutcome,
  CsvEditStateRequest,
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
import { CsvEditHistory, rowCountDelta, type CsvEditCommand } from './csv-edit-history';
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
  applyColumnRename,
  applyRowDeletion,
  assertRowsExist,
  createWorkingCsvTable,
  dropWorkingCsvTable,
  insertEmptyRow,
  readCellValue,
  readColumns,
  readExportRows,
  readRowCount,
  renameCsvColumns,
  runEditCommand,
  type CsvTable,
} from './csv-working-csv-table';
import { csvDeletedField, csvSourceOrderField } from './csv-storage-schema';
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
  | { status: 'working-csv-not-found' }
  | { status: 'failed'; failure: WorkingCsvFailure };

const workingCsvTablePrefix = 'csv_working_';

type WorkingCsvState = {
  metadata: Omit<WorkingCsvView, 'editState'>;
  tableName: string;
  sourceId: CsvSourceId;
  defaultDelimiter: string;
  history: CsvEditHistory;
};

type WorkingCsvLease = {
  state: WorkingCsvState;
  release: () => Promise<void | DataEngineError>;
};

type OpenAdmission = { release: () => void };

type ReopenAdmission = OpenAdmission & {
  lease: WorkingCsvLease;
  previous: Promise<void>;
  settled: PromiseWithResolvers<void>;
  failed: boolean;
};

export class WorkingCsvStore {
  private readonly artifactRegistry = new WorkspaceArtifactRegistry();
  private workingCsvs = new Map<string, WorkingCsvState>();
  private dataChangeListeners = new Set<(workingCsvId: WorkingCsvId) => void>();
  private closingWorkingCsvs = new Set<string>();
  private sourceLeaseCounts = new Map<string, number>();
  private sourceLeaseWaiters = new Map<string, Array<() => void>>();
  private mutationQueues = new Map<WorkingCsvId, Promise<void>>();
  private activeWorkspaceWorkCount = 0;
  private workspaceWorkWaiters: Array<() => void> = [];
  private comparisonExecutor: ComparisonExecutor | null = null;
  private lifecycle: 'active' | 'disposing' | 'disposed' = 'active';

  constructor(
    private readonly host: CsvWorkspaceHost,
    private readonly database: WorkspaceDatabase,
  ) {}

  beginDisposal(): void {
    if (this.lifecycle === 'active') this.lifecycle = 'disposing';
  }

  /** Admit the complete transport operation before disposal can begin. */
  admitOpenWork(): OpenAdmission | null {
    return this.lifecycle === 'active' ? { release: this.acquireWorkspaceWork() } : null;
  }

  /** Reserve both the old table and a queue position before running any asynchronous confirmation. */
  admitReopenWork(workingCsvId: WorkingCsvId): ReopenAdmission | null {
    const work = this.admitOpenWork();
    if (!work) return null;
    try {
      const lease = this.acquireWorkingCsvLease(workingCsvId);
      const previous = this.mutationQueues.get(workingCsvId) ?? Promise.resolve();
      const settled = Promise.withResolvers<void>();
      this.mutationQueues.set(workingCsvId, settled.promise);
      return { ...work, lease, previous, settled, failed: false };
    } catch (error) {
      work.release();
      throw error;
    }
  }

  open(_admission: OpenAdmission, sourceId: CsvSourceId, options: CsvDialectOptions = {}): Effect.Effect<OpenWorkingCsvOutcome> {
    return Effect.gen({ self: this }, function* () {
      const existing = this.findBySource(sourceId);
      if (existing) return { status: 'existing', workingCsv: existing } satisfies OpenWorkingCsvOutcome;
      const cleanup = { failed: false };
      const result = yield* this.createWorkingCsv(sourceId, options, crypto.randomUUID(), 0, 0, cleanup).pipe(
        Effect.map((state): OpenWorkingCsvOutcome => {
          const alreadyOpen = this.findBySource(sourceId);
          if (alreadyOpen) return { status: 'existing', workingCsv: alreadyOpen };
          const view = buildWorkingCsvView(state);
          this.artifactRegistry.transition(state.tableName, 'current');
          this.workingCsvs.set(state.metadata.workingCsvId, state);
          return { status: 'opened', workingCsv: view };
        }),
        Effect.scoped,
        Effect.matchCauseEffect({
          onSuccess: (outcome) => recordOutcome(outcome.status === 'existing' ? 'already-open' : outcome.status, undefined, cleanup.failed ? 'cleanup-failed' : 'succeeded').pipe(Effect.as(outcome)),
          onFailure: (cause) => {
            const error = Cause.squash(cause);
            const failure = workingCsvFailure('open-failed', error);
            return recordOutcome('failed', cause, cleanup.failed ? 'cleanup-failed' : 'succeeded').pipe(
              Effect.andThen(error instanceof CsvOpenError ? Effect.annotateCurrentSpan('csvFailureCategory', error.category) : Effect.void),
              Effect.as({ status: 'failed', failure } satisfies OpenWorkingCsvOutcome),
            );
          },
        }),
      );
      return result;
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

  async waitForActiveWork(workingCsvId: WorkingCsvId): Promise<void> {
    while (true) {
      const state = this.workingCsvs.get(workingCsvId);
      if (!state) return;
      await this.waitForSourceLeases(state.tableName);
      if (this.workingCsvs.get(workingCsvId)?.tableName === state.tableName) return;
    }
  }

  createComparisonExecutor(): ComparisonExecutor {
    if (!this.comparisonExecutor) {
      this.comparisonExecutor = new DuckDbComparisonExecutor(
        {
          acquireSource: (workingCsvId) => this.acquireComparisonSource(workingCsvId),
          getOwnerConnection: () => this.database.ownerConnection(),
          connectWorker: async () => {
            const releaseWork = this.acquireWorkspaceWork();
            try {
              return await this.database.connectWorker();
            } finally {
              releaseWork();
            }
          },
        },
        this.artifactRegistry,
      );
    }
    return this.comparisonExecutor;
  }

  replace(
    admission: ReopenAdmission,
    expectedDataRevision: number,
    options: CsvDialectOptions = {},
  ): Effect.Effect<ReplaceWorkingCsvOutcome> {
    return Effect.gen({ self: this }, function* () {
      const workingCsvId = admission.lease.state.metadata.workingCsvId;
      const cleanup = { failed: false };
      return yield* this.withWorkingCsvMutationEffect(admission, (existing) => Effect.gen({ self: this }, function* () {
        if (existing.metadata.dataRevision !== expectedDataRevision) {
          return { status: 'revision-changed', workingCsv: buildWorkingCsvView(existing) } satisfies ReplaceWorkingCsvOutcome;
        }
        const state = yield* this.createWorkingCsv(
          existing.sourceId, options, workingCsvId, existing.metadata.dataRevision + 1,
          existing.history.revisionSequence, cleanup,
        );
        const view = buildWorkingCsvView(state);
        yield* Effect.sync(() => this.publishReplacement(existing, state));
        this.notifyDataChange(workingCsvId);
        return { status: 'replaced', workingCsv: view } satisfies ReplaceWorkingCsvOutcome;
      }).pipe(Effect.scoped), cleanup).pipe(
        Effect.matchCauseEffect({
          onSuccess: (outcome) => recordOutcome(outcome.status === 'replaced' ? 'opened' : outcome.status, undefined, cleanup.failed ? 'cleanup-failed' : 'succeeded').pipe(Effect.as(outcome)),
          onFailure: (cause) => {
            const error = Cause.squash(cause);
            const failure = workingCsvFailure('replace-failed', error);
            return recordOutcome('failed', cause, cleanup.failed ? 'cleanup-failed' : 'succeeded').pipe(
              Effect.andThen(error instanceof CsvOpenError ? Effect.annotateCurrentSpan('csvFailureCategory', error.category) : Effect.void),
              Effect.as({ status: 'failed', failure } satisfies ReplaceWorkingCsvOutcome),
            );
          },
        }),
      );
    }).pipe(Effect.uninterruptible);
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

  async closeWorkingCsv(workingCsvId: WorkingCsvId): Promise<void> {
    while (true) {
      const state = this.workingCsvs.get(workingCsvId);
      if (!state) return;

      await this.waitForSourceLeases(state.tableName);
      if (this.workingCsvs.get(workingCsvId)?.tableName !== state.tableName) continue;
      await this.dropRetiredSourceTablesOwnedBy(workingCsvId);
      try {
        await this.retireSourceTable(state.tableName);
      } catch (error) {
        this.rollbackSourceRetirement(state.tableName);
        throw error;
      }
      if (this.workingCsvs.get(workingCsvId)?.tableName !== state.tableName) continue;
      this.workingCsvs.delete(workingCsvId);
      this.closingWorkingCsvs.delete(workingCsvId);
      this.host.releaseSource(state.sourceId);
      return;
    }
  }

  async disposeStore(): Promise<void> {
    this.beginDisposal();
    let disposalFailure: Error | null = null;
    let teardownFailures: Error[] = [];
    try {
      await this.waitForWorkspaceWork();
      for (const workingCsvId of this.workingCsvs.keys()) this.beginClose(workingCsvId);
      for (const workingCsvId of [...this.workingCsvs.keys()]) {
        await this.closeWorkingCsv(workingCsvId);
      }

      if (this.sourceLeaseCounts.size > 0) {
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
    } catch (error) {
      disposalFailure = toError(error);
    } finally {
      teardownFailures = await this.database.close();
      this.lifecycle = 'disposed';
    }

    const failures = disposalFailure ? [disposalFailure, ...teardownFailures] : teardownFailures;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Unable to dispose all Working CSV resources.');
    }
  }

  hasUnexportedChanges(workingCsvId: WorkingCsvId): boolean {
    const state = this.workingCsvs.get(workingCsvId);
    return state ? state.history.hasUnexportedChanges : false;
  }

  getEditState(request: CsvEditStateRequest): CsvEditState {
    this.assertAcceptingWork();
    this.assertNotClosing(request.workingCsvId);
    return buildEditState(this.requireWorkingCsv(request.workingCsvId));
  }

  async getRows(request: CsvRowWindowRequest): Promise<CsvRowWindow> {
    const lease = this.acquireWorkingCsvLease(request.workingCsvId);
    try {
      const state = lease.state;
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
    } finally {
      await lease.release();
    }
  }

  getColumnValues(request: CsvColumnValuesRequest): Promise<CsvColumnValues> {
    return this.withWorkingCsvLease(request.workingCsvId, async (state) => {
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

  async getColumnValueCounts(request: CsvColumnValueCountsRequest): Promise<CsvColumnValueCounts> {
    const lease = this.acquireWorkingCsvLease(request.workingCsvId);
    try {
      const state = lease.state;
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
    } finally {
      await lease.release();
    }
  }

  async editCell(request: CsvCellEditRequest): Promise<CsvCellEditResult> {
    return this.withWorkingCsvMutation(request.workingCsvId, async (state) => {
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
      this.commitDataChange(state);

      return {
        rowId: request.rowId,
        column: request.column,
        ...buildEditState(state),
      };
    });
  }

  async deleteRows(request: CsvDeleteRowsRequest): Promise<CsvEditState> {
    return this.withWorkingCsvMutation(request.workingCsvId, async (state) => {
      const rowIds = normalizeRowIds(request.rowIds);

      if (rowIds.length === 0) {
        throw new Error('At least one CSV row must be selected for deletion.');
      }

      const table = this.tableFor(state);
      await assertRowsExist(table, rowIds);
      await applyRowDeletion(table, rowIds, true);
      state.history.record({ type: 'delete-rows', rowIds });
      this.commitDataChange(state, -rowIds.length);

      return buildEditState(state);
    });
  }

  async insertRow(request: CsvInsertRowRequest): Promise<CsvEditState> {
    return this.withWorkingCsvMutation(request.workingCsvId, async (state) => {
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
      this.commitDataChange(state, 1);

      return buildEditState(state);
    });
  }

  async renameColumn(request: CsvRenameColumnRequest): Promise<CsvSchemaEditState> {
    return this.withWorkingCsvMutation(request.workingCsvId, async (state) => {
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

      await applyColumnRename(this.tableFor(state), request.column, name);
      state.history.record({ type: 'rename-column', from: request.column, to: name });
      state.metadata.columns = renameCsvColumns(state.metadata.columns, request.column, name);
      this.commitDataChange(state);
      return buildSchemaEditState(state);
    });
  }

  async undo(workingCsvId: WorkingCsvId): Promise<CsvSchemaEditState> {
    return this.stepHistory(workingCsvId, 'undo');
  }

  async redo(workingCsvId: WorkingCsvId): Promise<CsvSchemaEditState> {
    return this.stepHistory(workingCsvId, 'redo');
  }

  private async stepHistory(workingCsvId: WorkingCsvId, direction: 'undo' | 'redo'): Promise<CsvSchemaEditState> {
    return this.withWorkingCsvMutation(workingCsvId, async (state) => {
      const table = this.tableFor(state);
      const replay = (entry: CsvEditCommand) => runEditCommand(table, entry, direction);
      const command = direction === 'undo' ? await state.history.undo(replay) : await state.history.redo(replay);
      if (command.type === 'rename-column') {
        const from = direction === 'redo' ? command.from : command.to;
        const to = direction === 'redo' ? command.to : command.from;
        state.metadata.columns = renameCsvColumns(state.metadata.columns, from, to);
      }
      this.commitDataChange(state, rowCountDelta(command, direction));
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
  async exportCsv(workingCsvId: WorkingCsvId): Promise<CsvExportOutcome> {
    const prepared = await this.withWorkingCsvLease(workingCsvId, async (state) => {
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

    const delivery = await this.host.deliverExport({
      sourceId: prepared.sourceId,
      suggestedName: prepared.suggestedName,
      contents: prepared.contents,
    });
    if (delivery.status === 'cancelled') return { status: 'cancelled' };

    const state = this.workingCsvs.get(workingCsvId) ?? prepared.state;
    if (state.history === prepared.state.history) state.history.markExported(prepared.revisionId);
    return { status: 'exported', editState: buildEditState(state) };
  }

  private createWorkingCsv(
    sourceId: CsvSourceId,
    options: CsvDialectOptions,
    logicalWorkingCsvId: WorkingCsvId,
    dataRevision: number,
    initialRevisionId: number,
    cleanup: { failed: boolean },
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
        () => this.releaseStagingTable(tableName, cleanup),
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

  private releaseStagingTable(tableName: string, cleanup: { failed: boolean }) {
    return observeStage('csv.release-staging', Effect.gen({ self: this }, function* () {
      if (this.artifactRegistry.get(tableName)?.role !== 'staging') return;
      const result = yield* Effect.exit(Effect.tryPromise(() => dropWorkingCsvTable(this.table(tableName))));
      if (result._tag === 'Failure') {
        cleanup.failed = true;
        yield* recordOutcome('cleanup-failed', result.cause, 'cleanup-failed');
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

  private async acquireComparisonSource(workingCsvId: WorkingCsvId) {
    const lease = this.acquireWorkingCsvLease(workingCsvId);
    return {
      tableName: lease.state.tableName,
      columns: lease.state.metadata.columns.map((column) => ({ ...column })),
      release: lease.release,
    };
  }

  private acquireWorkingCsvLease(workingCsvId: WorkingCsvId): WorkingCsvLease {
    this.assertAcceptingWork();
    this.assertNotClosing(workingCsvId);
    const state = this.requireWorkingCsv(workingCsvId);
    return this.acquireStateLease(state);
  }

  private acquireStateLease(state: WorkingCsvState): WorkingCsvLease {
    const { tableName } = state;
    this.sourceLeaseCounts.set(tableName, (this.sourceLeaseCounts.get(tableName) ?? 0) + 1);
    let released = false;
    return {
      state,
      release: async () => {
        if (released) return;
        released = true;
        return this.releaseWorkingCsvLease(tableName);
      },
    };
  }

  private async withWorkingCsvLease<T>(
    workingCsvId: WorkingCsvId,
    operation: (state: WorkingCsvState) => Promise<T>,
  ): Promise<T> {
    const lease = this.acquireWorkingCsvLease(workingCsvId);
    try {
      return await operation(lease.state);
    } finally {
      await lease.release();
    }
  }

  /**
   * Runs one mutation at a time per Working CSV. A lease keeps a table alive across an await but
   * does not exclude anything, and every mutation reads engine or history state before it writes:
   * two inserts would read the same next row identifier, and two undos would replay and pop the
   * same command twice. Reads stay off this queue and keep running concurrently.
   *
   * An admission lease makes a close wait for queued work. When a preceding Reopen CSV replaces
   * the backing table, the mutation takes a second lease and resolves the current state as its
   * turn begins.
   */
  private async withWorkingCsvMutation<T>(
    workingCsvId: WorkingCsvId,
    operation: (state: WorkingCsvState) => Promise<T>,
  ): Promise<T> {
    const admissionLease = this.acquireWorkingCsvLease(workingCsvId);
    const queued = this.mutationQueues.get(workingCsvId) ?? Promise.resolve();
    const mutation = queued.then(async () => {
      const currentState = this.requireWorkingCsv(workingCsvId);
      const currentLease = currentState === admissionLease.state ? null : this.acquireStateLease(currentState);
      try {
        return await operation(currentState);
      } finally {
        await currentLease?.release();
      }
    });
    const settled = mutation.then(() => undefined, () => undefined);
    this.mutationQueues.set(workingCsvId, settled);
    try {
      return await mutation;
    } finally {
      if (this.mutationQueues.get(workingCsvId) === settled) {
        this.mutationQueues.delete(workingCsvId);
      }
      await admissionLease.release();
    }
  }

  /** The queue slot was reserved when the request was admitted, before any prompt or await. */
  private withWorkingCsvMutationEffect<A, E>(
    admission: ReopenAdmission,
    operation: (state: WorkingCsvState) => Effect.Effect<A, E>,
    cleanup: { failed: boolean },
  ): Effect.Effect<A, E> {
    return Effect.scoped(Effect.gen({ self: this }, function* () {
      yield* Effect.promise(() => admission.previous);
      const current = this.requireWorkingCsv(admission.lease.state.metadata.workingCsvId);
      if (current !== admission.lease.state) {
        yield* Effect.acquireRelease(
          Effect.sync(() => this.acquireStateLease(current)),
          (lease) => this.releaseReopenLease(lease, cleanup),
        );
      }
      return yield* operation(current);
    }));
  }

  releaseReopenAdmission(admission: ReopenAdmission) {
    return this.releaseReopenLease(admission.lease, admission).pipe(Effect.ensuring(Effect.sync(() => {
      const workingCsvId = admission.lease.state.metadata.workingCsvId;
      if (this.mutationQueues.get(workingCsvId) === admission.settled.promise) this.mutationQueues.delete(workingCsvId);
      admission.settled.resolve();
      admission.release();
    })));
  }

  private releaseReopenLease(lease: WorkingCsvLease, cleanup: { failed: boolean }) {
    return observeStage('csv.release-retired', Effect.gen(function* () {
      const result = yield* Effect.exit(Effect.promise(() => lease.release()));
      if (result._tag === 'Failure') {
        cleanup.failed = true;
        yield* recordOutcome('cleanup-failed', result.cause, 'cleanup-failed');
      } else if (result.value) {
        cleanup.failed = true;
        yield* recordOutcome('cleanup-failed', Cause.fail(result.value), 'cleanup-failed');
      }
    }));
  }

  private async releaseWorkingCsvLease(tableName: string): Promise<void | DataEngineError> {
    const count = this.sourceLeaseCounts.get(tableName);
    if (!count) throw new Error('Working CSV source lease invariant violated.');
    if (count > 1) {
      this.sourceLeaseCounts.set(tableName, count - 1);
      return;
    }
    this.sourceLeaseCounts.delete(tableName);
    try {
      if (this.artifactRegistry.get(tableName)?.role === 'retired') {
        try {
          await this.dropRetiredSourceTable(tableName);
        } catch (cause) {
          // The lease is released. The registry still owns the table for disposal retry.
          return new DataEngineError(cause);
        }
      }
    } finally {
      const waiters = this.sourceLeaseWaiters.get(tableName) ?? [];
      this.sourceLeaseWaiters.delete(tableName);
      waiters.forEach((resolve) => resolve());
    }
  }

  private async waitForSourceLeases(tableName: string): Promise<void> {
    if (!this.sourceLeaseCounts.has(tableName)) return;
    await new Promise<void>((resolve) => {
      const waiters = this.sourceLeaseWaiters.get(tableName) ?? [];
      waiters.push(resolve);
      this.sourceLeaseWaiters.set(tableName, waiters);
    });
  }

  private async retireSourceTable(tableName: string): Promise<void> {
    this.artifactRegistry.transition(tableName, 'retired');
    if (!this.sourceLeaseCounts.has(tableName)) await this.dropRetiredSourceTable(tableName);
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

  private acquireWorkspaceWork(): () => void {
    this.assertAcceptingWork();
    this.activeWorkspaceWorkCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeWorkspaceWorkCount -= 1;
      if (this.activeWorkspaceWorkCount !== 0) return;
      const waiters = this.workspaceWorkWaiters;
      this.workspaceWorkWaiters = [];
      waiters.forEach((resolve) => resolve());
    };
  }

  private async waitForWorkspaceWork(): Promise<void> {
    if (this.activeWorkspaceWorkCount === 0) return;
    await new Promise<void>((resolve) => this.workspaceWorkWaiters.push(resolve));
  }

  private commitDataChange(state: WorkingCsvState, rowCountDelta = 0): void {
    state.metadata = {
      ...state.metadata,
      dataRevision: state.metadata.dataRevision + 1,
      rowCount: state.metadata.rowCount + rowCountDelta,
    };
    this.notifyDataChange(state.metadata.workingCsvId);
  }

  private notifyDataChange(workingCsvId: WorkingCsvId): void {
    for (const listener of this.dataChangeListeners) {
      try {
        listener(workingCsvId);
      } catch (error) {
        console.error(`Working CSV data-change listener failed for ${workingCsvId}.`, error);
      }
    }
  }
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

function isReservedCsvColumnName(name: string): boolean {
  const needle = name.toLowerCase();
  return (
    needle === csvInternalRowIdField.toLowerCase() ||
    needle === csvSourceOrderField.toLowerCase() ||
    needle === csvDeletedField.toLowerCase()
  );
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

/** A CSV Source that could not be opened, carrying copy the user can act on. */
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

/**
 * Data engine failures carry driver detail such as the CSV Source path, and the host boundary keeps
 * runtime locations out of workspace diagnostics. The caller gets guidance about which dialect
 * options to change before retrying.
 */
function normalizeEngineError(cause: unknown): Error {
  if (cause instanceof CsvOpenError || cause instanceof CsvSourceUnavailableError) {
    return normalizeOpenError(cause);
  }
  return new CsvOpenError('Unable to read CSV: check the delimiter, quote, and header options for this file.', 'engine');
}
