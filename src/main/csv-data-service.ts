import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  CsvCellValue,
  CsvColumn,
  CsvDialectOptions,
  CsvFilterDescriptor,
  CsvRow,
  CsvRowWindow,
  CsvRowWindowRequest,
  CsvSortDescriptor,
  CsvSessionMetadata,
} from '../shared/ipc';

const viewName = 'active_csv';
const supportedFileExtensions = new Set(['.csv', '.tsv', '.txt']);

export class CsvDataService {
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private session: CsvSessionMetadata | null = null;
  private openOperationId = 0;

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
        `CREATE VIEW ${quoteIdentifier(viewName)} AS SELECT * FROM read_csv_auto(${buildReadCsvArguments(
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

  async closeActiveSession(): Promise<void> {
    this.session = null;

    if (this.connection) {
      this.connection.closeSync();
      this.connection = null;
    }

    if (this.instance) {
      this.instance.closeSync();
      this.instance = null;
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
  const args = [quoteLiteral(filePath)];

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
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeCellValue(value)]),
  );
}

function normalizeCellValue(value: unknown): CsvCellValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'bigint') {
    return Number(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
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
  const searchClause = buildSearchClause(columns, search, values);

  if (searchClause) {
    whereClauses.push(searchClause);
  }

  const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';
  const orderClauses = sort.map((descriptor) => buildSortClause(descriptor, knownColumns));
  const orderSql = orderClauses.length > 0 ? ` ORDER BY ${orderClauses.join(', ')}` : '';
  const fromSql = ` FROM ${quoteIdentifier(viewName)}${whereSql}`;

  return {
    countSql: `SELECT count(*)::BIGINT AS filtered_row_count${fromSql}`,
    rowsSql: `SELECT *${fromSql}${orderSql} LIMIT ${limit} OFFSET ${offset}`,
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
  switch (operator) {
    case 'equals':
      values.push(value ?? null);
      return `${columnSql} = ?`;
    case 'notEqual':
      values.push(value ?? null);
      return `(${columnSql} IS NULL OR ${columnSql} <> ?)`;
    case 'greaterThan':
      values.push(value ?? null);
      return `${columnSql} > ?`;
    case 'greaterThanOrEqual':
      values.push(value ?? null);
      return `${columnSql} >= ?`;
    case 'lessThan':
      values.push(value ?? null);
      return `${columnSql} < ?`;
    case 'lessThanOrEqual':
      values.push(value ?? null);
      return `${columnSql} <= ?`;
    case 'inRange':
      values.push(value ?? null, valueTo ?? null);
      return `${columnSql} BETWEEN ? AND ?`;
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
  const result = await connection.runAndReadAll(`DESCRIBE SELECT * FROM ${quoteIdentifier(viewName)}`);
  return result.getRowObjectsJS().map((row) => ({
    name: String(row.column_name),
    type: String(row.column_type),
  }));
}

async function readRowCount(connection: DuckDBConnection): Promise<number> {
  const result = await connection.runAndReadAll(
    `SELECT count(*)::BIGINT AS row_count FROM ${quoteIdentifier(viewName)}`,
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
