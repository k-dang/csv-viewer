import type {
  CsvCellValue,
  CsvColumn,
  CsvFilterDescriptor,
  CsvSortDescriptor,
} from '../shared/ipc';
import { csvInternalRowIdField } from '../shared/ipc';
import { csvDeletedField, csvSourceOrderField } from './csv-storage-schema';

type QueryValues = Array<string | number | boolean | null>;

export function normalizeCellValue(value: unknown): CsvCellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : String(value);
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
}): { rowsSql: string; countSql: string; values: QueryValues } {
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
}): { sql: string; values: QueryValues } {
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

export function buildCountScopeWhere({
  columns,
  filters,
  search,
}: {
  columns: CsvColumn[];
  filters: CsvFilterDescriptor[];
  search: string;
}): { whereSql: string; values: QueryValues } {
  const knownColumns = new Set(columns.map((column) => column.name));
  const values: QueryValues = [];
  const whereClauses = filters.map((filter) => buildFilterClause(filter, knownColumns, values));
  whereClauses.push(`${quoteIdentifier(csvDeletedField)} = false`);
  const searchClause = buildSearchClause(columns, search, values);
  if (searchClause) whereClauses.push(searchClause);
  return { whereSql: ` WHERE ${whereClauses.join(' AND ')}`, values };
}

export function buildSortClause(descriptor: CsvSortDescriptor, knownColumns: Set<string>): string {
  assertKnownColumn(descriptor.column, knownColumns);
  return `${quoteIdentifier(descriptor.column)} ${descriptor.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
}

export function assertKnownColumn(column: string, knownColumns: Set<string>): void {
  if (!knownColumns.has(column)) throw new Error(`Unknown CSV column: ${column}`);
}

export function normalizeCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('DuckDB returned an invalid non-negative count.');
  }
  return count;
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
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
