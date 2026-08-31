import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { toError } from '../../shared/errors';
import {
  normalizeDatabaseOperation,
  type WorkspaceDatabase,
  type WorkspaceDatabaseConnection,
} from '../database';
import type { QueryValues } from '../csv-query';
import type { EngineRow } from '../csv-result-normalization';

export type DuckDbRow = EngineRow;

/**
 * Owns the native DuckDB instance and the workspace's owner connection. This is the only module
 * that opens, closes, or hands out native connections, so the workspace above it never holds a
 * driver type.
 */
class NativeDuckDbConnection implements WorkspaceDatabaseConnection {
  constructor(private readonly connection: DuckDBConnection) {}

  async run(sql: string, values?: QueryValues): Promise<void> {
    await normalizeDatabaseOperation(() => this.connection.run(sql, values));
  }

  async readObjects(sql: string, values?: QueryValues): Promise<EngineRow[]> {
    return normalizeDatabaseOperation(async () => {
      const result = await this.connection.runAndReadAll(sql, values);
      return result.getRowObjectsJS();
    });
  }

  async runCancellable(sql: string): Promise<void> {
    await normalizeDatabaseOperation(() => this.connection.run(sql));
  }

  async readObjectsCancellable(sql: string, values?: QueryValues): Promise<EngineRow[]> {
    return this.readObjects(sql, values);
  }

  cancelRunning(): Promise<void> {
    return normalizeDatabaseOperation(async () => this.connection.interrupt());
  }

  async close(): Promise<void> {
    await normalizeDatabaseOperation(async () => this.connection.closeSync());
  }
}

export class DuckDbWorkspaceDatabase implements WorkspaceDatabase {
  private instance: DuckDBInstance | null = null;
  private connection: NativeDuckDbConnection | null = null;
  private opening: Promise<NativeDuckDbConnection> | null = null;

  /**
   * Opening yields the event loop twice, so the in-flight promise is what gets shared. Caching the
   * resolved connection instead would let concurrent callers each create an instance, and every
   * instance but the last would leak past `close`.
   */
  async ownerConnection(): Promise<WorkspaceDatabaseConnection> {
    if (this.connection) return this.connection;
    if (!this.opening) {
      this.opening = this.openOwnerConnection().finally(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  private async openOwnerConnection(): Promise<NativeDuckDbConnection> {
    return normalizeDatabaseOperation(async () => {
      const instance = await DuckDBInstance.create(':memory:');
      try {
        const connection = new NativeDuckDbConnection(await instance.connect());
        this.instance = instance;
        this.connection = connection;
        return connection;
      } catch (error) {
        instance.closeSync();
        throw error;
      }
    });
  }

  async connectWorker(): Promise<WorkspaceDatabaseConnection> {
    await this.ownerConnection();
    const instance = this.instance;
    if (!instance) throw new Error('CSV workspace is disposing.');
    return normalizeDatabaseOperation(async () =>
      new NativeDuckDbConnection(await instance.connect()),
    );
  }

  isOpen(): boolean {
    return this.connection !== null;
  }

  async run(sql: string, values?: QueryValues): Promise<void> {
    await (await this.ownerConnection()).run(sql, values);
  }

  async readObjects(sql: string, values?: QueryValues): Promise<DuckDbRow[]> {
    return (await this.ownerConnection()).readObjects(sql, values);
  }

  /** Closes the owner connection and instance, collecting rather than throwing teardown failures. */
  async close(): Promise<Error[]> {
    const failures: Error[] = [];
    try {
      await this.connection?.close();
    } catch (error) {
      failures.push(toError(error));
    }
    this.connection = null;
    try {
      const instance = this.instance;
      if (instance) {
        await normalizeDatabaseOperation(async () => instance.closeSync());
      }
    } catch (error) {
      failures.push(toError(error));
    }
    this.instance = null;
    return failures;
  }
}
