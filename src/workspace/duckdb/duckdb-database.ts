import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import type { QueryValues } from '../csv-query';

export type DuckDbRow = Record<string, unknown>;

/**
 * Owns the native DuckDB instance and the workspace's owner connection. This is the only module
 * that opens, closes, or hands out native connections, so the workspace above it never holds a
 * driver type.
 */
export class DuckDbWorkspaceDatabase {
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;

  async ownerConnection(): Promise<DuckDBConnection> {
    if (!this.instance) this.instance = await DuckDBInstance.create(':memory:');
    if (!this.connection) this.connection = await this.instance.connect();
    return this.connection;
  }

  async connectWorker(): Promise<DuckDBConnection> {
    await this.ownerConnection();
    const instance = this.instance;
    if (!instance) throw new Error('CSV workspace is disposing.');
    return instance.connect();
  }

  isOpen(): boolean {
    return this.connection !== null;
  }

  async run(sql: string, values?: QueryValues): Promise<void> {
    await this.requireConnection().run(sql, values);
  }

  async readObjects(sql: string, values?: QueryValues): Promise<DuckDbRow[]> {
    const result = await this.requireConnection().runAndReadAll(sql, values);
    return result.getRowObjectsJS();
  }

  /** Closes the owner connection and instance, collecting rather than throwing teardown failures. */
  close(): Error[] {
    const failures: Error[] = [];
    try {
      this.connection?.closeSync();
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
    this.connection = null;
    try {
      this.instance?.closeSync();
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
    this.instance = null;
    return failures;
  }

  private requireConnection(): DuckDBConnection {
    if (!this.connection) throw new Error('CSV data store is not open.');
    return this.connection;
  }
}
