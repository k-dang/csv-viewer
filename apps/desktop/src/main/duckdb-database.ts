import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import {
  normalizeDatabaseOperation,
  type OwnedWorkspaceDatabase,
  type WorkspaceDatabaseConnection,
} from '@csv-viewer/workspace/database';
import type { QueryValues } from '@csv-viewer/workspace/csv-query';
import type { EngineRow } from '@csv-viewer/workspace/csv-result-normalization';

export type DuckDbRow = EngineRow;

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

/**
 * The native in-memory database, open from `open` until the workspace runtime releases it. This is
 * the only module that opens, closes, or hands out native connections, so the workspace above it
 * never holds a driver type.
 */
export class DuckDbWorkspaceDatabase implements OwnedWorkspaceDatabase {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: NativeDuckDbConnection,
  ) {}

  static async open(): Promise<DuckDbWorkspaceDatabase> {
    return normalizeDatabaseOperation(async () => {
      const instance = await DuckDBInstance.create(':memory:');
      try {
        return new DuckDbWorkspaceDatabase(instance, new NativeDuckDbConnection(await instance.connect()));
      } catch (error) {
        instance.closeSync();
        throw error;
      }
    });
  }

  async ownerConnection(): Promise<WorkspaceDatabaseConnection> {
    return this.connection;
  }

  async connectWorker(): Promise<WorkspaceDatabaseConnection> {
    return normalizeDatabaseOperation(async () =>
      new NativeDuckDbConnection(await this.instance.connect()),
    );
  }

  run(sql: string, values?: QueryValues): Promise<void> {
    return this.connection.run(sql, values);
  }

  readObjects(sql: string, values?: QueryValues): Promise<DuckDbRow[]> {
    return this.connection.readObjects(sql, values);
  }

  closeOwnerConnection(): Promise<void> {
    return this.connection.close();
  }

  closeEngine(): Promise<void> {
    return normalizeDatabaseOperation(async () => this.instance.closeSync());
  }
}
