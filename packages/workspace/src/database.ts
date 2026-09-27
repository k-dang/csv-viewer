import type { QueryValues } from './query/csv-query';
import type { EngineRow } from './query/csv-result-normalization';

/** The database operations the shared workspace needs from either DuckDB runtime. */
export interface WorkspaceDatabaseConnection {
  run(sql: string, values?: QueryValues): Promise<void>;
  readObjects(sql: string, values?: QueryValues): Promise<EngineRow[]>;
  /**
   * Runs long work through the engine's cancellable execution path. Kept separate from `run` and
   * `readObjects` because DuckDB-Wasm's cancellable path holds one connection's single result
   * stream, so it cannot interleave with the concurrent short queries the owner connection serves.
   */
  runCancellable(sql: string): Promise<void>;
  readObjectsCancellable(sql: string, values?: QueryValues): Promise<EngineRow[]>;
  cancelRunning(): Promise<void>;
  close(): Promise<void>;
}

/**
 * One acquired in-memory database with an owner connection and isolated operation connections.
 * The workspace runtime acquires it before the workspace exists and releases it after every
 * Working CSV table, so it is open for the whole life of every caller.
 */
export interface WorkspaceDatabase {
  ownerConnection(): Promise<WorkspaceDatabaseConnection>;
  connectWorker(): Promise<WorkspaceDatabaseConnection>;
  run(sql: string, values?: QueryValues): Promise<void>;
  readObjects(sql: string, values?: QueryValues): Promise<EngineRow[]>;
}

/** A runtime's database with the release steps the database Layer's finalizer runs in order. */
export interface OwnedWorkspaceDatabase extends WorkspaceDatabase {
  closeOwnerConnection(): Promise<void>;
  /** Stops the engine: the native instance, or the Wasm Worker. Runs even if the connection close failed. */
  closeEngine(): Promise<void>;
}

export class DataEngineError extends Error {
  constructor(cause: unknown) {
    super('The data engine could not complete the operation.', { cause });
    this.name = 'DataEngineError';
  }
}

/** Keeps driver exception classes and messages behind the database adapter boundary. */
export async function normalizeDatabaseOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DataEngineError) throw error;
    throw new DataEngineError(error);
  }
}
