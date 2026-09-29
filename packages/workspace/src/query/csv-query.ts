import type {
  CsvCellValue,
  CsvColumn,
  CsvDateFilterOperator,
  CsvDialectOptions,
  CsvFilterDescriptor,
  CsvNumberFilterOperator,
  CsvSortDescriptor,
  CsvTextFilterOperator,
} from '../csv-viewer';
import { Result } from 'effect';
import { csvInternalRowIdField } from '../csv-viewer';
import { WorkspaceRequestError } from '../errors';
import { csvDeletedField, csvSourceOrderField } from '../working-csv/csv-storage-schema';

export type QueryValues = Array<string | number | boolean | null>;

export type CsvStatement = { sql: string; values: QueryValues };

/** Query construction stays synchronous; an expected rejection is a failure value, not a throw. */
export type QueryBuild<A> = Result.Result<A, WorkspaceRequestError>;

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

export function buildRenameColumnStatement(tableName: string, from: string, to: string): string {
  return `ALTER TABLE ${quoteIdentifier(tableName)} RENAME COLUMN ${quoteIdentifier(from)} TO ${quoteIdentifier(to)}`;
}

/** Existing rows receive ''. Without the default, DuckDB would write NULL. */
export function buildAddColumnStatement(tableName: string, name: string): string {
  return `ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${quoteIdentifier(name)} VARCHAR DEFAULT ''`;
}

export function buildDropColumnStatement(tableName: string, name: string): string {
  return `ALTER TABLE ${quoteIdentifier(tableName)} DROP COLUMN ${quoteIdentifier(name)}`;
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
): QueryBuild<CsvStatement> {
  return Result.map(requireRowIds(rowIds), () => ({
    sql: `UPDATE ${quoteIdentifier(tableName)} SET ${quoteIdentifier(csvDeletedField)} = ? WHERE ${quoteIdentifier(
      csvInternalRowIdField,
    )} IN (${buildPlaceholders(rowIds.length)})`,
    values: [deleted, ...rowIds],
  }));
}

export function buildExistingRowIdsQuery(tableName: string, rowIds: string[]): QueryBuild<CsvStatement> {
  return Result.map(requireRowIds(rowIds), () => ({
    sql: `SELECT ${quoteIdentifier(csvInternalRowIdField)} AS row_id FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(
      csvInternalRowIdField,
    )} IN (${buildPlaceholders(rowIds.length)}) AND ${quoteIdentifier(csvDeletedField)} = false`,
    values: rowIds,
  }));
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
  filters: readonly CsvFilterDescriptor[];
  search: string;
  sort: readonly CsvSortDescriptor[];
  limit: number;
  offset: number;
}): QueryBuild<{ countSql: string; rowsSql: string; values: QueryValues }> {
  return Result.gen(function* () {
    const knownColumns = new Set(columns.map((column) => column.name));
    const scope = yield* buildCountScopeWhere({ columns, knownColumns, filters, search });
    const orderSql = yield* buildOrderSql(sort, knownColumns);
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
  });
}

export function buildColumnValuesQuery({
  tableName,
  columns,
  column,
  filters,
  search,
  sort,
}: {
  tableName: string;
  columns: CsvColumn[];
  column: string;
  filters: readonly CsvFilterDescriptor[];
  search: string;
  sort: readonly CsvSortDescriptor[];
}): QueryBuild<CsvStatement> {
  return Result.gen(function* () {
    const knownColumns = new Set(columns.map((knownColumn) => knownColumn.name));
    yield* requireKnownColumn(column, knownColumns);
    const scope = yield* buildCountScopeWhere({ columns, knownColumns, filters, search });
    const orderSql = yield* buildOrderSql(sort, knownColumns);

    return {
      sql: `SELECT ${quoteIdentifier(column)} AS column_value FROM ${quoteIdentifier(tableName)}${scope.whereSql}${orderSql}`,
      values: scope.values,
    };
  });
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
  filters: readonly CsvFilterDescriptor[];
  search: string;
}): QueryBuild<CsvStatement> {
  return Result.gen(function* () {
    const knownColumns = new Set(columns.map((knownColumn) => knownColumn.name));
    yield* requireKnownColumn(column, knownColumns);
    const scope = yield* buildCountScopeWhere({ columns, knownColumns, filters, search });
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
  });
}

function buildCountScopeWhere({
  columns,
  knownColumns,
  filters,
  search,
}: {
  columns: CsvColumn[];
  knownColumns: Set<string>;
  filters: readonly CsvFilterDescriptor[];
  search: string;
}): QueryBuild<{ whereSql: string; values: QueryValues }> {
  const values: QueryValues = [];
  return Result.gen(function* () {
    const whereClauses = yield* Result.all(
      filters.map((filter) => buildFilterClause(filter, knownColumns, values)),
    );
    whereClauses.push(`${quoteIdentifier(csvDeletedField)} = false`);
    const searchClause = buildSearchClause(columns, search, values);
    if (searchClause) whereClauses.push(searchClause);
    return { whereSql: ` WHERE ${whereClauses.join(' AND ')}`, values };
  });
}

/** The grid's sort, else source order, so every query over the row window agrees on row order. */
function buildOrderSql(sort: readonly CsvSortDescriptor[], knownColumns: Set<string>): QueryBuild<string> {
  return Result.map(
    Result.all(sort.map((descriptor) => buildSortClause(descriptor, knownColumns))),
    (orderClauses) =>
      orderClauses.length > 0
        ? ` ORDER BY ${orderClauses.join(', ')}`
        : ` ORDER BY ${quoteIdentifier(csvSourceOrderField)} ASC`,
  );
}

function buildSortClause(descriptor: CsvSortDescriptor, knownColumns: Set<string>): QueryBuild<string> {
  return Result.map(
    requireKnownColumn(descriptor.column, knownColumns),
    () => `${quoteIdentifier(descriptor.column)} ${descriptor.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`,
  );
}

export function requireKnownColumn(column: string, knownColumns: Set<string>): QueryBuild<void> {
  return knownColumns.has(column)
    ? Result.void
    : Result.fail(new WorkspaceRequestError({ message: `Unknown CSV column: ${column}` }));
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

export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** An empty list would render `IN ()`, which the engine rejects as a syntax error. */
function requireRowIds(rowIds: string[]): QueryBuild<void> {
  return rowIds.length === 0
    ? Result.fail(new WorkspaceRequestError({ message: 'At least one CSV row is required.' }))
    : Result.void;
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
): QueryBuild<string> {
  return Result.map(requireKnownColumn(filter.column, knownColumns), () => {
    const columnSql = quoteIdentifier(filter.column);
    if (filter.operator === 'blank')
      return `(${columnSql} IS NULL OR ${castForText(columnSql)} = '')`;
    if (filter.operator === 'notBlank')
      return `(${columnSql} IS NOT NULL AND ${castForText(columnSql)} <> '')`;
    if (filter.kind === 'text') {
      return buildTextFilterClause(columnSql, filter.operator, filter.value ?? '', values);
    }
    return buildScalarFilterClause(columnSql, filter.operator, filter.value, filter.valueTo, values);
  });
}

function buildTextFilterClause(
  columnSql: string,
  operator: CsvTextFilterOperator,
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
  }
}

function buildScalarFilterClause(
  columnSql: string,
  operator: CsvNumberFilterOperator | CsvDateFilterOperator,
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
  }
}

function castForText(columnSql: string): string {
  return `coalesce(CAST(${columnSql} AS VARCHAR), '')`;
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
