import {
  AsyncDuckDB,
  type AsyncDuckDBConnection,
  type AsyncPreparedStatement,
  VoidLogger,
} from '@duckdb/duckdb-wasm';
import { toError } from '@csv-viewer/workspace/errors';
import { quoteLiteral, type QueryValues } from '@csv-viewer/workspace/csv-query';
import type { EngineRow } from '@csv-viewer/workspace/csv-result-normalization';
import { Deferred, Effect } from 'effect';
import {
  driverEffect,
  stoppedEngineMessage,
  type DataEngineError,
  type OwnedWorkspaceDatabase,
  type WorkspaceDatabaseConnection,
} from '@csv-viewer/workspace/database';

type DuckDbWasmWorker = NonNullable<ConstructorParameters<typeof AsyncDuckDB>[1]>;
type UntilStopped = <A>(call: Promise<A>) => Promise<A>;
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
 * Every driver call goes through `untilStopped`, so a Worker failure settles it.
 */
class DuckDbWasmConnection implements WorkspaceDatabaseConnection {
  constructor(
    private readonly connection: AsyncDuckDBConnection,
    private readonly untilStopped: UntilStopped,
  ) {}

  runEffect(sql: string, values?: QueryValues): Effect.Effect<void, DataEngineError> {
    return driverEffect(() => this.runStatement(sql, values));
  }

  readObjectsEffect(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError> {
    return driverEffect(() => this.readRows(sql, values));
  }

  runCancellableEffect(sql: string): Effect.Effect<void, DataEngineError> {
    // Draining the pending result completes statements that do not return rows, including CTAS.
    return this.readObjectsCancellableEffect(sql).pipe(Effect.asVoid);
  }

  readObjectsCancellableEffect(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError> {
    return driverEffect(() => this.untilStopped(this.readStreamedRows(sql, values)), {
      cancel: async () => {
        await this.untilStopped(this.connection.cancelSent());
      },
    });
  }

  closeEffect(): Effect.Effect<void, DataEngineError> {
    return driverEffect(() => this.disconnect());
  }

  run(sql: string, values?: QueryValues): Promise<void> {
    return Effect.runPromise(this.runEffect(sql, values));
  }

  readObjects(sql: string, values?: QueryValues): Promise<EngineRow[]> {
    return Effect.runPromise(this.readObjectsEffect(sql, values));
  }

  runCancellable(sql: string): Promise<void> {
    return Effect.runPromise(this.runCancellableEffect(sql));
  }

  readObjectsCancellable(sql: string, values?: QueryValues): Promise<EngineRow[]> {
    return Effect.runPromise(this.readObjectsCancellableEffect(sql, values));
  }

  cancelRunning(): Promise<void> {
    return Effect.runPromise(driverEffect(() => this.untilStopped(this.connection.cancelSent())).pipe(Effect.asVoid));
  }

  close(): Promise<void> {
    return Effect.runPromise(this.closeEffect());
  }

  /** The driver call behind `closeEffect`, for adapter code already inside a driver call. */
  disconnect(): Promise<void> {
    return this.untilStopped(this.connection.close());
  }

  /** The driver call behind `runEffect`, for adapter code already inside a driver call. */
  async runStatement(sql: string, values?: QueryValues): Promise<void> {
    await this.untilStopped(this.query(sql, values));
  }

  /** The driver call behind `readObjectsEffect`, for adapter code already inside a driver call. */
  async readRows(sql: string, values?: QueryValues): Promise<EngineRow[]> {
    const table = await this.untilStopped(this.query(sql, values));
    // SAFETY: Arrow's toJSON returns own fields whose recursive values match EngineCellValue.
    return table.toArray().map((row) => row.toJSON() as EngineRow);
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

  private async readStreamedRows(sql: string, values?: QueryValues): Promise<EngineRow[]> {
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
  }
}

/**
 * One single-threaded, in-memory DuckDB-Wasm Worker and its owner connection. The workspace
 * runtime acquires it with `open` and releases it with the two close steps. A Worker error stops
 * the engine for the rest of the page.
 */
export class DuckDbWasmWorkspaceDatabase implements OwnedWorkspaceDatabase {
  /** Completes once on a Worker error or a cancelled startup; web composition hands it to the workspace. */
  readonly stopped = Deferred.makeUnsafe<void>();
  private database: AsyncDuckDB | null = null;
  private connection: DuckDbWasmConnection | null = null;
  private worker: DuckDbWasmWorker | null = null;
  private fatalError: Error | null = null;
  private fatalCleanup: Promise<Error | null> | null = null;
  private startupReleaseFailed = false;
  private reportLateStartupCleanupFailure: () => void = () => undefined;
  private readonly failedFileDrops = new Set<string>();
  /**
   * Rejects once the engine stops. DuckDB-Wasm drops the requests a failed Worker held without
   * settling them, so every driver call races this to keep interruption from waiting forever.
   */
  private readonly engineStop = Promise.withResolvers<never>();
  private readonly untilStopped: UntilStopped = (call) => Promise.race([call, this.engineStop.promise]);
  private readonly handleWorkerError = (event: ErrorEvent) => {
    this.failFatally(event.error ?? new Error(event.message || 'DuckDB-Wasm Worker failed.'));
  };

  constructor(private readonly options: DuckDbWasmDatabaseOptions) {
    assertLocalAsset(options.mainModule);
    assertLocalAsset(options.mainWorker);
    this.engineStop.promise.catch(() => undefined);
  }

  /**
   * Releases what a failed or interrupted `open` left behind. The Layer finalizer never runs for an
   * acquisition that did not return, so this also fails if `open` failed to release on its own.
   */
  closeStartup(): Effect.Effect<void, DataEngineError> {
    return driverEffect(async () => {
      await this.stopEngine();
      if (this.startupReleaseFailed) throw new Error('The web engine could not be released.');
    });
  }

  /** Reports a failed Worker termination even when its creation resolves after startup exits. */
  onLateStartupCleanupFailure(report: () => void): void {
    this.reportLateStartupCleanupFailure = report;
  }

  /**
   * Starts the Worker and opens the owner connection under the network-isolation settings. The
   * workspace Layer runs the in-memory CSV check and owns release. Interruption stops the engine.
   */
  open(): Effect.Effect<this, DataEngineError> {
    return this.stopEngineOnInterrupt(() => this.start()).pipe(Effect.as(this));
  }

  ownerConnectionEffect(): Effect.Effect<WorkspaceDatabaseConnection, DataEngineError> {
    return driverEffect(async () => this.opened().connection);
  }

  connectWorkerEffect(): Effect.Effect<WorkspaceDatabaseConnection, DataEngineError> {
    return driverEffect(async () => new DuckDbWasmConnection(
      await this.untilStopped(this.opened().database.connect()),
      this.untilStopped,
    ));
  }

  runEffect(sql: string, values?: QueryValues): Effect.Effect<void, DataEngineError> {
    return driverEffect(() => this.opened().connection.runStatement(sql, values));
  }

  readObjectsEffect(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError> {
    return driverEffect(() => this.opened().connection.readRows(sql, values));
  }

  ownerConnection(): Promise<WorkspaceDatabaseConnection> {
    return Effect.runPromise(this.ownerConnectionEffect());
  }

  connectWorker(): Promise<WorkspaceDatabaseConnection> {
    return Effect.runPromise(this.connectWorkerEffect());
  }

  async run(sql: string, values?: QueryValues): Promise<void> {
    await this.opened().connection.run(sql, values);
  }

  async readObjects(sql: string, values?: QueryValues): Promise<EngineRow[]> {
    return this.opened().connection.readObjects(sql, values);
  }

  registerFileBuffer(name: string, contents: Uint8Array): Promise<string> {
    return Effect.runPromise(driverEffect(() => this.registerBuffer(name, contents)));
  }

  dropFile(reference: string): Promise<void> {
    return Effect.runPromise(driverEffect(() => this.dropBuffer(reference)));
  }

  private async registerBuffer(name: string, contents: Uint8Array): Promise<string> {
    const { database } = this.opened();
    await this.retryFailedFileDrops(database);
    const baseName = name.split('/').pop() || 'source.csv';
    const reference = `${sourceDirectory}/${crypto.randomUUID()}-${baseName}`;
    await this.untilStopped(database.registerFileBuffer(reference, contents));
    return reference;
  }

  private async dropBuffer(reference: string): Promise<void> {
    const database = this.database;
    if (!database) return;
    try {
      await this.untilStopped(database.dropFile(reference));
      this.failedFileDrops.delete(reference);
    } catch (error) {
      this.failedFileDrops.add(reference);
      throw error;
    }
  }

  /** Retry transient drop failures before registering another buffer in the same Worker. */
  private async retryFailedFileDrops(database: AsyncDuckDB): Promise<void> {
    for (const reference of this.failedFileDrops) {
      try {
        await this.untilStopped(database.dropFile(reference));
        this.failedFileDrops.delete(reference);
      } catch {
        // The original request reported the release failure; keep the reference for another try.
      }
    }
  }

  closeOwnerConnection(): Effect.Effect<void, DataEngineError> {
    return driverEffect(() => this.releaseOwnerConnection());
  }

  /** Stops the Worker. After a fatal stop, reports the outcome of the termination that stop began. */
  closeEngine(): Effect.Effect<void, DataEngineError> {
    return driverEffect(() => this.stopEngine());
  }

  /** The Layer runs this probe after acquisition and reports its outcome as `web.startup-check`. */
  verifyInMemoryCsvQuery(): Effect.Effect<void, DataEngineError> {
    return this.stopEngineOnInterrupt(async () => {
      // Encoded per call: registering hands the buffer to the Worker, which may detach it.
      const probe = new TextEncoder().encode('ready\ntrue\n');
      const reference = await this.registerBuffer('startup-check.csv', probe);
      let rows: EngineRow[];
      try {
        rows = await this.opened().connection.readRows(
          `SELECT ready FROM read_csv_auto(${quoteLiteral(reference)}, all_varchar = true, header = true)`,
        );
      } finally {
        await this.dropBuffer(reference);
      }
      if (rows.length !== 1 || rows[0]?.ready !== 'true') {
        throw new Error('The browser could not run the required in-memory CSV query.');
      }
    });
  }

  /** Builds and compiles the engine. Overridden where one engine is shared by several databases. */
  protected async createEngine(): Promise<AsyncDuckDB> {
    const worker = await this.options.createWorker(this.options.mainWorker);
    if (this.fatalError) {
      try {
        worker.terminate();
      } catch {
        this.reportLateStartupCleanupFailure();
      }
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
      await database.terminate().catch(() => { this.startupReleaseFailed = true; });
      throw error;
    }
  }

  /** Disposes the engine. Overridden where the caller owns it and resets it instead. */
  protected async releaseEngine(database: AsyncDuckDB): Promise<void> {
    this.stopObservingWorker();
    await database.terminate();
  }

  private async start(): Promise<void> {
    this.throwIfFatal();
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
      const connection = new DuckDbWasmConnection(await database.connect(), this.untilStopped);
      this.connection = connection;
      for (const setting of [
        `SET allowed_directories = ['${sourceDirectory}']`,
        'SET enable_external_access = false',
        'SET allow_community_extensions = false',
        'SET autoinstall_known_extensions = false',
        'SET autoload_known_extensions = false',
        'SET lock_configuration = true',
      ]) {
        await connection.runStatement(setting);
      }
      this.throwIfFatal();
    } catch (error) {
      await this.releaseOwnerConnection().catch(() => { this.startupReleaseFailed = true; });
      await this.stopEngine().catch(() => { this.startupReleaseFailed = true; });
      throw error;
    }
  }

  /** Startup cannot wait on a Worker request that may never settle, so interruption stops the engine. */
  private stopEngineOnInterrupt<A>(operation: () => Promise<A>): Effect.Effect<A, DataEngineError> {
    return driverEffect(operation, {
      abandon: () => this.failFatally(new Error('CSV Viewer Web startup was cancelled.')),
    });
  }

  private async releaseOwnerConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    await connection?.disconnect();
  }

  private async stopEngine(): Promise<void> {
    if (this.fatalCleanup) {
      const failure = await this.fatalCleanup;
      if (failure) throw failure;
      return;
    }
    const database = this.database;
    this.database = null;
    if (database) await this.releaseEngine(database);
  }

  private opened() {
    this.throwIfFatal();
    const { database, connection } = this;
    if (!database || !connection) throw new Error('The data engine is not open.');
    return { database, connection };
  }

  /** Stops the engine once and completes the workspace signal before awaiting termination. */
  private failFatally(cause: unknown): void {
    if (this.fatalError) return;
    this.fatalError = toError(cause);
    const database = this.database;
    this.connection = null;
    this.database = null;
    this.stopObservingWorker();
    this.fatalCleanup = database ? database.terminate().then(() => null, toError) : Promise.resolve(null);
    this.engineStop.reject(new Error(stoppedEngineMessage, { cause: this.fatalError }));
    Deferred.doneUnsafe(this.stopped, Effect.void);
  }

  private throwIfFatal(): void {
    if (this.fatalError) throw new Error(stoppedEngineMessage, { cause: this.fatalError });
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
