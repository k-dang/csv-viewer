import type {
  CsvCellValue,
  CsvColumn,
  CsvDialectOptions,
  CsvInsertRowPlacement,
} from '../shared/ipc';
import { csvInternalRowIdField } from '../shared/ipc';
import type { CsvEditCommand } from './csv-edit-history';
import {
  buildAppendSourceOrderSql,
  buildCellUpdateStatement,
  buildCellValueQuery,
  buildCreateWorkingCsvTableSql,
  buildDescribeColumnsSql,
  buildDropTableSql,
  buildEmptyRowInsertStatement,
  buildExistingRowIdsQuery,
  buildExportRowsSql,
  buildNextRowIdSql,
  buildRowCountSql,
  buildRowDeletionStatement,
  buildRowSourceOrderQuery,
  buildSourceOrderShiftStatement,
} from './csv-query';
import { normalizeCellValue } from './csv-result-normalization';
import { csvDeletedField, csvSourceOrderField } from './csv-storage-schema';
import type { DuckDbWorkspaceDatabase } from './duckdb/duckdb-database';

const internalFields = new Set([csvInternalRowIdField, csvSourceOrderField, csvDeletedField]);

export type CsvTable = { database: DuckDbWorkspaceDatabase; tableName: string };

export async function createWorkingCsvTable(
  table: CsvTable,
  engineSourceReference: string,
  dialect: CsvDialectOptions,
): Promise<void> {
  await table.database.run(
    buildCreateWorkingCsvTableSql(table.tableName, engineSourceReference, dialect),
  );
}

export async function dropWorkingCsvTable(table: CsvTable): Promise<void> {
  if (!table.database.isOpen()) return;
  await table.database.run(buildDropTableSql(table.tableName));
}

export async function readColumns(table: CsvTable): Promise<CsvColumn[]> {
  const rows = await table.database.readObjects(buildDescribeColumnsSql(table.tableName));
  return rows
    .filter((row) => !internalFields.has(String(row.column_name)))
    .map((row) => ({ name: String(row.column_name), type: String(row.column_type) }));
}

export async function readRowCount(table: CsvTable): Promise<number> {
  const [row] = await table.database.readObjects(buildRowCountSql(table.tableName));
  return Number(row.row_count);
}

export async function readCellValue(
  table: CsvTable,
  rowId: string,
  column: string,
): Promise<CsvCellValue> {
  const query = buildCellValueQuery(table.tableName, rowId, column);
  const [row] = await table.database.readObjects(query.sql, query.values);
  if (!row) throw new Error('CSV row no longer exists.');
  return normalizeCellValue(row.cell_value);
}

export async function applyCellValue(
  table: CsvTable,
  rowId: string,
  column: string,
  value: CsvCellValue,
): Promise<void> {
  const statement = buildCellUpdateStatement(table.tableName, rowId, column, value);
  await table.database.run(statement.sql, statement.values);
}

export async function applyRowDeletion(
  table: CsvTable,
  rowIds: string[],
  deleted: boolean,
): Promise<void> {
  const statement = buildRowDeletionStatement(table.tableName, rowIds, deleted);
  await table.database.run(statement.sql, statement.values);
}

export async function assertRowsExist(table: CsvTable, rowIds: string[]): Promise<void> {
  const query = buildExistingRowIdsQuery(table.tableName, rowIds);
  const rows = await table.database.readObjects(query.sql, query.values);
  const foundRowIds = new Set(rows.map((row) => String(row.row_id)));
  const missingRowId = rowIds.find((rowId) => !foundRowIds.has(rowId));
  if (missingRowId) throw new Error(`CSV row no longer exists: ${missingRowId}`);
}

export async function insertEmptyRow(
  table: CsvTable,
  columns: CsvColumn[],
  placement: CsvInsertRowPlacement,
  targetRowId: string | undefined,
): Promise<string> {
  const rowId = await nextRowId(table);
  const sourceOrder = await resolveInsertionOrder(table, placement, targetRowId);

  if (placement !== 'append') {
    const shift = buildSourceOrderShiftStatement(table.tableName, sourceOrder);
    await table.database.run(shift.sql, shift.values);
  }

  const insert = buildEmptyRowInsertStatement({
    tableName: table.tableName,
    columns,
    rowId,
    sourceOrder,
  });
  await table.database.run(insert.sql, insert.values);
  return rowId;
}

export async function readExportRows(
  table: CsvTable,
  columns: CsvColumn[],
): Promise<Array<Record<string, CsvCellValue>>> {
  const rows = await table.database.readObjects(buildExportRowsSql(table.tableName, columns));
  return rows.map((row) =>
    Object.fromEntries(columns.map((column) => [column.name, normalizeCellValue(row[column.name])])),
  );
}

export async function applyEditCommand(table: CsvTable, command: CsvEditCommand): Promise<void> {
  if (command.type === 'cell-edit') {
    await applyCellValue(table, command.rowId, command.column, command.newValue);
    return;
  }
  if (command.type === 'delete-rows') {
    await applyRowDeletion(table, command.rowIds, true);
    return;
  }
  await applyRowDeletion(table, [command.rowId], false);
}

export async function revertEditCommand(table: CsvTable, command: CsvEditCommand): Promise<void> {
  if (command.type === 'cell-edit') {
    await applyCellValue(table, command.rowId, command.column, command.oldValue);
    return;
  }
  if (command.type === 'delete-rows') {
    await applyRowDeletion(table, command.rowIds, false);
    return;
  }
  await applyRowDeletion(table, [command.rowId], true);
}

async function nextRowId(table: CsvTable): Promise<string> {
  const [row] = await table.database.readObjects(buildNextRowIdSql(table.tableName));
  return String(row.next_row_id);
}

async function resolveInsertionOrder(
  table: CsvTable,
  placement: CsvInsertRowPlacement,
  targetRowId: string | undefined,
): Promise<number> {
  if (placement === 'append') {
    const [row] = await table.database.readObjects(buildAppendSourceOrderSql(table.tableName));
    return Number(row.source_order);
  }

  if (!targetRowId) throw new Error('CSV row identifier is required for insertion.');

  const query = buildRowSourceOrderQuery(table.tableName, targetRowId);
  const [row] = await table.database.readObjects(query.sql, query.values);
  if (!row) throw new Error(`CSV row no longer exists: ${targetRowId}`);
  return Number(row.source_order) + (placement === 'below' ? 1 : 0);
}
