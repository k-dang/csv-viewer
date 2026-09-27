import {
  AsyncDuckDB,
  type AsyncDuckDBConnection,
  type AsyncPreparedStatement,
  VoidLogger,
} from '@duckdb/duckdb-wasm';
import { toError } from '@csv-viewer/workspace/errors';
import { quoteLiteral, type QueryValues } from '@csv-viewer/workspace/csv-query';
import type { EngineRow } from '@csv-viewer/workspace/csv-result-normalization';
import {
  normalizeDatabaseOperation,
  type OwnedWorkspaceDatabase,
  type WorkspaceDatabaseConnection,
} from '@csv-viewer/workspace/database';

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

/**
 * One single-threaded, in-memory DuckDB-Wasm Worker and its owner connection. The workspace
 * runtime acquires it with `open` and releases it with the two close steps. A Worker error stops
 * the engine for the rest of the page.
 */
export class DuckDbWasmWorkspaceDatabase implements OwnedWorkspaceDatabase {
  private database: AsyncDuckDB | null = null;
  private connection: DuckDbWasmConnection | null = null;
  private worker: DuckDbWasmWorker | null = null;
  private fatalError: Error | null = null;
  private fatalCleanup: Promise<Error | null> | null = null;
  private readonly fatalErrorListeners = new Set<(error: Error) => void>();
  private readonly handleWorkerError = (event: ErrorEvent) => {
    this.failFatally(event.error ?? new Error(event.message || 'DuckDB-Wasm Worker failed.'));
  };

  constructor(private readonly options: DuckDbWasmDatabaseOptions) {
    assertLocalAsset(options.mainModule);
    assertLocalAsset(options.mainWorker);
  }

  /**
   * Starts the Worker, opens the owner connection under the network-isolation settings, and proves
   * the in-memory CSV path. A failure releases whatever it started before rejecting.
   */
  async open(): Promise<this> {
    await normalizeDatabaseOperation(async () => {
      const database = await this.createEngine();
      this.throwIfFatal();
      this.database = database;
      try {
        await database.open({
          path: ':memory:',
          maximumThreads: 1,
          allowUnsignedExtensions: false,
          query: { castBigIntToDouble: false },
          filesystem: { allowFullHTTPReads: false, forceFullHTTPReads: false },
          opfs: { fileHandling: 'manual' },
        });
        const connection = new DuckDbWasmConnection(await database.connect());
        this.connection = connection;
        await connection.run(`SET allowed_directories = ['${sourceDirectory}']`);
        await connection.run('SET enable_external_access = false');
        await connection.run('SET allow_community_extensions = false');
        await connection.run('SET autoinstall_known_extensions = false');
        await connection.run('SET autoload_known_extensions = false');
        await connection.run('SET lock_configuration = true');
        this.throwIfFatal();
        await this.verifyInMemoryCsvQuery();
      } catch (error) {
        await this.closeOwnerConnection().catch(() => undefined);
        await this.closeEngine().catch(() => undefined);
        throw error;
      }
    });
    return this;
  }

  async ownerConnection(): Promise<WorkspaceDatabaseConnection> {
    return this.opened().connection;
  }

  async connectWorker(): Promise<WorkspaceDatabaseConnection> {
    const { database } = this.opened();
    return normalizeDatabaseOperation(async () =>
      new DuckDbWasmConnection(await database.connect()),
    );
  }

  /** Reports an unrecoverable Worker failure once for the lifetime of this database. */
  onFatalError(listener: (error: Error) => void): () => void {
    this.fatalErrorListeners.add(listener);
    if (this.fatalError) listener(this.fatalError);
    return () => this.fatalErrorListeners.delete(listener);
  }

  async run(sql: string, values?: QueryValues): Promise<void> {
    await this.opened().connection.run(sql, values);
  }

  async readObjects(sql: string, values?: QueryValues): Promise<EngineRow[]> {
    return this.opened().connection.readObjects(sql, values);
  }

  async registerFileBuffer(name: string, contents: Uint8Array): Promise<string> {
    const { database } = this.opened();
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

  /** Interrupts startup without waiting for a Worker request that may never settle. */
  cancelStartup(): void {
    this.failFatally(new Error('CSV Viewer Web startup was cancelled.'));
  }

  async closeOwnerConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    await connection?.close();
  }

  /** Stops the Worker. After a fatal stop, reports the outcome of the termination that stop began. */
  async closeEngine(): Promise<void> {
    if (this.fatalCleanup) {
      const failure = await this.fatalCleanup;
      if (failure) throw failure;
      return;
    }
    const database = this.database;
    this.database = null;
    if (database) await normalizeDatabaseOperation(() => this.releaseEngine(database));
  }

  /** Builds and compiles the engine. Overridden where one engine is shared by several databases. */
  protected async createEngine(): Promise<AsyncDuckDB> {
    const worker = await this.options.createWorker(this.options.mainWorker);
    if (this.fatalError) {
      worker.terminate();
      this.throwIfFatal();
    }
    this.worker = worker;
    worker.addEventListener('error', this.handleWorkerError);
    const database = new AsyncDuckDB(new VoidLogger(), worker);
    // Keep the engine reachable while it instantiates. A Worker error clears DuckDB-Wasm's
    // pending request without rejecting it, so the fatal path must be able to terminate this
    // otherwise stranded engine.
    this.database = database;
    try {
      await database.instantiate(this.options.mainModule);
      return database;
    } catch (error) {
      if (this.database === database) this.database = null;
      this.stopObservingWorker();
      await database.terminate().catch(() => undefined);
      throw error;
    }
  }

  /** Disposes the engine. Overridden where the caller owns it and resets it instead. */
  protected async releaseEngine(database: AsyncDuckDB): Promise<void> {
    this.stopObservingWorker();
    await database.terminate();
  }

  private async verifyInMemoryCsvQuery(): Promise<void> {
    // Encoded per call: registering hands the buffer to the Worker, which may detach it.
    const probe = new TextEncoder().encode('ready\ntrue\n');
    const rows = await this.withRegisteredFile('startup-check.csv', probe, (reference) =>
      this.readObjects(
        `SELECT ready FROM read_csv_auto(${quoteLiteral(reference)}, all_varchar = true, header = true)`,
      ),
    );
    if (rows.length !== 1 || rows[0]?.ready !== 'true') {
      throw new Error('The browser could not run the required in-memory CSV query.');
    }
  }

  private opened() {
    this.throwIfFatal();
    const { database, connection } = this;
    if (!database || !connection) throw new Error('The data engine is not open.');
    return { database, connection };
  }

  private failFatally(cause: unknown): void {
    if (this.fatalError) return;
    this.fatalError = toError(cause);
    const database = this.database;
    this.connection = null;
    this.database = null;
    this.stopObservingWorker();
    this.fatalCleanup = database ? database.terminate().then(() => null, toError) : Promise.resolve(null);
    for (const listener of this.fatalErrorListeners) listener(this.fatalError);
  }

  private throwIfFatal(): void {
    if (this.fatalError) {
      throw new Error('The data engine has stopped. Reload CSV Viewer to start a new workspace.', {
        cause: this.fatalError,
      });
    }
  }

  private stopObservingWorker(): void {
    this.worker?.removeEventListener('error', this.handleWorkerError);
    this.worker = null;
  }
}

function assertLocalAsset(reference: string): void {
  if (/^(?:https?:)?\/\//i.test(reference)) {
    throw new Error('DuckDB-Wasm executable assets must be self-hosted.');
  }
}
