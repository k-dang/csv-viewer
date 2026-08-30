import type {
  CsvCellValue,
  CsvColumn,
  CsvDialectOptions,
  CsvFilterDescriptor,
  CsvSortDescriptor,
} from '../shared/csv-viewer-contract';
import { csvInternalRowIdField } from '../shared/csv-viewer-contract';
import { csvDeletedField, csvSourceOrderField } from './csv-storage-schema';

export type QueryValues = Array<string | number | boolean | null>;

export type CsvStatement = { sql: string; values: QueryValues };

export function buildCreateWorkingCsvTableSql(
  tableName: string,
  engineSourceReference: string,
  dialect: CsvDialectOptions,
): string {
  const readArguments = [quoteLiteral(engineSourceReference), 'all_varchar = true'];
  if (dialect.delimiter) readArguments.push(`delim = ${quoteLiteral(dialect.delimiter)}`);
  if (dialect.header !== undefined) {
    readArguments.push(`header = ${dialect.header ? 'true' : 'false'}`);
  }

  return `CREATE TABLE ${quoteIdentifier(tableName)} AS SELECT CAST(row_number() OVER () AS VARCHAR) AS ${quoteIdentifier(
    csvInternalRowIdField,
  )}, row_number() OVER () AS ${quoteIdentifier(csvSourceOrderField)}, false AS ${quoteIdentifier(
    csvDeletedField,
  )}, * FROM read_csv_auto(${readArguments.join(', ')})`;
}

export function buildDescribeColumnsSql(tableName: string): string {
  return `DESCRIBE SELECT * FROM ${quoteIdentifier(tableName)}`;
}

export function buildRowCountSql(tableName: string): string {
  return `SELECT count(*)::BIGINT AS row_count FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(
    csvDeletedField,
  )} = false`;
}

export function buildDropTableSql(tableName: string): string {
  return `DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`;
}

export function buildCellValueQuery(
  tableName: string,
  rowId: string,
  column: string,
): CsvStatement {
  return {
    sql: `SELECT ${quoteIdentifier(column)} AS cell_value FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(
      csvInternalRowIdField,
    )} = ? AND ${quoteIdentifier(csvDeletedField)} = false`,
    values: [rowId],
  };
}

export function buildCellUpdateStatement(
  tableName: string,
  rowId: string,
  column: string,
  value: CsvCellValue,
): CsvStatement {
  return {
    sql: `UPDATE ${quoteIdentifier(tableName)} SET ${quoteIdentifier(column)} = ? WHERE ${quoteIdentifier(
      csvInternalRowIdField,
    )} = ?`,
    values: [value, rowId],
  };
}

export function buildRowDeletionStatement(
  tableName: string,
  rowIds: string[],
  deleted: boolean,
): CsvStatement {
  assertRowIds(rowIds);
  return {
    sql: `UPDATE ${quoteIdentifier(tableName)} SET ${quoteIdentifier(csvDeletedField)} = ? WHERE ${quoteIdentifier(
      csvInternalRowIdField,
    )} IN (${buildPlaceholders(rowIds.length)})`,
    values: [deleted, ...rowIds],
  };
}

export function buildExistingRowIdsQuery(tableName: string, rowIds: string[]): CsvStatement {
  assertRowIds(rowIds);
  return {
    sql: `SELECT ${quoteIdentifier(csvInternalRowIdField)} AS row_id FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(
      csvInternalRowIdField,
    )} IN (${buildPlaceholders(rowIds.length)}) AND ${quoteIdentifier(csvDeletedField)} = false`,
    values: rowIds,
  };
}

export function buildNextRowIdSql(tableName: string): string {
  return `SELECT coalesce(max(CAST(${quoteIdentifier(csvInternalRowIdField)} AS BIGINT)), 0)::BIGINT + 1 AS next_row_id FROM ${quoteIdentifier(tableName)}`;
}

export function buildAppendSourceOrderSql(tableName: string): string {
  return `SELECT coalesce(max(${quoteIdentifier(csvSourceOrderField)}), 0)::BIGINT + 1 AS source_order FROM ${quoteIdentifier(tableName)}`;
}

export function buildRowSourceOrderQuery(tableName: string, rowId: string): CsvStatement {
  return {
    sql: `SELECT ${quoteIdentifier(csvSourceOrderField)} AS source_order FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(
      csvInternalRowIdField,
    )} = ? AND ${quoteIdentifier(csvDeletedField)} = false`,
    values: [rowId],
  };
}

export function buildSourceOrderShiftStatement(
  tableName: string,
  fromSourceOrder: number,
): CsvStatement {
  return {
    sql: `UPDATE ${quoteIdentifier(tableName)} SET ${quoteIdentifier(csvSourceOrderField)} = ${quoteIdentifier(
      csvSourceOrderField,
    )} + 1 WHERE ${quoteIdentifier(csvSourceOrderField)} >= ?`,
    values: [fromSourceOrder],
  };
}

export function buildEmptyRowInsertStatement({
  tableName,
  columns,
  rowId,
  sourceOrder,
}: {
  tableName: string;
  columns: CsvColumn[];
  rowId: string;
  sourceOrder: number;
}): CsvStatement {
  const insertColumns = [
    csvInternalRowIdField,
    csvSourceOrderField,
    csvDeletedField,
    ...columns.map((column) => column.name),
  ];

  return {
    sql: `INSERT INTO ${quoteIdentifier(tableName)} (${insertColumns
      .map((column) => quoteIdentifier(column))
      .join(', ')}) VALUES (${buildPlaceholders(insertColumns.length)})`,
    values: [rowId, sourceOrder, false, ...columns.map(() => '')],
  };
}

export function buildExportRowsSql(tableName: string, columns: CsvColumn[]): string {
  const projection = columns.map((column) => quoteIdentifier(column.name)).join(', ');
  return `SELECT ${projection} FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(
    csvDeletedField,
  )} = false ORDER BY ${quoteIdentifier(csvSourceOrderField)} ASC`;
}

export function buildRowsQuery({
  tableName,
  columns,
  filters,
  search,
  sort,
  limit,
  offset,
}: {
  tableName: string;
  columns: CsvColumn[];
  filters: CsvFilterDescriptor[];
  search: string;
  sort: CsvSortDescriptor[];
  limit: number;
  offset: number;
}) {
  const knownColumns = new Set(columns.map((column) => column.name));
  const scope = buildCountScopeWhere({ columns, filters, search });
  const orderClauses = sort.map((descriptor) => buildSortClause(descriptor, knownColumns));
  const orderSql =
    orderClauses.length > 0
      ? ` ORDER BY ${orderClauses.join(', ')}`
      : ` ORDER BY ${quoteIdentifier(csvSourceOrderField)} ASC`;
  const fromSql = ` FROM ${quoteIdentifier(tableName)}${scope.whereSql}`;
  const rowProjectionSql = [
    quoteIdentifier(csvInternalRowIdField),
    ...columns.map((column) => quoteIdentifier(column.name)),
  ].join(', ');

  return {
    countSql: `SELECT count(*)::BIGINT AS filtered_row_count${fromSql}`,
    rowsSql: `SELECT ${rowProjectionSql}${fromSql}${orderSql} LIMIT ${limit} OFFSET ${offset}`,
    values: scope.values,
  };
}

export function buildColumnValueCountsQuery({
  tableName,
  columns,
  column,
  filters,
  search,
}: {
  tableName: string;
  columns: CsvColumn[];
  column: string;
  filters: CsvFilterDescriptor[];
  search: string;
}) {
  assertKnownColumn(column, new Set(columns.map((knownColumn) => knownColumn.name)));
  const scope = buildCountScopeWhere({ columns, filters, search });
  const countedValueSql = quoteIdentifier(column);

  return {
    sql: `WITH scoped_rows AS (
      SELECT ${countedValueSql} AS counted_value
      FROM ${quoteIdentifier(tableName)}${scope.whereSql}
    ),
    counted_values AS (
      SELECT counted_value, count(*)::BIGINT AS value_count
      FROM scoped_rows
      GROUP BY counted_value
    ),
    scoped_total AS (
      SELECT count(*)::BIGINT AS scope_row_count
      FROM scoped_rows
    )
    SELECT counted_values.counted_value,
      counted_values.value_count,
      scoped_total.scope_row_count,
      CASE
        WHEN scoped_total.scope_row_count = 0 THEN 0
        ELSE (counted_values.value_count::DOUBLE / scoped_total.scope_row_count::DOUBLE) * 100
      END AS percent_of_scope
    FROM counted_values
    CROSS JOIN scoped_total
    ORDER BY counted_values.value_count DESC, counted_values.counted_value ASC NULLS FIRST
    LIMIT 50`,
    values: scope.values,
  };
}

function buildCountScopeWhere({
  columns,
  filters,
  search,
}: {
  columns: CsvColumn[];
  filters: CsvFilterDescriptor[];
  search: string;
}) {
  const knownColumns = new Set(columns.map((column) => column.name));
  const values: QueryValues = [];
  const whereClauses = filters.map((filter) => buildFilterClause(filter, knownColumns, values));
  whereClauses.push(`${quoteIdentifier(csvDeletedField)} = false`);
  const searchClause = buildSearchClause(columns, search, values);
  if (searchClause) whereClauses.push(searchClause);
  return { whereSql: ` WHERE ${whereClauses.join(' AND ')}`, values };
}

function buildSortClause(descriptor: CsvSortDescriptor, knownColumns: Set<string>): string {
  assertKnownColumn(descriptor.column, knownColumns);
  return `${quoteIdentifier(descriptor.column)} ${descriptor.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
}

export function assertKnownColumn(column: string, knownColumns: Set<string>): void {
  if (!knownColumns.has(column)) throw new Error(`Unknown CSV column: ${column}`);
}

/** The most rows any single row-window request may return, for CSV rows and Comparison rows alike. */
export const maxRowWindowLimit = 1000;

/** The one definition of a well-formed row window. Callers phrase their own rejection. */
export function isValidRowWindow(offset: number, limit: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    Number.isSafeInteger(limit) &&
    limit >= 0 &&
    limit <= maxRowWindowLimit
  );
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** An empty list would render `IN ()`, which the engine rejects as a syntax error. */
function assertRowIds(rowIds: string[]): void {
  if (rowIds.length === 0) throw new Error('At least one CSV row is required.');
}

function buildPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function buildSearchClause(
  columns: CsvColumn[],
  search: string,
  values: QueryValues,
): string | null {
  const normalizedSearch = search.trim();
  if (normalizedSearch.length === 0) return null;
  const searchableColumns = columns.map((column) => quoteIdentifier(column.name));
  const pattern = `%${escapeLike(normalizedSearch)}%`;
  values.push(...searchableColumns.map(() => pattern));
  return `(${searchableColumns.map((columnSql) => `${castForText(columnSql)} ILIKE ? ESCAPE '\\'`).join(' OR ')})`;
}

function buildFilterClause(
  filter: CsvFilterDescriptor,
  knownColumns: Set<string>,
  values: QueryValues,
): string {
  assertKnownColumn(filter.column, knownColumns);
  const columnSql = quoteIdentifier(filter.column);
  if (filter.operator === 'blank')
    return `(${columnSql} IS NULL OR ${castForText(columnSql)} = '')`;
  if (filter.operator === 'notBlank')
    return `(${columnSql} IS NOT NULL AND ${castForText(columnSql)} <> '')`;
  if (filter.kind === 'text') {
    return buildTextFilterClause(columnSql, filter.operator, filter.value ?? '', values);
  }
  return buildScalarFilterClause(columnSql, filter.operator, filter.value, filter.valueTo, values);
}

function buildTextFilterClause(
  columnSql: string,
  operator: Extract<CsvFilterDescriptor, { kind: 'text' }>['operator'],
  value: string,
  values: QueryValues,
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
  values: QueryValues,
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

function castForText(columnSql: string): string {
  return `coalesce(CAST(${columnSql} AS VARCHAR), '')`;
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
