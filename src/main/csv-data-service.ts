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
  CsvSessionMetadata,
} from '../shared/ipc';
import { csvInternalRowIdField } from '../shared/ipc';
import type { ComparisonExecutor } from './comparison-executor';
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

const sessionTablePrefix = 'csv_session_';
const supportedFileExtensions = new Set(['.csv', '.tsv', '.txt']);

type CsvEditCommand =
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
    };

type CsvSessionState = {
  metadata: CsvSessionMetadata;
  connection: DuckDBConnection;
  tableName: string;
  undoStack: CsvEditCommand[];
  redoStack: CsvEditCommand[];
};

export class CsvDataService {
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private sessions = new Map<string, CsvSessionState>();
  private dataChangeListeners = new Set<(sessionId: string) => void>();
  private closingSessions = new Set<string>();
  private comparisonExecutor: ComparisonExecutor | null = null;

  async openCsv(filePath: string, options: CsvDialectOptions = {}): Promise<CsvSessionMetadata> {
    if (this.findSessionByPath(filePath)) {
      throw new Error('CSV file is already open.');
    }

    const state = await this.createSession(filePath, options);
    this.sessions.set(state.metadata.sessionId, state);
    return state.metadata;
  }

  findSessionByPath(filePath: string): CsvSessionMetadata | null {
    const normalizedPath = path.resolve(filePath);

    for (const state of this.sessions.values()) {
      if (path.resolve(state.metadata.file.path) === normalizedPath) {
        return state.metadata;
      }
    }

    return null;
  }

  getSession(sessionId: string): CsvSessionMetadata | null {
    return this.sessions.get(sessionId)?.metadata ?? null;
  }

  listSessions(): CsvSessionMetadata[] {
    return [...this.sessions.values()].map((state) => state.metadata);
  }

  subscribeToDataChanges(listener: (sessionId: string) => void): () => void {
    this.dataChangeListeners.add(listener);
    return () => this.dataChangeListeners.delete(listener);
  }

  isClosing(sessionId: string): boolean {
    return this.closingSessions.has(sessionId);
  }

  beginClose(sessionId: string): boolean {
    if (!this.sessions.has(sessionId) || this.closingSessions.has(sessionId)) return false;
    this.closingSessions.add(sessionId);
    return true;
  }

  endClose(sessionId: string): void {
    this.closingSessions.delete(sessionId);
  }

  createComparisonExecutor(): ComparisonExecutor {
    if (!this.comparisonExecutor) {
      this.comparisonExecutor = new DuckDbComparisonExecutor({
        getSource: (sessionId) => {
          const state = this.requireSession(sessionId);
          return { tableName: state.tableName, columns: state.metadata.columns };
        },
        getOwnerConnection: () => this.getConnection(),
        connectWorker: async () => {
          await this.getConnection();
          return this.instance!.connect();
        },
      });
    }
    return this.comparisonExecutor;
  }

  async reopenSession(
    sessionId: string,
    options: CsvDialectOptions = {},
  ): Promise<CsvSessionMetadata> {
    this.assertNotClosing(sessionId);
    const existing = this.requireSession(sessionId);
    const state = await this.createSession(
      existing.metadata.file.path,
      options,
      sessionId,
      existing.metadata.dataRevision + 1,
    );
    try {
      await this.dropSessionTable(existing.tableName);
    } catch (error) {
      await this.dropSessionTable(state.tableName).catch(() => undefined);
      throw error;
    }
    this.sessions.set(sessionId, state);
    this.notifyDataChange(sessionId);
    return state.metadata;
  }

  async closeSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);

    if (!state) {
      return;
    }

    await this.dropSessionTable(state.tableName);
    this.sessions.delete(sessionId);
    this.closingSessions.delete(sessionId);
  }

  async closeAllSessions(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) {
      await this.closeSession(sessionId);
    }

    this.connection?.closeSync();
    this.connection = null;
    this.instance?.closeSync();
    this.instance = null;
  }

  isDirty(sessionId: string): boolean {
    return (this.sessions.get(sessionId)?.undoStack.length ?? 0) > 0;
  }

  getDirtySessions(): CsvSessionMetadata[] {
    return [...this.sessions.values()]
      .filter((state) => state.undoStack.length > 0)
      .map((state) => state.metadata);
  }

  private async createSession(
    filePath: string,
    options: CsvDialectOptions,
    logicalSessionId: string = randomUUID(),
    dataRevision = 0,
  ): Promise<CsvSessionState> {
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

    const connection = await this.getConnection();
    const tableName = buildSessionTableName(randomUUID());

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

      const metadata: CsvSessionMetadata = {
        sessionId: logicalSessionId,
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
        undoStack: [],
        redoStack: [],
      };
    } catch (error) {
      await this.dropSessionTable(tableName);
      throw normalizeOpenError(error);
    }
  }

  getEditState(request: CsvEditStateRequest): CsvEditState {
    return buildEditState(this.requireSession(request.sessionId));
  }

  async getRows(request: CsvRowWindowRequest): Promise<CsvRowWindow> {
    const state = this.requireSession(request.sessionId);
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
      sessionId: state.metadata.sessionId,
      offset,
      filteredRowCount: normalizeCount(countRow.filtered_row_count),
      rows: rowsResult.getRowObjectsJS().map(normalizeRow),
    };
  }

  async getColumnValueCounts(request: CsvColumnValueCountsRequest): Promise<CsvColumnValueCounts> {
    const state = this.requireSession(request.sessionId);
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
      sessionId: session.sessionId,
      column: request.column,
      scopeRowCount,
      values: rows.map((row) => ({
        value: normalizeCellValue(row.counted_value),
        count: normalizeCount(row.value_count),
        percentOfScope: Number(row.percent_of_scope),
      })),
    };
  }

  async editCell(request: CsvCellEditRequest): Promise<CsvCellEditResult> {
    this.assertNotClosing(request.sessionId);
    const state = this.requireSession(request.sessionId);
    const session = state.metadata;

    const knownColumns = new Set(session.columns.map((column) => column.name));
    assertKnownColumn(request.column, knownColumns);

    if (request.rowId.length === 0) {
      throw new Error('CSV row identifier is required.');
    }

    const existingValue = await readCellValue(state, request.rowId, request.column);

    await applyCellValue(state, request.rowId, request.column, request.value);
    state.undoStack.push({
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
  }

  async deleteRows(request: CsvDeleteRowsRequest): Promise<CsvEditState> {
    this.assertNotClosing(request.sessionId);
    const state = this.requireSession(request.sessionId);

    const rowIds = normalizeRowIds(request.rowIds);

    if (rowIds.length === 0) {
      throw new Error('At least one CSV row must be selected for deletion.');
    }

    await assertRowsExist(state, rowIds);
    await applyRowDeletion(state, rowIds, true);
    state.undoStack.push({ type: 'delete-rows', rowIds });
    state.redoStack = [];
    this.commitDataChange(state);

    return buildEditState(state);
  }

  async insertRow(request: CsvInsertRowRequest): Promise<CsvEditState> {
    this.assertNotClosing(request.sessionId);
    const state = this.requireSession(request.sessionId);

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
    state.undoStack.push({ type: 'insert-row', rowId: insertedRowId });
    state.redoStack = [];
    this.commitDataChange(state);

    return buildEditState(state);
  }

  async undoEdit(request: CsvEditStateRequest): Promise<CsvEditState> {
    this.assertNotClosing(request.sessionId);
    const state = this.requireSession(request.sessionId);
    const command = state.undoStack.pop();

    if (!command) {
      throw new Error('No CSV edit is available to undo.');
    }

    await revertCommand(state, command);
    state.redoStack.push(command);
    this.commitDataChange(state);
    return buildEditState(state);
  }

  async redoEdit(request: CsvEditStateRequest): Promise<CsvEditState> {
    this.assertNotClosing(request.sessionId);
    const state = this.requireSession(request.sessionId);
    const command = state.redoStack.pop();

    if (!command) {
      throw new Error('No CSV edit is available to redo.');
    }

    await applyCommand(state, command);
    state.undoStack.push(command);
    this.commitDataChange(state);
    return buildEditState(state);
  }

  async saveAs(request: CsvEditStateRequest, filePath: string): Promise<CsvEditState> {
    const state = this.requireSession(request.sessionId);
    const connection = this.requireConnection();
    const { metadata: session } = state;

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
    state.undoStack = [];
    state.redoStack = [];

    return buildEditState(state);
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

  private requireConnection(): DuckDBConnection {
    if (!this.connection) {
      throw new Error('CSV data store is not open.');
    }

    return this.connection;
  }

  private async dropSessionTable(tableName: string): Promise<void> {
    if (!this.connection) {
      return;
    }

    await this.connection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`);
  }

  private requireSession(sessionId: string): CsvSessionState {
    const state = this.sessions.get(sessionId);

    if (!state) {
      throw new Error('CSV session is no longer active.');
    }

    return state;
  }

  private assertNotClosing(sessionId: string): void {
    if (this.closingSessions.has(sessionId)) {
      throw new Error('CSV session is closing.');
    }
  }

  private commitDataChange(state: CsvSessionState): void {
    state.metadata = { ...state.metadata, dataRevision: state.metadata.dataRevision + 1 };
    this.notifyDataChange(state.metadata.sessionId);
  }

  private notifyDataChange(sessionId: string): void {
    for (const listener of this.dataChangeListeners) listener(sessionId);
  }
}

async function readCellValue(
  state: CsvSessionState,
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
  state: CsvSessionState,
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

async function applyCommand(state: CsvSessionState, command: CsvEditCommand): Promise<void> {
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

async function revertCommand(state: CsvSessionState, command: CsvEditCommand): Promise<void> {
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
  state: CsvSessionState,
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

async function nextRowId(state: CsvSessionState): Promise<string> {
  const result = await state.connection.runAndReadAll(
    `SELECT coalesce(max(CAST(${quoteIdentifier(csvInternalRowIdField)} AS BIGINT)), 0)::BIGINT + 1 AS next_row_id FROM ${quoteIdentifier(state.tableName)}`,
  );
  const [row] = result.getRowObjectsJS();
  return String(row.next_row_id);
}

async function resolveInsertionOrder(
  state: CsvSessionState,
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

async function assertRowsExist(state: CsvSessionState, rowIds: string[]): Promise<void> {
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
  state: CsvSessionState,
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

function buildEditState(state: CsvSessionState): CsvEditState {
  return {
    sessionId: state.metadata.sessionId,
    dirty: state.undoStack.length > 0,
    canUndo: state.undoStack.length > 0,
    canRedo: state.redoStack.length > 0,
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

function buildSessionTableName(sessionId: string): string {
  return `${sessionTablePrefix}${sessionId.replaceAll('-', '_')}`;
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

function resolveOutputDelimiter(session: CsvSessionMetadata): string {
  if (session.dialect.delimiter) {
    return session.dialect.delimiter;
  }

  return path.extname(session.file.path).toLowerCase() === '.tsv' ? '\t' : ',';
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
