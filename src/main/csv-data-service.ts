import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  CsvCellValue,
  CsvColumn,
  CsvRow,
  CsvRowWindow,
  CsvRowWindowRequest,
  CsvSessionMetadata,
} from '../shared/ipc';

const viewName = 'active_csv';

export class CsvDataService {
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private session: CsvSessionMetadata | null = null;

  async openCsv(filePath: string): Promise<CsvSessionMetadata> {
    await this.closeActiveSession();

    const fileStats = await stat(filePath).catch((error: unknown) => {
      throw normalizeOpenError(error);
    });

    if (!fileStats.isFile()) {
      throw normalizeOpenError(new Error('Selected path is not a file.'));
    }

    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();

    try {
      await connection.run(
        `CREATE VIEW ${quoteIdentifier(viewName)} AS SELECT * FROM read_csv_auto(${quoteLiteral(
          filePath,
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
      };

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

    const result = await this.connection.runAndReadAll(
      `SELECT * FROM ${quoteIdentifier(viewName)} LIMIT ${limit} OFFSET ${offset}`,
    );

    return {
      sessionId: this.session.sessionId,
      offset,
      rows: result.getRowObjectsJS().map(normalizeRow),
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

function normalizeOpenError(error: unknown): Error {
  if (error instanceof Error) {
    return new Error(`Unable to open CSV: ${error.message}`);
  }

  return new Error('Unable to open CSV.');
}
