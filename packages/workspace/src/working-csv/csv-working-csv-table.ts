import { Effect, Result } from 'effect';
import type {
  CsvCellValue,
  CsvColumn,
  CsvDialectOptions,
  CsvInsertRowPlacement,
} from '../csv-viewer';
import { csvInternalRowIdField } from '../csv-viewer';
import { WorkspaceRequestError } from '../errors';
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
  requireKnownColumn,
  type QueryBuild,
} from '../query/csv-query';
import { normalizeCellValue, type EngineRow } from '../query/csv-result-normalization';
import { csvDeletedField, csvSourceOrderField } from './csv-storage-schema';
import type { DataEngineError, WorkspaceDatabase, WorkspaceDatabaseConnection } from '../database';

const internalFields = new Set([csvInternalRowIdField, csvSourceOrderField, csvDeletedField]);

export type CsvTable = { database: WorkspaceDatabase; tableName: string };

export function createWorkingCsvTable(
  table: CsvTable,
  engineSourceReference: string,
  dialect: CsvDialectOptions,
): Effect.Effect<void, DataEngineError> {
  return table.database.runEffect(
    buildCreateWorkingCsvTableSql(table.tableName, engineSourceReference, dialect),
  );
}

export function dropWorkingCsvTable(table: CsvTable): Effect.Effect<void, DataEngineError> {
  return table.database.runEffect(buildDropTableSql(table.tableName));
}

export function readColumns(table: CsvTable): Effect.Effect<CsvColumn[], DataEngineError> {
  return table.database.readObjectsEffect(buildDescribeColumnsSql(table.tableName)).pipe(
    Effect.map((rows) => rows
      .filter((row) => !internalFields.has(String(row.column_name)))
      .map((row) => ({ name: String(row.column_name), type: String(row.column_type) }))),
  );
}

export function readRowCount(table: CsvTable): Effect.Effect<number, DataEngineError> {
  return table.database.readObjectsEffect(buildRowCountSql(table.tableName)).pipe(
    Effect.map(([row]) => Number(row.row_count)),
  );
}

export function readCellValue(
  table: CsvTable,
  rowId: string,
  column: string,
): Effect.Effect<CsvCellValue, DataEngineError | WorkspaceRequestError> {
  return Effect.gen(function* () {
    const query = buildCellValueQuery(table.tableName, rowId, column);
    const [row] = yield* table.database.readObjectsEffect(query.sql, query.values);
    if (!row) return yield* Effect.fail(new WorkspaceRequestError({ message: 'CSV row no longer exists.' }));
    return normalizeCellValue(row.cell_value);
  });
}

export function applyCellValue(
  table: CsvTable,
  rowId: string,
  column: string,
  value: CsvCellValue,
): Effect.Effect<void, DataEngineError> {
  const statement = buildCellUpdateStatement(table.tableName, rowId, column, value);
  return table.database.runEffect(statement.sql, statement.values);
}

export function applyColumnRename(table: CsvTable, from: string, to: string): Effect.Effect<void, DataEngineError> {
  return table.database.runEffect(buildRenameColumnStatement(table.tableName, from, to));
}

export function applyAddColumn(table: CsvTable, name: string): Effect.Effect<void, DataEngineError> {
  return table.database.runEffect(buildAddColumnStatement(table.tableName, name));
}

export function applyDropColumn(table: CsvTable, name: string): Effect.Effect<void, DataEngineError> {
  return table.database.runEffect(buildDropColumnStatement(table.tableName, name));
}

export function columnsAfter(
  columns: CsvColumn[],
  command: CsvEditDraft,
  direction: 'undo' | 'redo',
): QueryBuild<CsvColumn[]> {
  switch (command.type) {
    case 'cell-edit':
    case 'delete-rows':
    case 'insert-row':
      return Result.succeed(columns);
    case 'rename-column': {
      const from = direction === 'redo' ? command.from : command.to;
      const to = direction === 'redo' ? command.to : command.from;
      return Result.map(requireKnownColumn(from, new Set(columns.map((column) => column.name))), () =>
        columns.map((column) => ({ ...column, name: column.name === from ? to : column.name })),
      );
    }
    case 'insert-column':
      return Result.succeed(
        direction === 'undo'
          ? columns.filter((column) => column.name !== command.name)
          : spliceColumn(columns, command.index, { name: command.name, type: 'VARCHAR' }),
      );
    case 'delete-column':
      return Result.succeed(
        direction === 'redo'
          ? columns.filter((column) => column.name !== command.name)
          : spliceColumn(columns, command.index, { name: command.name, type: command.columnType }),
      );
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

export function applyRowDeletion(
  table: CsvTable,
  rowIds: string[],
  deleted: boolean,
): Effect.Effect<void, DataEngineError | WorkspaceRequestError> {
  return Effect.gen(function* () {
    const statement = yield* Effect.fromResult(buildRowDeletionStatement(table.tableName, rowIds, deleted));
    yield* table.database.runEffect(statement.sql, statement.values);
  });
}

export function assertRowsExist(table: CsvTable, rowIds: string[]): Effect.Effect<void, DataEngineError | WorkspaceRequestError> {
  return Effect.gen(function* () {
    const query = yield* Effect.fromResult(buildExistingRowIdsQuery(table.tableName, rowIds));
    const rows = yield* table.database.readObjectsEffect(query.sql, query.values);
    const foundRowIds = new Set(rows.map((row) => String(row.row_id)));
    const missingRowId = rowIds.find((rowId) => !foundRowIds.has(rowId));
    if (missingRowId) return yield* Effect.fail(new WorkspaceRequestError({ message: `CSV row no longer exists: ${missingRowId}` }));
  });
}

export function insertEmptyRow(
  table: CsvTable,
  columns: CsvColumn[],
  placement: CsvInsertRowPlacement,
  targetRowId: string | undefined,
): Effect.Effect<string, DataEngineError | WorkspaceRequestError> {
  return Effect.gen(function* () {
    const rowId = yield* nextRowId(table);
    const sourceOrder = yield* resolveInsertionOrder(table, placement, targetRowId);

    if (placement !== 'append') {
      const shift = buildSourceOrderShiftStatement(table.tableName, sourceOrder);
      yield* table.database.runEffect(shift.sql, shift.values);
    }

    const insert = buildEmptyRowInsertStatement({
      tableName: table.tableName,
      columns,
      rowId,
      sourceOrder,
    });
    yield* table.database.runEffect(insert.sql, insert.values);
    return rowId;
  });
}

/** Returns engine rows without a second normalized copy; the caller scopes its worker connection. */
export function readExportRows(
  connection: WorkspaceDatabaseConnection,
  tableName: string,
  columns: CsvColumn[],
): Effect.Effect<EngineRow[], DataEngineError> {
  return connection.readObjectsCancellableEffect(buildExportRowsSql(tableName, columns));
}

export function runEditCommand(
  table: CsvTable,
  command: CsvEditDraft,
  direction: 'undo' | 'redo',
): Effect.Effect<void, DataEngineError | WorkspaceRequestError> {
  return Effect.gen(function* () {
    const redoing = direction === 'redo';
    switch (command.type) {
      case 'cell-edit':
        yield* applyCellValue(
          table,
          command.rowId,
          command.column,
          redoing ? command.newValue : command.oldValue,
        );
        return;
      case 'delete-rows':
        yield* applyRowDeletion(table, command.rowIds, redoing);
        return;
      case 'insert-row':
        yield* applyRowDeletion(table, [command.rowId], !redoing);
        return;
      case 'rename-column':
        yield* applyColumnRename(
          table,
          redoing ? command.from : command.to,
          redoing ? command.to : command.from,
        );
        return;
      case 'insert-column':
        if (redoing) yield* applyAddColumn(table, command.name);
        else yield* applyDropColumn(table, command.name);
        return;
      case 'delete-column':
        yield* applyColumnRename(
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
  });
}

function nextRowId(table: CsvTable): Effect.Effect<string, DataEngineError> {
  return table.database.readObjectsEffect(buildNextRowIdSql(table.tableName)).pipe(
    Effect.map(([row]) => String(row.next_row_id)),
  );
}

function resolveInsertionOrder(
  table: CsvTable,
  placement: CsvInsertRowPlacement,
  targetRowId: string | undefined,
): Effect.Effect<number, DataEngineError | WorkspaceRequestError> {
  return Effect.gen(function* () {
    if (placement === 'append') {
      const [row] = yield* table.database.readObjectsEffect(buildAppendSourceOrderSql(table.tableName));
      return Number(row.source_order);
    }

    if (!targetRowId) return yield* Effect.fail(new WorkspaceRequestError({ message: 'CSV row identifier is required for insertion.' }));

    const query = buildRowSourceOrderQuery(table.tableName, targetRowId);
    const [row] = yield* table.database.readObjectsEffect(query.sql, query.values);
    if (!row) return yield* Effect.fail(new WorkspaceRequestError({ message: `CSV row no longer exists: ${targetRowId}` }));
    return Number(row.source_order) + (placement === 'below' ? 1 : 0);
  });
}
