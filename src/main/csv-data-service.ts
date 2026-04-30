import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { CsvColumn, CsvSessionMetadata } from '../shared/ipc';

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
