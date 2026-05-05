import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  CsvCellEditRequest,
  CsvCellEditResult,
  CsvCellValue,
  CsvColumn,
  CsvDeleteRowsRequest,
  CsvDialectOptions,
  CsvEditState,
  CsvEditStateRequest,
  CsvFilterDescriptor,
  CsvInsertRowRequest,
  CsvRow,
  CsvRowWindow,
  CsvRowWindowRequest,
  CsvSortDescriptor,
  CsvSessionMetadata,
} from '../shared/ipc';
import { csvInternalRowIdField } from '../shared/ipc';

const tableName = 'active_csv';
const csvDeletedField = '__csvViewerDeleted';
const csvSourceOrderField = '__csvViewerSourceOrder';
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

export class CsvDataService {
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private session: CsvSessionMetadata | null = null;
  private openOperationId = 0;
  private undoStack: CsvEditCommand[] = [];
  private redoStack: CsvEditCommand[] = [];

  async openCsv(filePath: string, options: CsvDialectOptions = {}): Promise<CsvSessionMetadata> {
    const operationId = this.openOperationId + 1;
    this.openOperationId = operationId;
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

    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();

    try {
      await connection.run(
        `CREATE TABLE ${quoteIdentifier(tableName)} AS SELECT CAST(row_number() OVER () AS VARCHAR) AS ${quoteIdentifier(
          csvInternalRowIdField,
        )}, row_number() OVER () AS ${quoteIdentifier(csvSourceOrderField)}, false AS ${quoteIdentifier(csvDeletedField)}, * FROM read_csv_auto(${buildReadCsvArguments(
          filePath,
          dialect,
        )})`,
      );

      const columns = await readColumns(connection);
      const rowCount = await readRowCount(connection);

      const session: CsvSessionMetadata = {
        sessionId: randomUUID(),
        file: {
          path: filePath,
          name: path.basename(filePath),
          sizeBytes: fileStats.size,
        },
        columns,
        rowCount,
        dialect,
      };

      if (operationId !== this.openOperationId) {
        connection.closeSync();
        instance.closeSync();
        throw new Error('CSV open was superseded by a newer request.');
      }

      await this.closeActiveSession();
      this.instance = instance;
      this.connection = connection;
      this.session = session;
      this.clearEditJournal();

      return session;
    } catch (error) {
      connection.closeSync();
      instance.closeSync();
      throw normalizeOpenError(error);
    }
  }

  getActiveSession(): CsvSessionMetadata | null {
    return this.session;
  }

  async reopenActiveCsv(options: CsvDialectOptions = {}): Promise<CsvSessionMetadata> {
    if (!this.session) {
      throw new Error('No active CSV session.');
    }

    const filePath = this.session.file.path;
    return this.openCsv(filePath, options);
  }

  getEditState(request: CsvEditStateRequest): CsvEditState {
    this.assertActiveSession(request.sessionId);
    return this.buildEditState();
  }

  async getRows(request: CsvRowWindowRequest): Promise<CsvRowWindow> {
    if (!this.session || !this.connection) {
      throw new Error('No active CSV session.');
    }

    if (request.sessionId !== this.session.sessionId) {
      throw new Error('CSV session is no longer active.');
    }

    const offset = validateWindowInteger(request.offset, 'offset');
    const limit = validateWindowInteger(request.limit, 'limit');

    if (limit > 1000) {
      throw new Error('Row window limit must be 1000 or less.');
    }

    const query = buildRowsQuery({
      columns: this.session.columns,
      filters: request.filters ?? [],
      search: request.search ?? '',
      sort: request.sort ?? [],
      limit,
      offset,
    });

    const countResult = await this.connection.runAndReadAll(query.countSql, query.values);
    const rowsResult = await this.connection.runAndReadAll(query.rowsSql, query.values);
    const [countRow] = countResult.getRowObjectsJS();

    return {
      sessionId: this.session.sessionId,
      offset,
      filteredRowCount: normalizeCount(countRow.filtered_row_count),
      rows: rowsResult.getRowObjectsJS().map(normalizeRow),
    };
  }

  async editCell(request: CsvCellEditRequest): Promise<CsvCellEditResult> {
    this.assertActiveSession(request.sessionId);
    const connection = this.connection;
    const session = this.session;

    if (!connection || !session) {
      throw new Error('No active CSV session.');
    }

    const knownColumns = new Set(session.columns.map((column) => column.name));
    assertKnownColumn(request.column, knownColumns);

    if (request.rowId.length === 0) {
      throw new Error('CSV row identifier is required.');
    }

    const existingValue = await this.readCellValue(request.rowId, request.column);

    await this.applyCellValue(request.rowId, request.column, request.value);
    this.undoStack.push({
      type: 'cell-edit',
      rowId: request.rowId,
      column: request.column,
      oldValue: existingValue,
      newValue: request.value,
    });
    this.redoStack = [];

    return {
      rowId: request.rowId,
      column: request.column,
      ...this.buildEditState(),
    };
  }

  async deleteRows(request: CsvDeleteRowsRequest): Promise<CsvEditState> {
    this.assertActiveSession(request.sessionId);

    const rowIds = normalizeRowIds(request.rowIds);

    if (rowIds.length === 0) {
      throw new Error('At least one CSV row must be selected for deletion.');
    }

    await this.assertRowsExist(rowIds);
    await this.applyRowDeletion(rowIds, true);
    this.undoStack.push({ type: 'delete-rows', rowIds });
    this.redoStack = [];

    return this.buildEditState();
  }

  async insertRow(request: CsvInsertRowRequest): Promise<CsvEditState> {
    this.assertActiveSession(request.sessionId);

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

    const insertedRowId = await this.insertEmptyRow(request.placement, rowIds[0]);
    this.undoStack.push({ type: 'insert-row', rowId: insertedRowId });
    this.redoStack = [];

    return this.buildEditState();
  }

  async undoEdit(request: CsvEditStateRequest): Promise<CsvEditState> {
    this.assertActiveSession(request.sessionId);
    const command = this.undoStack.pop();

    if (!command) {
      throw new Error('No CSV edit is available to undo.');
    }

    await this.revertCommand(command);
    this.redoStack.push(command);
    return this.buildEditState();
  }

  async redoEdit(request: CsvEditStateRequest): Promise<CsvEditState> {
    this.assertActiveSession(request.sessionId);
    const command = this.redoStack.pop();

    if (!command) {
      throw new Error('No CSV edit is available to redo.');
    }

    await this.applyCommand(command);
    this.undoStack.push(command);
    return this.buildEditState();
  }

  async closeActiveSession(): Promise<void> {
    this.session = null;
    this.clearEditJournal();

    if (this.connection) {
      this.connection.closeSync();
      this.connection = null;
    }

    if (this.instance) {
      this.instance.closeSync();
      this.instance = null;
    }
  }

  private async readCellValue(rowId: string, column: string): Promise<CsvCellValue> {
    const connection = this.connection;

    if (!connection) {
      throw new Error('No active CSV session.');
    }

    const result = await connection.runAndReadAll(
      `SELECT ${quoteIdentifier(column)} AS cell_value FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(
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

  private async applyCellValue(rowId: string, column: string, value: CsvCellValue): Promise<void> {
    const connection = this.connection;

    if (!connection) {
      throw new Error('No active CSV session.');
    }

    await connection.run(
      `UPDATE ${quoteIdentifier(tableName)} SET ${quoteIdentifier(column)} = ? WHERE ${quoteIdentifier(
        csvInternalRowIdField,
      )} = ?`,
      [value, rowId],
    );
  }

  private async applyCommand(command: CsvEditCommand): Promise<void> {
    if (command.type === 'cell-edit') {
      await this.applyCellValue(command.rowId, command.column, command.newValue);
      return;
    }

    if (command.type === 'delete-rows') {
      await this.applyRowDeletion(command.rowIds, true);
      return;
    }

    if (command.type === 'insert-row') {
      await this.applyRowDeletion([command.rowId], false);
    }
  }

  private async revertCommand(command: CsvEditCommand): Promise<void> {
    if (command.type === 'cell-edit') {
      await this.applyCellValue(command.rowId, command.column, command.oldValue);
      return;
    }

    if (command.type === 'delete-rows') {
      await this.applyRowDeletion(command.rowIds, false);
      return;
    }

    if (command.type === 'insert-row') {
      await this.applyRowDeletion([command.rowId], true);
    }
  }

  private async insertEmptyRow(
    placement: CsvInsertRowRequest['placement'],
    targetRowId: string | undefined,
  ): Promise<string> {
    const connection = this.connection;
    const session = this.session;

    if (!connection || !session) {
      throw new Error('No active CSV session.');
    }

    const insertedRowId = await this.nextRowId();
    const sourceOrder = await this.resolveInsertionOrder(placement, targetRowId);

    if (placement !== 'append') {
      await connection.run(
        `UPDATE ${quoteIdentifier(tableName)} SET ${quoteIdentifier(csvSourceOrderField)} = ${quoteIdentifier(
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
      `INSERT INTO ${quoteIdentifier(tableName)} (${insertColumns
        .map((column) => quoteIdentifier(column))
        .join(', ')}) VALUES (${buildPlaceholders(insertColumns.length)})`,
      values,
    );

    return insertedRowId;
  }

  private async nextRowId(): Promise<string> {
    const connection = this.connection;

    if (!connection) {
      throw new Error('No active CSV session.');
    }

    const result = await connection.runAndReadAll(
      `SELECT coalesce(max(CAST(${quoteIdentifier(csvInternalRowIdField)} AS BIGINT)), 0)::BIGINT + 1 AS next_row_id FROM ${quoteIdentifier(tableName)}`,
    );
    const [row] = result.getRowObjectsJS();
    return String(row.next_row_id);
  }

  private async resolveInsertionOrder(
    placement: CsvInsertRowRequest['placement'],
    targetRowId: string | undefined,
  ): Promise<number> {
    const connection = this.connection;

    if (!connection) {
      throw new Error('No active CSV session.');
    }

    if (placement === 'append') {
      const result = await connection.runAndReadAll(
        `SELECT coalesce(max(${quoteIdentifier(csvSourceOrderField)}), 0)::BIGINT + 1 AS source_order FROM ${quoteIdentifier(tableName)}`,
      );
      const [row] = result.getRowObjectsJS();
      return Number(row.source_order);
    }

    if (!targetRowId) {
      throw new Error('CSV row identifier is required for insertion.');
    }

    const result = await connection.runAndReadAll(
      `SELECT ${quoteIdentifier(csvSourceOrderField)} AS source_order FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(
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

  private async assertRowsExist(rowIds: string[]): Promise<void> {
    const connection = this.connection;

    if (!connection) {
      throw new Error('No active CSV session.');
    }

    const result = await connection.runAndReadAll(
      `SELECT ${quoteIdentifier(csvInternalRowIdField)} AS row_id FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(
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

  private async applyRowDeletion(rowIds: string[], deleted: boolean): Promise<void> {
    const connection = this.connection;

    if (!connection) {
      throw new Error('No active CSV session.');
    }

    await connection.run(
      `UPDATE ${quoteIdentifier(tableName)} SET ${quoteIdentifier(csvDeletedField)} = ? WHERE ${quoteIdentifier(
        csvInternalRowIdField,
      )} IN (${buildPlaceholders(rowIds.length)})`,
      [deleted, ...rowIds],
    );
  }

  private buildEditState(): CsvEditState {
    if (!this.session) {
      throw new Error('No active CSV session.');
    }

    return {
      sessionId: this.session.sessionId,
      dirty: this.undoStack.length > 0,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }

  private clearEditJournal(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  private assertActiveSession(sessionId: string): void {
    if (!this.session || !this.connection) {
      throw new Error('No active CSV session.');
    }

    if (sessionId !== this.session.sessionId) {
      throw new Error('CSV session is no longer active.');
    }
  }
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

function normalizeCellValue(value: unknown): CsvCellValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string') {
    return value;
  }

  return String(value);
}

type QueryParts = {
  rowsSql: string;
  countSql: string;
  values: Array<string | number | boolean | null>;
};

function buildRowsQuery({
  columns,
  filters,
  search,
  sort,
  limit,
  offset,
}: {
  columns: CsvColumn[];
  filters: CsvFilterDescriptor[];
  search: string;
  sort: CsvSortDescriptor[];
  limit: number;
  offset: number;
}): QueryParts {
  const knownColumns = new Set(columns.map((column) => column.name));
  const values: Array<string | number | boolean | null> = [];
  const whereClauses = filters.map((filter) => buildFilterClause(filter, knownColumns, values));
  whereClauses.push(`${quoteIdentifier(csvDeletedField)} = false`);
  const searchClause = buildSearchClause(columns, search, values);

  if (searchClause) {
    whereClauses.push(searchClause);
  }

  const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';
  const orderClauses = sort.map((descriptor) => buildSortClause(descriptor, knownColumns));
  const orderSql =
    orderClauses.length > 0
      ? ` ORDER BY ${orderClauses.join(', ')}`
      : ` ORDER BY ${quoteIdentifier(csvSourceOrderField)} ASC`;
  const fromSql = ` FROM ${quoteIdentifier(tableName)}${whereSql}`;
  const rowProjectionSql = [
    quoteIdentifier(csvInternalRowIdField),
    ...columns.map((column) => quoteIdentifier(column.name)),
  ].join(', ');

  return {
    countSql: `SELECT count(*)::BIGINT AS filtered_row_count${fromSql}`,
    rowsSql: `SELECT ${rowProjectionSql}${fromSql}${orderSql} LIMIT ${limit} OFFSET ${offset}`,
    values,
  };
}

function buildSearchClause(
  columns: CsvColumn[],
  search: string,
  values: Array<string | number | boolean | null>,
): string | null {
  const normalizedSearch = search.trim();

  if (normalizedSearch.length === 0) {
    return null;
  }

  const searchableColumns = columns.map((column) => quoteIdentifier(column.name));
  const pattern = `%${escapeLike(normalizedSearch)}%`;

  values.push(...searchableColumns.map(() => pattern));

  return `(${searchableColumns
    .map((columnSql) => `${castForText(columnSql)} ILIKE ? ESCAPE '\\'`)
    .join(' OR ')})`;
}

function buildSortClause(descriptor: CsvSortDescriptor, knownColumns: Set<string>): string {
  assertKnownColumn(descriptor.column, knownColumns);
  return `${quoteIdentifier(descriptor.column)} ${descriptor.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
}

function buildFilterClause(
  filter: CsvFilterDescriptor,
  knownColumns: Set<string>,
  values: Array<string | number | boolean | null>,
): string {
  assertKnownColumn(filter.column, knownColumns);
  const columnSql = quoteIdentifier(filter.column);

  if (filter.operator === 'blank') {
    return `(${columnSql} IS NULL OR ${castForText(columnSql)} = '')`;
  }

  if (filter.operator === 'notBlank') {
    return `(${columnSql} IS NOT NULL AND ${castForText(columnSql)} <> '')`;
  }

  if (filter.kind === 'text') {
    return buildTextFilterClause(columnSql, filter.operator, filter.value ?? '', values);
  }

  if (filter.kind === 'number') {
    return buildScalarFilterClause(columnSql, filter.operator, filter.value, filter.valueTo, values);
  }

  return buildScalarFilterClause(columnSql, filter.operator, filter.value, filter.valueTo, values);
}

function buildTextFilterClause(
  columnSql: string,
  operator: Exclude<CsvFilterDescriptor & { kind: 'text' }, never>['operator'],
  value: string,
  values: Array<string | number | boolean | null>,
): string {
  const textSql = castForText(columnSql);

  switch (operator) {
    case 'contains':
      values.push(`%${escapeLike(value)}%`);
      return `${textSql} ILIKE ? ESCAPE '\\'`;
    case 'notContains':
      values.push(`%${escapeLike(value)}%`);
      return `(${columnSql} IS NULL OR ${textSql} NOT ILIKE ? ESCAPE '\\')`;
    case 'equals':
      values.push(value);
      return `${textSql} = ?`;
    case 'notEqual':
      values.push(value);
      return `(${columnSql} IS NULL OR ${textSql} <> ?)`;
    case 'startsWith':
      values.push(`${escapeLike(value)}%`);
      return `${textSql} ILIKE ? ESCAPE '\\'`;
    case 'endsWith':
      values.push(`%${escapeLike(value)}`);
      return `${textSql} ILIKE ? ESCAPE '\\'`;
    default:
      throw new Error(`Unsupported text filter operator: ${operator}`);
  }
}

function buildScalarFilterClause(
  columnSql: string,
  operator: string,
  value: string | number | undefined,
  valueTo: string | number | undefined,
  values: Array<string | number | boolean | null>,
): string {
  const textSql = castForText(columnSql);
  const textValue = value === undefined ? null : String(value);
  const textValueTo = valueTo === undefined ? null : String(valueTo);

  switch (operator) {
    case 'equals':
      values.push(textValue);
      return `${textSql} = ?`;
    case 'notEqual':
      values.push(textValue);
      return `(${columnSql} IS NULL OR ${textSql} <> ?)`;
    case 'greaterThan':
      values.push(textValue);
      return `${textSql} > ?`;
    case 'greaterThanOrEqual':
      values.push(textValue);
      return `${textSql} >= ?`;
    case 'lessThan':
      values.push(textValue);
      return `${textSql} < ?`;
    case 'lessThanOrEqual':
      values.push(textValue);
      return `${textSql} <= ?`;
    case 'inRange':
      values.push(textValue, textValueTo);
      return `${textSql} BETWEEN ? AND ?`;
    default:
      throw new Error(`Unsupported scalar filter operator: ${operator}`);
  }
}

function assertKnownColumn(column: string, knownColumns: Set<string>): void {
  if (!knownColumns.has(column)) {
    throw new Error(`Unknown CSV column: ${column}`);
  }
}

function castForText(columnSql: string): string {
  return `coalesce(CAST(${columnSql} AS VARCHAR), '')`;
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function normalizeCount(value: unknown): number {
  if (typeof value === 'bigint') {
    return Number(value);
  }

  return Number(value);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function readColumns(connection: DuckDBConnection): Promise<CsvColumn[]> {
  const result = await connection.runAndReadAll(`DESCRIBE SELECT * FROM ${quoteIdentifier(tableName)}`);
  return result
    .getRowObjectsJS()
    .filter((row) => !new Set([csvInternalRowIdField, csvSourceOrderField, csvDeletedField]).has(String(row.column_name)))
    .map((row) => ({
      name: String(row.column_name),
      type: String(row.column_type),
    }));
}

async function readRowCount(connection: DuckDBConnection): Promise<number> {
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
