import { toError } from '../shared/errors';
import { supportedCsvFileExtensions } from '../shared/csv-viewer-contract';
import type {
  CsvCellEditRequest,
  CsvCellEditResult,
  CsvColumnValueCounts,
  CsvColumnValueCountsRequest,
  CsvDeleteRowsRequest,
  CsvDialectOptions,
  CsvEditState,
  CsvEditStateRequest,
  CsvInsertRowRequest,
  CsvRowWindow,
  CsvRowWindowRequest,
  CsvSourceId,
  OpenWorkingCsvOutcome,
  ReplaceWorkingCsvOutcome,
  WorkingCsvFailure,
  WorkingCsvId,
  WorkingCsvView,
} from '../shared/csv-viewer-contract';
import type { ComparisonExecutor } from './comparison-executor';
import { CsvEditHistory, rowCountDelta, type CsvEditCommand } from './csv-edit-history';
import { serializeCsvExport } from './csv-export-serialization';
import {
  assertKnownColumn,
  buildColumnValueCountsQuery,
  buildRowsQuery,
  maxRowWindowLimit,
} from './csv-query';
import { normalizeCellValue, normalizeCount, normalizeRow } from './csv-result-normalization';
import {
  applyCellValue,
  applyRowDeletion,
  assertRowsExist,
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
import { DuckDbWorkspaceDatabase } from './duckdb/duckdb-database';
import { DuckDbComparisonExecutor } from './duckdb/duckdb-comparison-executor';
import { CsvSourceUnavailableError, type CsvWorkspaceHost } from './workspace-host';
import { WorkspaceArtifactRegistry } from './workspace-artifact-registry';

const workingCsvTablePrefix = 'csv_working_';

type WorkingCsvState = {
  metadata: Omit<WorkingCsvView, 'editState'>;
  tableName: string;
  sourceId: CsvSourceId;
  defaultDelimiter: string;
  history: CsvEditHistory;
};

export class WorkingCsvStore {
  private readonly artifactRegistry = new WorkspaceArtifactRegistry();
  private readonly database = new DuckDbWorkspaceDatabase();
  private workingCsvs = new Map<string, WorkingCsvState>();
  private dataChangeListeners = new Set<(workingCsvId: WorkingCsvId) => void>();
  private closingWorkingCsvs = new Set<string>();
  private sourceLeaseCounts = new Map<string, number>();
  private sourceLeaseWaiters = new Map<string, Array<() => void>>();
  private mutationQueues = new Map<WorkingCsvId, Promise<void>>();
  private activeWorkspaceWorkCount = 0;
  private workspaceWorkWaiters: Array<() => void> = [];
  private retiredSourceTables = new Set<string>();
  private comparisonExecutor: ComparisonExecutor | null = null;
  private lifecycle: 'active' | 'disposing' | 'disposed' = 'active';

  constructor(private readonly host: CsvWorkspaceHost) {}

  beginDisposal(): void {
    if (this.lifecycle === 'active') this.lifecycle = 'disposing';
  }

  async open(sourceId: CsvSourceId, options: CsvDialectOptions = {}): Promise<OpenWorkingCsvOutcome> {
    if (this.lifecycle !== 'active') {
      return { status: 'failed', failure: unavailableWorkingCsvFailure('open-failed') };
    }
    const existing = this.findBySource(sourceId);
    if (existing) return { status: 'existing', workingCsv: existing };
    try {
      return { status: 'opened', workingCsv: await this.openWorkingCsv(sourceId, options) };
    } catch (error) {
      if (this.lifecycle !== 'active') {
        return { status: 'failed', failure: unavailableWorkingCsvFailure('open-failed') };
      }
      return { status: 'failed', failure: workingCsvFailure('open-failed', error) };
    }
  }

  private async openWorkingCsv(
    sourceId: CsvSourceId,
    options: CsvDialectOptions = {},
  ): Promise<WorkingCsvView> {
    const releaseWork = this.acquireWorkspaceWork();
    try {
      if (this.findBySource(sourceId)) throw new Error('CSV file is already open.');

      const state = await this.createWorkingCsv(sourceId, options);
      this.artifactRegistry.transition(state.tableName, 'current');
      this.workingCsvs.set(state.metadata.workingCsvId, state);
      return buildWorkingCsvView(state);
    } finally {
      releaseWork();
    }
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

  async replace(
    workingCsvId: WorkingCsvId,
    options: CsvDialectOptions = {},
  ): Promise<ReplaceWorkingCsvOutcome> {
    if (this.lifecycle !== 'active') {
      return { status: 'failed', failure: unavailableWorkingCsvFailure('replace-failed') };
    }
    if (!this.workingCsvs.has(workingCsvId)) return { status: 'working-csv-not-found' };
    try {
      return {
        status: 'replaced',
        workingCsv: await this.replaceWorkingCsv(workingCsvId, options),
      };
    } catch (error) {
      return { status: 'failed', failure: workingCsvFailure('replace-failed', error) };
    }
  }

  private async replaceWorkingCsv(
    workingCsvId: WorkingCsvId,
    options: CsvDialectOptions = {},
  ): Promise<WorkingCsvView> {
    return this.withWorkingCsvMutation(workingCsvId, async (existing) => {
      const state = await this.createWorkingCsv(
        existing.sourceId,
        options,
        workingCsvId,
        existing.metadata.dataRevision,
        existing.history.revisionSequence,
      );
      this.artifactRegistry.transition(existing.tableName, 'retired');
      this.retiredSourceTables.add(existing.tableName);
      this.artifactRegistry.transition(state.tableName, 'current');
      this.workingCsvs.set(workingCsvId, state);
      this.commitDataChange(state);
      return buildWorkingCsvView(state);
    });
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
      for (const tableName of [...this.retiredSourceTables]) {
        await this.dropRetiredSourceTable(tableName);
      }

      this.artifactRegistry.assertEmpty();
    } catch (error) {
      disposalFailure = toError(error);
    } finally {
      teardownFailures = this.database.close();
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
      if (request.hasActiveQuery) {
        throw new Error('CSV rows cannot be inserted while sort, filter, or search is active.');
      }

      const rowIds = normalizeRowIds(request.rowIds);

      if (request.placement === 'append') {
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

  async undo(workingCsvId: WorkingCsvId): Promise<CsvEditState> {
    return this.stepHistory(workingCsvId, 'undo');
  }

  async redo(workingCsvId: WorkingCsvId): Promise<CsvEditState> {
    return this.stepHistory(workingCsvId, 'redo');
  }

  private async stepHistory(
    workingCsvId: WorkingCsvId,
    direction: 'undo' | 'redo',
  ): Promise<CsvEditState> {
    return this.withWorkingCsvMutation(workingCsvId, async (state) => {
      const table = this.tableFor(state);
      const replay = (entry: CsvEditCommand) => runEditCommand(table, entry, direction);
      const command =
        direction === 'undo'
          ? await state.history.undo(replay)
          : await state.history.redo(replay);
      this.commitDataChange(state, rowCountDelta(command, direction));
      return buildEditState(state);
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
  async exportCsv(workingCsvId: WorkingCsvId): Promise<CsvEditState | { status: 'cancelled' }> {
    const prepared = await this.withWorkingCsvLease(workingCsvId, async (state) => {
      const { metadata } = state;
      return {
        state,
        sourceId: state.sourceId,
        suggestedName: metadata.file.name,
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
    return buildEditState(state);
  }

  private async createWorkingCsv(
    sourceId: CsvSourceId,
    options: CsvDialectOptions,
    logicalWorkingCsvId: WorkingCsvId = crypto.randomUUID(),
    dataRevision = 0,
    initialRevisionId = 0,
  ): Promise<WorkingCsvState> {
    const dialect = validateDialectOptions(options);
    const description = await this.host
      .describeSource(sourceId)
      .catch((error: unknown) => {
        throw normalizeOpenError(error);
      });

    if (!isSupportedCsvSourceName(description.name)) {
      throw new CsvOpenError('Unsupported file type. Choose a CSV, TSV, or text file.');
    }

    await this.database.ownerConnection();
    const tableName = buildWorkingCsvTableName(crypto.randomUUID());
    const table = this.table(tableName);
    this.artifactRegistry.register({
      tableName,
      owner: { kind: 'working-csv', workingCsvId: logicalWorkingCsvId },
      role: 'staging',
    });

    try {
      await this.host.withEngineSource(sourceId, (engineSourceReference) =>
        createWorkingCsvTable(table, engineSourceReference, dialect),
      );

      const metadata: Omit<WorkingCsvView, 'editState'> = {
        workingCsvId: logicalWorkingCsvId,
        dataRevision,
        file: {
          sourceId,
          name: description.name,
          location: description.location,
          sizeBytes: description.sizeBytes,
        },
        columns: await readColumns(table),
        rowCount: await readRowCount(table),
        dialect,
      };

      return {
        metadata,
        tableName,
        sourceId,
        defaultDelimiter: description.defaultDelimiter,
        history: new CsvEditHistory(initialRevisionId),
      };
    } catch (error) {
      await dropWorkingCsvTable(table).catch((cleanupError: unknown) => {
        console.error('Unable to drop a partially created Working CSV table.', cleanupError);
      });
      this.artifactRegistry.remove(tableName);
      throw normalizeEngineError(error);
    }
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

  private acquireWorkingCsvLease(workingCsvId: WorkingCsvId): {
    state: WorkingCsvState;
    release: () => Promise<void>;
  } {
    this.assertAcceptingWork();
    this.assertNotClosing(workingCsvId);
    const state = this.requireWorkingCsv(workingCsvId);
    const { tableName } = state;
    this.sourceLeaseCounts.set(tableName, (this.sourceLeaseCounts.get(tableName) ?? 0) + 1);
    let released = false;
    return {
      state,
      release: async () => {
        if (released) return;
        released = true;
        await this.releaseWorkingCsvLease(tableName);
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
   * The lease is taken as the mutation is admitted rather than when its turn comes, so a close
   * that arrives afterwards still waits for everything already queued behind it.
   */
  private async withWorkingCsvMutation<T>(
    workingCsvId: WorkingCsvId,
    operation: (state: WorkingCsvState) => Promise<T>,
  ): Promise<T> {
    const lease = this.acquireWorkingCsvLease(workingCsvId);
    const queued = this.mutationQueues.get(workingCsvId) ?? Promise.resolve();
    const mutation = queued.then(() => operation(lease.state));
    const settled = mutation.then(
      () => undefined,
      () => undefined,
    );
    this.mutationQueues.set(workingCsvId, settled);
    try {
      return await mutation;
    } finally {
      if (this.mutationQueues.get(workingCsvId) === settled) {
        this.mutationQueues.delete(workingCsvId);
      }
      await lease.release();
    }
  }

  private async releaseWorkingCsvLease(tableName: string): Promise<void> {
    const count = this.sourceLeaseCounts.get(tableName);
    if (!count) throw new Error('Working CSV source lease invariant violated.');
    if (count > 1) {
      this.sourceLeaseCounts.set(tableName, count - 1);
      return;
    }
    this.sourceLeaseCounts.delete(tableName);
    try {
      if (this.retiredSourceTables.has(tableName)) {
        await this.dropRetiredSourceTable(tableName).catch((error) => {
          console.error('Unable to drop a retired Working CSV table.', error);
        });
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
    this.retiredSourceTables.add(tableName);
    if (!this.sourceLeaseCounts.has(tableName)) await this.dropRetiredSourceTable(tableName);
  }

  private rollbackSourceRetirement(tableName: string): void {
    if (this.artifactRegistry.get(tableName)?.role === 'retired') {
      this.artifactRegistry.transition(tableName, 'current');
    }
    this.retiredSourceTables.delete(tableName);
  }

  private async dropRetiredSourceTablesOwnedBy(workingCsvId: WorkingCsvId): Promise<void> {
    for (const tableName of [...this.retiredSourceTables]) {
      const owner = this.artifactRegistry.get(tableName)?.owner;
      if (owner?.kind === 'working-csv' && owner.workingCsvId === workingCsvId) {
        await this.dropRetiredSourceTable(tableName);
      }
    }
  }

  private async dropRetiredSourceTable(tableName: string): Promise<void> {
    await dropWorkingCsvTable(this.table(tableName));
    this.artifactRegistry.remove(tableName);
    this.retiredSourceTables.delete(tableName);
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

function buildWorkingCsvView(state: WorkingCsvState): WorkingCsvView {
  return {
    ...state.metadata,
    columns: state.metadata.columns.map((column) => ({ ...column })),
    file: { ...state.metadata.file },
    dialect: { ...state.metadata.dialect },
    editState: buildEditState(state),
  };
}

function validateDialectOptions(options: CsvDialectOptions): CsvDialectOptions {
  const dialect: CsvDialectOptions = {};

  if (options.delimiter !== undefined && options.delimiter !== '') {
    if (options.delimiter.length !== 1) {
      throw new CsvOpenError('Delimiter must be exactly one character.');
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
  constructor(message: string) {
    super(message);
    this.name = 'CsvOpenError';
  }
}

function normalizeRowIds(rowIds: string[]): string[] {
  const normalizedRowIds = rowIds.map((rowId) => rowId.trim()).filter((rowId) => rowId.length > 0);
  return [...new Set(normalizedRowIds)];
}

function workingCsvFailure(code: WorkingCsvFailure['code'], error: unknown): WorkingCsvFailure {
  console.error(`Working CSV ${code} operation failed.`, error);
  return { code, message: normalizeOpenError(error).message, retryable: true };
}

function unavailableWorkingCsvFailure(code: WorkingCsvFailure['code']): WorkingCsvFailure {
  return {
    code,
    message: 'The CSV workspace is closing.',
    retryable: false,
  };
}

function normalizeOpenError(error: unknown): Error {
  if (error instanceof CsvOpenError) return error;

  if (error instanceof CsvSourceUnavailableError) {
    if (error.code === 'missing-source') {
      return new CsvOpenError('Unable to open CSV: the file no longer exists.');
    }
    if (error.code === 'permission-denied') {
      return new CsvOpenError('Unable to open CSV: permission was denied for this file.');
    }
    return new CsvOpenError('Unable to open CSV: the file could not be read.');
  }

  if (error instanceof Error) return new CsvOpenError(`Unable to open CSV: ${error.message}`);

  return new CsvOpenError('Unable to open CSV.');
}

/**
 * Data engine failures carry driver detail such as the CSV Source path, and the host boundary keeps
 * runtime locations out of the workspace's callers. The detail is logged instead, and the caller
 * gets the message that actually helps: what to change about the dialect and try again.
 */
function normalizeEngineError(error: unknown): Error {
  if (error instanceof CsvOpenError || error instanceof CsvSourceUnavailableError) {
    return normalizeOpenError(error);
  }
  console.error('The data engine could not read the CSV Source.', error);
  return new CsvOpenError(
    'Unable to read CSV: check the delimiter, quote, and header options for this file.',
  );
}
