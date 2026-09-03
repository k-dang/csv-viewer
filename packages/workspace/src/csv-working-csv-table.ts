import type {
  CsvCellValue,
  CsvColumn,
  CsvDialectOptions,
  CsvInsertRowPlacement,
} from './contracts/csv-viewer';
import { csvInternalRowIdField } from './contracts/csv-viewer';
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
import { normalizeCellValue, type EngineRow } from './csv-result-normalization';
import { csvDeletedField, csvSourceOrderField } from './csv-storage-schema';
import type { WorkspaceDatabase } from './database';

const internalFields = new Set([csvInternalRowIdField, csvSourceOrderField, csvDeletedField]);

export type CsvTable = { database: WorkspaceDatabase; tableName: string };

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

/**
 * Returns engine rows as read. Cells are normalized during serialization rather than here, so
 * exporting never holds a second full copy of the Working CSV in memory.
 */
export async function readExportRows(
  table: CsvTable,
  columns: CsvColumn[],
): Promise<EngineRow[]> {
  return table.database.readObjects(buildExportRowsSql(table.tableName, columns));
}

/**
 * Replays an edit in either direction. Redo restores the command's new value and its deletions;
 * undo restores the old value and reverses them - the same three cases with the sense flipped.
 */
export async function runEditCommand(
  table: CsvTable,
  command: CsvEditCommand,
  direction: 'undo' | 'redo',
): Promise<void> {
  const redoing = direction === 'redo';
  if (command.type === 'cell-edit') {
    await applyCellValue(
      table,
      command.rowId,
      command.column,
      redoing ? command.newValue : command.oldValue,
    );
    return;
  }
  if (command.type === 'delete-rows') {
    await applyRowDeletion(table, command.rowIds, redoing);
    return;
  }
  await applyRowDeletion(table, [command.rowId], !redoing);
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
