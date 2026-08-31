import type { QueryValues } from './csv-query';
import type { EngineRow } from './csv-result-normalization';

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

/** One in-memory database with an owner connection and isolated operation connections. */
export interface WorkspaceDatabase {
  ownerConnection(): Promise<WorkspaceDatabaseConnection>;
  connectWorker(): Promise<WorkspaceDatabaseConnection>;
  isOpen(): boolean;
  run(sql: string, values?: QueryValues): Promise<void>;
  readObjects(sql: string, values?: QueryValues): Promise<EngineRow[]>;
  close(): Promise<Error[]>;
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
