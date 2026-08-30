import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { toError } from '../../shared/errors';
import type { QueryValues } from '../csv-query';
import type { EngineRow } from '../csv-result-normalization';

export type DuckDbRow = EngineRow;

/**
 * Owns the native DuckDB instance and the workspace's owner connection. This is the only module
 * that opens, closes, or hands out native connections, so the workspace above it never holds a
 * driver type.
 */
export class DuckDbWorkspaceDatabase {
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private opening: Promise<DuckDBConnection> | null = null;

  /**
   * Opening yields the event loop twice, so the in-flight promise is what gets shared. Caching the
   * resolved connection instead would let concurrent callers each create an instance, and every
   * instance but the last would leak past `close`.
   */
  async ownerConnection(): Promise<DuckDBConnection> {
    if (this.connection) return this.connection;
    if (!this.opening) {
      this.opening = this.openOwnerConnection().finally(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  private async openOwnerConnection(): Promise<DuckDBConnection> {
    const instance = await DuckDBInstance.create(':memory:');
    this.instance = instance;
    this.connection = await instance.connect();
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
      failures.push(toError(error));
    }
    this.connection = null;
    try {
      this.instance?.closeSync();
    } catch (error) {
      failures.push(toError(error));
    }
    this.instance = null;
    return failures;
  }

  private requireConnection(): DuckDBConnection {
    if (!this.connection) throw new Error('CSV data store is not open.');
    return this.connection;
  }
}
