import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { randomUUID } from 'node:crypto';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CsvCellEditRequest,
  CsvCellEditResult,
  CsvCellValue,
  CsvColumn,
  CsvColumnValueCounts,
  CsvColumnValueCountsRequest,
  CsvDeleteRowsRequest,
  CsvDialectOptions,
  CsvEditState,
  CsvEditStateRequest,
  CsvInsertRowRequest,
  CsvRow,
  CsvRowWindow,
  CsvRowWindowRequest,
  OpenWorkingCsvOutcome,
  ReplaceWorkingCsvOutcome,
  WorkingCsvFailure,
  WorkingCsvId,
  WorkingCsvView,
} from '../shared/ipc';
import { csvInternalRowIdField } from '../shared/ipc';
import type { ComparisonExecutor } from './comparison-executor';
import {
  captureFileIdentity,
  sameFileIdentity,
  type CanonicalFileIdentity,
} from './desktop-csv-export';
import { DuckDbComparisonExecutor } from './duckdb-comparison-executor';
import {
  assertKnownColumn,
  buildColumnValueCountsQuery,
  buildRowsQuery,
  normalizeCellValue,
  normalizeCount,
  quoteIdentifier,
} from './csv-query';
import { csvDeletedField, csvSourceOrderField } from './csv-storage-schema';
import { WorkspaceArtifactRegistry } from './workspace-artifact-registry';

const workingCsvTablePrefix = 'csv_session_';
const supportedFileExtensions = new Set(['.csv', '.tsv', '.txt']);

type CsvEditCommand = RevisionTransition &
  (
    | {
      type: 'cell-edit';
      rowId: string;
      column: string;
      oldValue: CsvCellValue;
      newValue: CsvCellValue;
    }
    | {
      type: 'delete-rows';
      rowIds: string[];
    }
    | {
      type: 'insert-row';
      rowId: string;
    }
  );

type RevisionTransition = {
  previousRevisionId: number;
  revisionId: number;
};

type WorkingCsvState = {
  metadata: Omit<WorkingCsvView, 'editState'>;
  connection: DuckDBConnection;
  tableName: string;
  sourceIdentity: CanonicalFileIdentity;
  undoStack: CsvEditCommand[];
  redoStack: CsvEditCommand[];
  currentRevisionId: number;
  lastExportedRevisionId: number;
  nextRevisionId: number;
};

export class WorkingCsvStore {
  private readonly artifactRegistry = new WorkspaceArtifactRegistry();
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private workingCsvs = new Map<string, WorkingCsvState>();
  private dataChangeListeners = new Set<(workingCsvId: WorkingCsvId) => void>();
  private closingWorkingCsvs = new Set<string>();
  private sourceLeaseCounts = new Map<string, number>();
  private sourceLeaseWaiters = new Map<string, Array<() => void>>();
  private activeWorkspaceWorkCount = 0;
  private workspaceWorkWaiters: Array<() => void> = [];
  private retiredSourceTables = new Set<string>();
  private comparisonExecutor: ComparisonExecutor | null = null;
  private lifecycle: 'active' | 'disposing' | 'disposed' = 'active';

  beginDisposal(): void {
    if (this.lifecycle === 'active') this.lifecycle = 'disposing';
  }

  async open(
    filePath: string,
    options: CsvDialectOptions = {},
  ): Promise<OpenWorkingCsvOutcome> {
    if (this.lifecycle !== 'active') {
      return { status: 'failed', failure: unavailableWorkingCsvFailure('open-failed') };
    }
    const existing = this.findByPath(filePath);
    if (existing) return { status: 'existing', workingCsv: existing };
    try {
      return { status: 'opened', workingCsv: await this.openOrThrow(filePath, options) };
    } catch (error) {
      if (this.lifecycle !== 'active') {
        return { status: 'failed', failure: unavailableWorkingCsvFailure('open-failed') };
      }
      return { status: 'failed', failure: workingCsvFailure('open-failed', error) };
    }
  }

  async openOrThrow(filePath: string, options: CsvDialectOptions = {}): Promise<WorkingCsvView> {
    const releaseWork = this.acquireWorkspaceWork();
    try {
      if (this.findByPath(filePath)) throw new Error('CSV file is already open.');

      const state = await this.createWorkingCsv(filePath, options);
      this.artifactRegistry.transition(state.tableName, 'current');
      this.workingCsvs.set(state.metadata.workingCsvId, state);
      return buildWorkingCsvView(state);
    } finally {
      releaseWork();
    }
  }

  findByPath(filePath: string): WorkingCsvView | null {
    const normalizedPath = path.resolve(filePath);

    for (const state of this.workingCsvs.values()) {
      if (path.resolve(state.metadata.file.path) === normalizedPath) {
        return buildWorkingCsvView(state);
      }
    }

    return null;
  }

  getState(workingCsvId: WorkingCsvId): WorkingCsvView | null {
    const state = this.workingCsvs.get(workingCsvId);
    return state ? buildWorkingCsvView(state) : null;
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
          getOwnerConnection: () => this.getConnection(),
          connectWorker: async () => {
            const releaseWork = this.acquireWorkspaceWork();
            try {
              await this.getConnection();
              const instance = this.instance;
              if (!instance) throw new Error('CSV workspace is disposing.');
              return await instance.connect();
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
        workingCsv: await this.replaceOrThrow(workingCsvId, options),
      };
    } catch (error) {
      return { status: 'failed', failure: workingCsvFailure('replace-failed', error) };
    }
  }

  async replaceOrThrow(
    workingCsvId: WorkingCsvId,
    options: CsvDialectOptions = {},
  ): Promise<WorkingCsvView> {
    return this.withWorkingCsvLease(workingCsvId, async (existing) => {
      const state = await this.createWorkingCsv(
        existing.metadata.file.path,
        options,
        workingCsvId,
        existing.metadata.dataRevision,
        existing.nextRevisionId,
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
    const teardownFailures: Error[] = [];
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
      disposalFailure = asError(error);
    } finally {
      try {
        this.connection?.closeSync();
      } catch (error) {
        teardownFailures.push(asError(error));
      }
      this.connection = null;
      try {
        this.instance?.closeSync();
      } catch (error) {
        teardownFailures.push(asError(error));
      }
      this.instance = null;
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
    return state ? stateHasUnexportedChanges(state) : false;
  }

  getWithUnexportedChanges(): WorkingCsvView[] {
    return [...this.workingCsvs.values()]
      .filter(stateHasUnexportedChanges)
      .map(buildWorkingCsvView);
  }

  private async createWorkingCsv(
    filePath: string,
    options: CsvDialectOptions,
    logicalWorkingCsvId: WorkingCsvId = randomUUID(),
    dataRevision = 0,
    initialRevisionId = 0,
  ): Promise<WorkingCsvState> {
    const dialect = validateDialectOptions(options);

    const fileStats = await stat(filePath).catch((error: unknown) => {
      throw normalizeOpenError(error);
    });

    if (!fileStats.isFile()) {
      throw normalizeOpenError(new Error('Selected path is not a file.'));
    }

    if (!supportedFileExtensions.has(path.extname(filePath).toLowerCase())) {
      throw new CsvOpenError(
        'unsupported-file',
        'Unsupported file type. Choose a CSV, TSV, or text file.',
      );
    }

    const sourceIdentity = await captureFileIdentity(filePath);
    if (!sourceIdentity) throw normalizeOpenError(new Error('CSV Source is no longer available.'));
    const connection = await this.getConnection();
    const tableName = buildWorkingCsvTableName(randomUUID());
    this.artifactRegistry.register({
      tableName,
      owner: { kind: 'working-csv', workingCsvId: logicalWorkingCsvId },
      role: 'staging',
    });

    try {
      await connection.run(
        `CREATE TABLE ${quoteIdentifier(tableName)} AS SELECT CAST(row_number() OVER () AS VARCHAR) AS ${quoteIdentifier(
          csvInternalRowIdField,
        )}, row_number() OVER () AS ${quoteIdentifier(csvSourceOrderField)}, false AS ${quoteIdentifier(csvDeletedField)}, * FROM read_csv_auto(${buildReadCsvArguments(
          filePath,
          dialect,
        )})`,
      );

      const columns = await readColumns(connection, tableName);
      const rowCount = await readRowCount(connection, tableName);

      const metadata: Omit<WorkingCsvView, 'editState'> = {
        workingCsvId: logicalWorkingCsvId,
        dataRevision,
        file: {
          path: filePath,
          name: path.basename(filePath),
          sizeBytes: fileStats.size,
        },
        columns,
        rowCount,
        dialect,
      };

      return {
        metadata,
        connection,
        tableName,
        sourceIdentity,
        undoStack: [],
        redoStack: [],
        currentRevisionId: initialRevisionId,
        lastExportedRevisionId: initialRevisionId,
        nextRevisionId: initialRevisionId + 1,
      };
    } catch (error) {
      await this.dropWorkingCsvTable(tableName);
      this.artifactRegistry.remove(tableName);
      throw normalizeOpenError(error);
    }
  }

  getEditState(request: CsvEditStateRequest): CsvEditState {
    this.assertAcceptingWork();
    this.assertNotClosing(request.workingCsvId);
    return buildEditState(this.requireWorkingCsv(request.workingCsvId));
  }

  async isSourceDestination(workingCsvId: WorkingCsvId, filePath: string): Promise<boolean> {
    const state = this.requireWorkingCsv(workingCsvId);
    const destinationIdentity = await captureFileIdentity(filePath);
    return destinationIdentity ? sameFileIdentity(state.sourceIdentity, destinationIdentity) : false;
  }

  async getRows(request: CsvRowWindowRequest): Promise<CsvRowWindow> {
    const lease = this.acquireWorkingCsvLease(request.workingCsvId);
    try {
      const state = lease.state;
      const connection = this.requireConnection();
      const offset = validateWindowInteger(request.offset, 'offset');
      const limit = validateWindowInteger(request.limit, 'limit');

      if (limit > 1000) {
        throw new Error('Row window limit must be 1000 or less.');
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

      const countResult = await connection.runAndReadAll(query.countSql, query.values);
      const rowsResult = await connection.runAndReadAll(query.rowsSql, query.values);
      const [countRow] = countResult.getRowObjectsJS();

      return {
        workingCsvId: state.metadata.workingCsvId,
        offset,
        filteredRowCount: normalizeCount(countRow.filtered_row_count),
        rows: rowsResult.getRowObjectsJS().map(normalizeRow),
      };
    } finally {
      await lease.release();
    }
  }

  async getColumnValueCounts(request: CsvColumnValueCountsRequest): Promise<CsvColumnValueCounts> {
    const lease = this.acquireWorkingCsvLease(request.workingCsvId);
    try {
      const state = lease.state;
      const connection = this.requireConnection();
      const { metadata: session } = state;

      const knownColumns = new Set(session.columns.map((column) => column.name));
      assertKnownColumn(request.column, knownColumns);

      const query = buildColumnValueCountsQuery({
        tableName: state.tableName,
        columns: session.columns,
        column: request.column,
        filters: request.filters ?? [],
        search: request.search ?? '',
      });
      const countResult = await connection.runAndReadAll(query.sql, query.values);
      const rows = countResult.getRowObjectsJS();
      const scopeRowCount = rows.length > 0 ? normalizeCount(rows[0].scope_row_count) : 0;

      return {
        workingCsvId: session.workingCsvId,
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
    return this.withWorkingCsvLease(request.workingCsvId, async (state) => {
      const session = state.metadata;

      const knownColumns = new Set(session.columns.map((column) => column.name));
      assertKnownColumn(request.column, knownColumns);

      if (request.rowId.length === 0) {
        throw new Error('CSV row identifier is required.');
      }

      const existingValue = await readCellValue(state, request.rowId, request.column);

      await applyCellValue(state, request.rowId, request.column, request.value);
      state.undoStack.push({
        ...advanceRevision(state),
        type: 'cell-edit',
        rowId: request.rowId,
        column: request.column,
        oldValue: existingValue,
        newValue: request.value,
      });
      state.redoStack = [];
      this.commitDataChange(state);

      return {
        rowId: request.rowId,
        column: request.column,
        ...buildEditState(state),
      };
    });
  }

  async deleteRows(request: CsvDeleteRowsRequest): Promise<CsvEditState> {
    return this.withWorkingCsvLease(request.workingCsvId, async (state) => {
      const rowIds = normalizeRowIds(request.rowIds);

      if (rowIds.length === 0) {
        throw new Error('At least one CSV row must be selected for deletion.');
      }

      await assertRowsExist(state, rowIds);
      await applyRowDeletion(state, rowIds, true);
      state.undoStack.push({ ...advanceRevision(state), type: 'delete-rows', rowIds });
      state.redoStack = [];
      this.commitDataChange(state, -rowIds.length);

      return buildEditState(state);
    });
  }

  async insertRow(request: CsvInsertRowRequest): Promise<CsvEditState> {
    return this.withWorkingCsvLease(request.workingCsvId, async (state) => {
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

      const insertedRowId = await insertEmptyRow(state, request.placement, rowIds[0]);
      state.undoStack.push({ ...advanceRevision(state), type: 'insert-row', rowId: insertedRowId });
      state.redoStack = [];
      this.commitDataChange(state, 1);

      return buildEditState(state);
    });
  }

  async undo(workingCsvId: WorkingCsvId): Promise<CsvEditState> {
    return this.withWorkingCsvLease(workingCsvId, async (state) => {
      const command = state.undoStack.pop();

      if (!command) {
        throw new Error('No CSV edit is available to undo.');
      }

      await revertCommand(state, command);
      state.redoStack.push(command);
      state.currentRevisionId = command.previousRevisionId;
      this.commitDataChange(state, rowCountDelta(command, 'undo'));
      return buildEditState(state);
    });
  }

  async redo(workingCsvId: WorkingCsvId): Promise<CsvEditState> {
    return this.withWorkingCsvLease(workingCsvId, async (state) => {
      const command = state.redoStack.pop();

      if (!command) {
        throw new Error('No CSV edit is available to redo.');
      }

      await applyCommand(state, command);
      state.undoStack.push(command);
      state.currentRevisionId = command.revisionId;
      this.commitDataChange(state, rowCountDelta(command, 'redo'));
      return buildEditState(state);
    });
  }

  async exportCsv(workingCsvId: WorkingCsvId, filePath: string): Promise<CsvEditState> {
    return this.withWorkingCsvLease(workingCsvId, async (state) => {
      const { metadata: session } = state;
      if (await this.isSourceDestination(workingCsvId, filePath)) {
        throw new Error('Export CSV cannot replace its CSV Source. Choose a different destination.');
      }
      const connection = this.requireConnection();

      const rowProjectionSql = session.columns
        .map((column) => quoteIdentifier(column.name))
        .join(', ');
      const rowsResult = await connection.runAndReadAll(
        `SELECT ${rowProjectionSql} FROM ${quoteIdentifier(state.tableName)} WHERE ${quoteIdentifier(
          csvDeletedField,
        )} = false ORDER BY ${quoteIdentifier(csvSourceOrderField)} ASC`,
      );
      const rows = rowsResult.getRowObjectsJS();
      const delimiter = resolveOutputDelimiter(session);
      const lines: string[] = [];

      if (session.dialect.header !== false) {
        lines.push(
          session.columns.map((column) => serializeCsvField(column.name, delimiter)).join(delimiter),
        );
      }

      for (const row of rows) {
        lines.push(
          session.columns
            .map((column) => serializeCsvField(normalizeCellValue(row[column.name]) ?? '', delimiter))
            .join(delimiter),
        );
      }

      await writeFile(filePath, `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`, 'utf8');
      state.lastExportedRevisionId = state.currentRevisionId;

      return buildEditState(state);
    });
  }

  private async getConnection(): Promise<DuckDBConnection> {
    if (!this.instance) {
      this.instance = await DuckDBInstance.create(':memory:');
    }

    if (!this.connection) {
      this.connection = await this.instance.connect();
    }

    return this.connection;
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
    await this.dropRetiredSourceTableIfUnleased(tableName);
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

  private async dropRetiredSourceTableIfUnleased(tableName: string): Promise<void> {
    if (!this.sourceLeaseCounts.has(tableName)) await this.dropRetiredSourceTable(tableName);
  }

  private async dropRetiredSourceTable(tableName: string): Promise<void> {
    await this.dropWorkingCsvTable(tableName);
    this.artifactRegistry.remove(tableName);
    this.retiredSourceTables.delete(tableName);
  }

  private requireConnection(): DuckDBConnection {
    if (!this.connection) {
      throw new Error('CSV data store is not open.');
    }

    return this.connection;
  }

  private async dropWorkingCsvTable(tableName: string): Promise<void> {
    if (!this.connection) {
      return;
    }

    await this.connection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`);
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

async function readCellValue(
  state: WorkingCsvState,
  rowId: string,
  column: string,
): Promise<CsvCellValue> {
  const result = await state.connection.runAndReadAll(
    `SELECT ${quoteIdentifier(column)} AS cell_value FROM ${quoteIdentifier(state.tableName)} WHERE ${quoteIdentifier(
      csvInternalRowIdField,
    )} = ? AND ${quoteIdentifier(csvDeletedField)} = false`,
    [rowId],
  );
  const [row] = result.getRowObjectsJS();

  if (!row) {
    throw new Error('CSV row no longer exists.');
  }

  return normalizeCellValue(row.cell_value);
}

async function applyCellValue(
  state: WorkingCsvState,
  rowId: string,
  column: string,
  value: CsvCellValue,
): Promise<void> {
  await state.connection.run(
    `UPDATE ${quoteIdentifier(state.tableName)} SET ${quoteIdentifier(column)} = ? WHERE ${quoteIdentifier(
      csvInternalRowIdField,
    )} = ?`,
    [value, rowId],
  );
}

async function applyCommand(state: WorkingCsvState, command: CsvEditCommand): Promise<void> {
  if (command.type === 'cell-edit') {
    await applyCellValue(state, command.rowId, command.column, command.newValue);
    return;
  }

  if (command.type === 'delete-rows') {
    await applyRowDeletion(state, command.rowIds, true);
    return;
  }

  if (command.type === 'insert-row') {
    await applyRowDeletion(state, [command.rowId], false);
  }
}

async function revertCommand(state: WorkingCsvState, command: CsvEditCommand): Promise<void> {
  if (command.type === 'cell-edit') {
    await applyCellValue(state, command.rowId, command.column, command.oldValue);
    return;
  }

  if (command.type === 'delete-rows') {
    await applyRowDeletion(state, command.rowIds, false);
    return;
  }

  if (command.type === 'insert-row') {
    await applyRowDeletion(state, [command.rowId], true);
  }
}

async function insertEmptyRow(
  state: WorkingCsvState,
  placement: CsvInsertRowRequest['placement'],
  targetRowId: string | undefined,
): Promise<string> {
  const { connection, metadata: session } = state;
  const insertedRowId = await nextRowId(state);
  const sourceOrder = await resolveInsertionOrder(state, placement, targetRowId);

  if (placement !== 'append') {
    await connection.run(
      `UPDATE ${quoteIdentifier(state.tableName)} SET ${quoteIdentifier(csvSourceOrderField)} = ${quoteIdentifier(
        csvSourceOrderField,
      )} + 1 WHERE ${quoteIdentifier(csvSourceOrderField)} >= ?`,
      [sourceOrder],
    );
  }

  const insertColumns = [
    csvInternalRowIdField,
    csvSourceOrderField,
    csvDeletedField,
    ...session.columns.map((column) => column.name),
  ];
  const values = [insertedRowId, sourceOrder, false, ...session.columns.map(() => '')];

  await connection.run(
    `INSERT INTO ${quoteIdentifier(state.tableName)} (${insertColumns
      .map((column) => quoteIdentifier(column))
      .join(', ')}) VALUES (${buildPlaceholders(insertColumns.length)})`,
    values,
  );

  return insertedRowId;
}

async function nextRowId(state: WorkingCsvState): Promise<string> {
  const result = await state.connection.runAndReadAll(
    `SELECT coalesce(max(CAST(${quoteIdentifier(csvInternalRowIdField)} AS BIGINT)), 0)::BIGINT + 1 AS next_row_id FROM ${quoteIdentifier(state.tableName)}`,
  );
  const [row] = result.getRowObjectsJS();
  return String(row.next_row_id);
}

async function resolveInsertionOrder(
  state: WorkingCsvState,
  placement: CsvInsertRowRequest['placement'],
  targetRowId: string | undefined,
): Promise<number> {
  const connection = state.connection;

  if (placement === 'append') {
    const result = await connection.runAndReadAll(
      `SELECT coalesce(max(${quoteIdentifier(csvSourceOrderField)}), 0)::BIGINT + 1 AS source_order FROM ${quoteIdentifier(state.tableName)}`,
    );
    const [row] = result.getRowObjectsJS();
    return Number(row.source_order);
  }

  if (!targetRowId) {
    throw new Error('CSV row identifier is required for insertion.');
  }

  const result = await connection.runAndReadAll(
    `SELECT ${quoteIdentifier(csvSourceOrderField)} AS source_order FROM ${quoteIdentifier(state.tableName)} WHERE ${quoteIdentifier(
      csvInternalRowIdField,
    )} = ? AND ${quoteIdentifier(csvDeletedField)} = false`,
    [targetRowId],
  );
  const [row] = result.getRowObjectsJS();

  if (!row) {
    throw new Error(`CSV row no longer exists: ${targetRowId}`);
  }

  return Number(row.source_order) + (placement === 'below' ? 1 : 0);
}

async function assertRowsExist(state: WorkingCsvState, rowIds: string[]): Promise<void> {
  const result = await state.connection.runAndReadAll(
    `SELECT ${quoteIdentifier(csvInternalRowIdField)} AS row_id FROM ${quoteIdentifier(state.tableName)} WHERE ${quoteIdentifier(
      csvInternalRowIdField,
    )} IN (${buildPlaceholders(rowIds.length)}) AND ${quoteIdentifier(csvDeletedField)} = false`,
    rowIds,
  );
  const foundRowIds = new Set(result.getRowObjectsJS().map((row) => String(row.row_id)));
  const missingRowId = rowIds.find((rowId) => !foundRowIds.has(rowId));

  if (missingRowId) {
    throw new Error(`CSV row no longer exists: ${missingRowId}`);
  }
}

async function applyRowDeletion(
  state: WorkingCsvState,
  rowIds: string[],
  deleted: boolean,
): Promise<void> {
  await state.connection.run(
    `UPDATE ${quoteIdentifier(state.tableName)} SET ${quoteIdentifier(csvDeletedField)} = ? WHERE ${quoteIdentifier(
      csvInternalRowIdField,
    )} IN (${buildPlaceholders(rowIds.length)})`,
    [deleted, ...rowIds],
  );
}

function buildEditState(state: WorkingCsvState): CsvEditState {
  return {
    workingCsvId: state.metadata.workingCsvId,
    hasUnexportedChanges: stateHasUnexportedChanges(state),
    canUndo: state.undoStack.length > 0,
    canRedo: state.redoStack.length > 0,
  };
}

function stateHasUnexportedChanges(state: WorkingCsvState): boolean {
  return state.currentRevisionId !== state.lastExportedRevisionId;
}

function advanceRevision(state: WorkingCsvState): RevisionTransition {
  const transition = {
    previousRevisionId: state.currentRevisionId,
    revisionId: state.nextRevisionId,
  };
  state.currentRevisionId = transition.revisionId;
  state.nextRevisionId += 1;
  return transition;
}

function rowCountDelta(command: CsvEditCommand, direction: 'undo' | 'redo'): number {
  if (command.type === 'cell-edit') return 0;
  const redoDelta = command.type === 'delete-rows' ? -command.rowIds.length : 1;
  return direction === 'redo' ? redoDelta : -redoDelta;
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
      throw new Error('Delimiter must be exactly one character.');
    }

    dialect.delimiter = options.delimiter;
  }

  if (options.header !== undefined) {
    dialect.header = options.header;
  }

  return dialect;
}

function buildReadCsvArguments(filePath: string, dialect: CsvDialectOptions): string {
  const args = [quoteLiteral(filePath), 'all_varchar = true'];

  if (dialect.delimiter) {
    args.push(`delim = ${quoteLiteral(dialect.delimiter)}`);
  }

  if (dialect.header !== undefined) {
    args.push(`header = ${dialect.header ? 'true' : 'false'}`);
  }

  return args.join(', ');
}

function validateWindowInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Row window ${label} must be a non-negative integer.`);
  }

  return value;
}

function normalizeRow(row: Record<string, unknown>): CsvRow {
  const normalizedRow = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeCellValue(value)]),
  );

  const rowId = normalizedRow[csvInternalRowIdField];

  if (typeof rowId !== 'string' || rowId.length === 0) {
    throw new Error('CSV row is missing its internal row identifier.');
  }

  return normalizedRow as CsvRow;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function buildWorkingCsvTableName(physicalTableId: string): string {
  return `${workingCsvTablePrefix}${physicalTableId.replaceAll('-', '_')}`;
}

async function readColumns(connection: DuckDBConnection, tableName: string): Promise<CsvColumn[]> {
  const result = await connection.runAndReadAll(
    `DESCRIBE SELECT * FROM ${quoteIdentifier(tableName)}`,
  );
  return result
    .getRowObjectsJS()
    .filter(
      (row) =>
        !new Set([csvInternalRowIdField, csvSourceOrderField, csvDeletedField]).has(
          String(row.column_name),
        ),
    )
    .map((row) => ({
      name: String(row.column_name),
      type: String(row.column_type),
    }));
}

async function readRowCount(connection: DuckDBConnection, tableName: string): Promise<number> {
  const result = await connection.runAndReadAll(
    `SELECT count(*)::BIGINT AS row_count FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(csvDeletedField)} = false`,
  );
  const [row] = result.getRowObjectsJS();
  const value = row.row_count;

  if (typeof value === 'bigint') {
    return Number(value);
  }

  return Number(value);
}

class CsvOpenError extends Error {
  constructor(
    readonly code: 'missing-file' | 'permissions' | 'unsupported-file' | 'parse' | 'file-access',
    message: string,
  ) {
    super(message);
    this.name = 'CsvOpenError';
  }
}

function normalizeRowIds(rowIds: string[]): string[] {
  const normalizedRowIds = rowIds.map((rowId) => rowId.trim()).filter((rowId) => rowId.length > 0);
  return [...new Set(normalizedRowIds)];
}

function buildPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function resolveOutputDelimiter(session: Omit<WorkingCsvView, 'editState'>): string {
  if (session.dialect.delimiter) {
    return session.dialect.delimiter;
  }

  return path.extname(session.file.path).toLowerCase() === '.tsv' ? '\t' : ',';
}

function workingCsvFailure(
  code: WorkingCsvFailure['code'],
  error: unknown,
): WorkingCsvFailure {
  console.error(`Working CSV ${code} operation failed.`, error);
  return {
    code,
    message:
      code === 'open-failed'
        ? 'Unable to open the Working CSV.'
        : 'Unable to replace the Working CSV.',
    retryable: true,
  };
}

function unavailableWorkingCsvFailure(code: WorkingCsvFailure['code']): WorkingCsvFailure {
  return {
    code,
    message: 'The CSV workspace is closing.',
    retryable: false,
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function serializeCsvField(value: string, delimiter: string): string {
  if (
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r') ||
    value.includes(delimiter)
  ) {
    return `"${value.replaceAll('"', '""')}"`;
  }

  return value;
}

function normalizeOpenError(error: unknown): Error {
  if (error instanceof CsvOpenError) {
    return error;
  }

  if (error instanceof Error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError.code === 'ENOENT') {
      return new CsvOpenError('missing-file', 'Unable to open CSV: the file no longer exists.');
    }

    if (nodeError.code === 'EACCES' || nodeError.code === 'EPERM') {
      return new CsvOpenError(
        'permissions',
        'Unable to open CSV: permission was denied for this file.',
      );
    }

    if (/read_csv|csv|delimiter|quote|header|sniff|parse/i.test(error.message)) {
      return new CsvOpenError('parse', `Unable to parse CSV: ${error.message}`);
    }

    return new CsvOpenError('file-access', `Unable to open CSV: ${error.message}`);
  }

  return new CsvOpenError('file-access', 'Unable to open CSV.');
}
