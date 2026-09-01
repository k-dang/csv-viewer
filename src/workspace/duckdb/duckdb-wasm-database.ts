import {
  AsyncDuckDB,
  type AsyncDuckDBConnection,
  type AsyncPreparedStatement,
  VoidLogger,
} from '@duckdb/duckdb-wasm';
import { toError } from '../../shared/errors';
import type { QueryValues } from '../csv-query';
import type { EngineRow } from '../csv-result-normalization';
import {
  normalizeDatabaseOperation,
  type WorkspaceDatabase,
  type WorkspaceDatabaseConnection,
} from '../database';

type DuckDbWasmWorker = NonNullable<ConstructorParameters<typeof AsyncDuckDB>[1]>;
const sourceDirectory = '/csv-viewer-sources';

export type DuckDbWasmDatabaseOptions = {
  mainModule: string;
  mainWorker: string;
  createWorker(reference: string): Promise<DuckDbWasmWorker>;
};

/**
 * DuckDB-Wasm's connection API differs in three places that matter here: parameter binding uses
 * prepared statements, rows arrive as Arrow values, and cancellable work uses send/cancelSent.
 * `send` holds the connection's single result stream, so only the cancellable methods use it -
 * routing every statement through it would stop the owner connection serving concurrent queries.
 */
class DuckDbWasmConnection implements WorkspaceDatabaseConnection {
  constructor(private readonly connection: AsyncDuckDBConnection) {}

  async run(sql: string, values?: QueryValues): Promise<void> {
    await normalizeDatabaseOperation(() => this.query(sql, values));
  }

  async readObjects(sql: string, values?: QueryValues): Promise<EngineRow[]> {
    return normalizeDatabaseOperation(async () => {
      const table = await this.query(sql, values);
      // SAFETY: Arrow's toJSON returns own fields whose recursive values match EngineCellValue.
      return table.toArray().map((row) => row.toJSON() as EngineRow);
    });
  }

  async runCancellable(sql: string): Promise<void> {
    // Draining the pending result completes statements that do not return rows, including CTAS.
    await this.readObjectsCancellable(sql);
  }

  async readObjectsCancellable(sql: string, values?: QueryValues): Promise<EngineRow[]> {
    return normalizeDatabaseOperation(async () => {
      let statement: AsyncPreparedStatement | undefined;
      try {
        const stream = values?.length
          ? await (statement = await this.connection.prepare(sql)).send(...values)
          : await this.connection.send(sql);
        const rows: EngineRow[] = [];
        for await (const batch of stream) {
          for (const row of batch) {
            // SAFETY: Arrow's toJSON returns own fields whose recursive values match EngineCellValue.
            rows.push(row.toJSON() as EngineRow);
          }
        }
        return rows;
      } finally {
        await statement?.close();
      }
    });
  }

  async cancelRunning(): Promise<void> {
    await normalizeDatabaseOperation(() => this.connection.cancelSent());
  }

  async close(): Promise<void> {
    await normalizeDatabaseOperation(() => this.connection.close());
  }

  private async query(sql: string, values?: QueryValues) {
    if (!values?.length) return this.connection.query(sql);
    let statement: AsyncPreparedStatement | undefined;
    try {
      statement = await this.connection.prepare(sql);
      return await statement.query(...values);
    } finally {
      await statement?.close();
    }
  }
}

/** Owns one single-threaded, in-memory DuckDB-Wasm Worker and its owner connection. */
export class DuckDbWasmWorkspaceDatabase implements WorkspaceDatabase {
  private database: AsyncDuckDB | null = null;
  private connection: DuckDbWasmConnection | null = null;
  private opening: Promise<DuckDbWasmConnection> | null = null;

  constructor(private readonly options: DuckDbWasmDatabaseOptions) {
    assertLocalAsset(options.mainModule);
    assertLocalAsset(options.mainWorker);
  }

  /**
   * Opening yields the event loop, so the in-flight promise is what gets shared. Caching the
   * resolved connection instead would let concurrent callers each start a Worker, and every Worker
   * but the last would leak past `close`.
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

  async connectWorker(): Promise<WorkspaceDatabaseConnection> {
    await this.ownerConnection();
    const database = this.database;
    if (!database) throw new Error('CSV workspace is disposing.');
    return normalizeDatabaseOperation(async () =>
      new DuckDbWasmConnection(await database.connect()),
    );
  }

  isOpen(): boolean {
    return this.connection !== null;
  }

  async run(sql: string, values?: QueryValues): Promise<void> {
    await (await this.ownerConnection()).run(sql, values);
  }

  async readObjects(sql: string, values?: QueryValues): Promise<EngineRow[]> {
    return (await this.ownerConnection()).readObjects(sql, values);
  }

  async registerFileBuffer(name: string, contents: Uint8Array): Promise<string> {
    await this.ownerConnection();
    const database = this.database;
    if (!database) throw new Error('CSV workspace is disposing.');
    const baseName = name.split('/').pop() || 'source.csv';
    const reference = `${sourceDirectory}/${crypto.randomUUID()}-${baseName}`;
    await normalizeDatabaseOperation(() => database.registerFileBuffer(reference, contents));
    return reference;
  }

  /** Registers `contents` for the duration of `use`, dropping it even when `use` throws. */
  async withRegisteredFile<T>(
    name: string,
    contents: Uint8Array,
    use: (reference: string) => Promise<T>,
  ): Promise<T> {
    const reference = await this.registerFileBuffer(name, contents);
    try {
      return await use(reference);
    } finally {
      await this.dropFile(reference);
    }
  }

  async dropFile(reference: string): Promise<void> {
    const database = this.database;
    if (database) {
      await normalizeDatabaseOperation(() => database.dropFile(reference));
    }
  }

  /** Closes every Wasm resource, collecting rather than throwing teardown failures. */
  async close(): Promise<Error[]> {
    const failures: Error[] = [];
    const opening = this.opening;
    if (opening) {
      await opening.catch((error) => failures.push(toError(error)));
    }
    try {
      await this.connection?.close();
    } catch (error) {
      failures.push(toError(error));
    }
    this.connection = null;
    try {
      const database = this.database;
      if (database) await normalizeDatabaseOperation(() => database.terminate());
    } catch (error) {
      failures.push(toError(error));
    }
    this.database = null;
    return failures;
  }

  private async openOwnerConnection(): Promise<DuckDbWasmConnection> {
    return normalizeDatabaseOperation(async () => {
      const worker = await this.options.createWorker(this.options.mainWorker);
      const database = new AsyncDuckDB(new VoidLogger(), worker);
      this.database = database;
      try {
        await database.instantiate(this.options.mainModule);
        await database.open({
          path: ':memory:',
          maximumThreads: 1,
          allowUnsignedExtensions: false,
          query: { castBigIntToDouble: false },
          filesystem: { allowFullHTTPReads: false, forceFullHTTPReads: false },
          opfs: { fileHandling: 'manual' },
        });
        const connection = new DuckDbWasmConnection(await database.connect());
        await connection.run(`SET allowed_directories = ['${sourceDirectory}']`);
        await connection.run('SET enable_external_access = false');
        await connection.run('SET allow_community_extensions = false');
        await connection.run('SET autoinstall_known_extensions = false');
        await connection.run('SET autoload_known_extensions = false');
        await connection.run('SET lock_configuration = true');
        this.connection = connection;
        return connection;
      } catch (error) {
        await database.terminate().catch(() => undefined);
        this.database = null;
        throw error;
      }
    });
  }
}

function assertLocalAsset(reference: string): void {
  if (/^(?:https?:)?\/\//i.test(reference)) {
    throw new Error('DuckDB-Wasm executable assets must be self-hosted.');
  }
}
