import type {
  CsvCellValue,
  CsvColumn,
  CsvDialectOptions,
  CsvInsertRowPlacement,
} from '../csv-viewer';
import { csvInternalRowIdField } from '../csv-viewer';
import type { CsvEditDraft } from './csv-edit-history';
import {
  buildAddColumnStatement,
  buildAppendSourceOrderSql,
  buildCellUpdateStatement,
  buildCellValueQuery,
  buildCreateWorkingCsvTableSql,
  buildDescribeColumnsSql,
  buildDropColumnStatement,
  buildDropTableSql,
  buildEmptyRowInsertStatement,
  buildExistingRowIdsQuery,
  buildExportRowsSql,
  buildNextRowIdSql,
  buildRenameColumnStatement,
  buildRowCountSql,
  buildRowDeletionStatement,
  buildRowSourceOrderQuery,
  buildSourceOrderShiftStatement,
} from '../query/csv-query';
import { normalizeCellValue, type EngineRow } from '../query/csv-result-normalization';
import { csvDeletedField, csvSourceOrderField } from './csv-storage-schema';
import type { WorkspaceDatabase } from '../database';

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

export async function applyColumnRename(table: CsvTable, from: string, to: string): Promise<void> {
  await table.database.run(buildRenameColumnStatement(table.tableName, from, to));
}

export async function applyAddColumn(table: CsvTable, name: string): Promise<void> {
  await table.database.run(buildAddColumnStatement(table.tableName, name));
}

export async function applyDropColumn(table: CsvTable, name: string): Promise<void> {
  await table.database.run(buildDropColumnStatement(table.tableName, name));
}

export function renameCsvColumns(columns: CsvColumn[], from: string, to: string): CsvColumn[] {
  let renamed = false;
  const next = columns.map((column) => {
    if (column.name !== from) return { ...column };
    renamed = true;
    return { ...column, name: to };
  });
  if (!renamed) throw new Error(`Unknown CSV column: ${from}`);
  return next;
}

export function columnsAfter(
  columns: CsvColumn[],
  command: CsvEditDraft,
  direction: 'undo' | 'redo',
): CsvColumn[] {
  switch (command.type) {
    case 'cell-edit':
    case 'delete-rows':
    case 'insert-row':
      return columns;
    case 'rename-column': {
      const from = direction === 'redo' ? command.from : command.to;
      const to = direction === 'redo' ? command.to : command.from;
      return renameCsvColumns(columns, from, to);
    }
    case 'insert-column':
      if (direction === 'undo') return columns.filter((column) => column.name !== command.name);
      return spliceColumn(columns, command.index, { name: command.name, type: 'VARCHAR' });
    case 'delete-column':
      if (direction === 'redo') return columns.filter((column) => column.name !== command.name);
      return spliceColumn(columns, command.index, { name: command.name, type: command.columnType });
    default: {
      const exhaustive: never = command;
      throw new Error(`Unsupported CSV edit command: ${String(exhaustive)}`);
    }
  }
}

function spliceColumn(columns: readonly CsvColumn[], index: number, column: CsvColumn): CsvColumn[] {
  if (!Number.isInteger(index) || index < 0 || index > columns.length) {
    throw new Error(`CSV column index ${index} is outside the logical schema.`);
  }
  const next = columns.slice();
  next.splice(index, 0, column);
  return next;
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
 * exporting never holds a second full copy of the Working CSV in memory. Use a separate operation
 * connection and the pending-query path so foreground row queries can run during a large export.
 */
export async function readExportRows(
  table: CsvTable,
  columns: CsvColumn[],
): Promise<EngineRow[]> {
  const connection = await table.database.connectWorker();
  try {
    return await connection.readObjectsCancellable(buildExportRowsSql(table.tableName, columns));
  } finally {
    await connection.close();
  }
}

export async function runEditCommand(
  table: CsvTable,
  command: CsvEditDraft,
  direction: 'undo' | 'redo',
): Promise<void> {
  const redoing = direction === 'redo';
  switch (command.type) {
    case 'cell-edit':
      await applyCellValue(
        table,
        command.rowId,
        command.column,
        redoing ? command.newValue : command.oldValue,
      );
      return;
    case 'delete-rows':
      await applyRowDeletion(table, command.rowIds, redoing);
      return;
    case 'insert-row':
      await applyRowDeletion(table, [command.rowId], !redoing);
      return;
    case 'rename-column':
      await applyColumnRename(
        table,
        redoing ? command.from : command.to,
        redoing ? command.to : command.from,
      );
      return;
    case 'insert-column':
      if (redoing) await applyAddColumn(table, command.name);
      else await applyDropColumn(table, command.name);
      return;
    case 'delete-column':
      await applyColumnRename(
        table,
        redoing ? command.name : command.hiddenName,
        redoing ? command.hiddenName : command.name,
      );
      return;
    default: {
      const exhaustive: never = command;
      throw new Error(`Unsupported CSV edit command: ${String(exhaustive)}`);
    }
  }
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
