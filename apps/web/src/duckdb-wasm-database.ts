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
const sourceDirectory = '/csv-viewer-sources';

export type DuckDbWasmDatabaseOptions = {
  mainModule: string;
  mainWorker: string;
  createWorker(reference: string): Promise<DuckDbWasmWorker>;
};

/**
 * DuckDB-Wasm drops pending requests when its Worker fails. Reject them here so queries and
 * interruption can settle after an engine stop.
 */
class EngineCalls {
  private readonly pending = new Set<(error: Error) => void>();
  private stopError: Error | null = null;

  get stoppedError(): Error | null {
    return this.stopError;
  }

  effect<A>(operation: () => Promise<A>, cancel?: () => Promise<void>): Effect.Effect<A, DataEngineError> {
    return driverEffect(() => this.track(operation), cancel && (() => this.track(cancel)));
  }

  track<A>(call: () => Promise<A>): Promise<A> {
    if (this.stopError) return Promise.reject(this.stopError);
    return new Promise<A>((resolve, reject) => {
      this.pending.add(reject);
      let started: Promise<A>;
      try {
        started = call();
      } catch (error) {
        started = Promise.reject(error);
      }
      started.then(resolve, reject).finally(() => this.pending.delete(reject));
    });
  }

  stop(error: Error): void {
    this.stopError = error;
    for (const reject of this.pending) reject(error);
    this.pending.clear();
  }
}

/**
 * DuckDB-Wasm's connection API differs in three places that matter here: parameter binding uses
 * prepared statements, rows arrive as Arrow values, and cancellable work uses send/cancelSent.
 * `send` holds the connection's single result stream, so only the cancellable methods use it -
 * routing every statement through it would stop the owner connection serving concurrent queries.
 */
class DuckDbWasmConnection implements WorkspaceDatabaseConnection {
  constructor(
    private readonly connection: AsyncDuckDBConnection,
    private readonly calls: EngineCalls,
  ) {}

  run(sql: string, values?: QueryValues): Effect.Effect<void, DataEngineError> {
    return this.calls.effect(() => this.runStatement(sql, values));
  }

  readObjects(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError> {
    return this.calls.effect(() => this.readRows(sql, values));
  }

  runCancellable(sql: string): Effect.Effect<void, DataEngineError> {
    // Draining the pending result completes statements that do not return rows, including CTAS.
    return this.readObjectsCancellable(sql).pipe(Effect.asVoid);
  }

  readObjectsCancellable(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError> {
    return Effect.suspend(() => {
      let cancelled = false;
      return this.calls.effect(() => this.readStreamedRows(sql, values, () => cancelled), async () => {
        cancelled = true;
        await this.connection.cancelSent();
      });
    });
  }

  close(): Effect.Effect<void, DataEngineError> {
    return this.calls.effect(() => this.disconnect());
  }

  /** Raw driver calls for operations already tracked by EngineCalls. */
  disconnect(): Promise<void> {
    return this.connection.close();
  }

  async runStatement(sql: string, values?: QueryValues): Promise<void> {
    await this.query(sql, values);
  }

  async readRows(sql: string, values?: QueryValues): Promise<EngineRow[]> {
    const table = await this.query(sql, values);
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

  private async readStreamedRows(sql: string, values: QueryValues | undefined, isCancelled: () => boolean): Promise<EngineRow[]> {
    let statement: AsyncPreparedStatement | undefined;
    try {
      let stream: Awaited<ReturnType<AsyncDuckDBConnection['send']>>;
      if (values?.length) {
        statement = await this.connection.prepare(sql);
        if (isCancelled()) return [];
        stream = await statement.send(...values);
      } else {
        stream = await this.connection.send(sql);
      }
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
  private fatalCleanup: Promise<Error | null> | null = null;
  private startupReleaseFailed = false;
  private reportLateStartupCleanupFailure: () => void = () => undefined;
  private readonly failedFileDrops = new Set<string>();
  private readonly calls = new EngineCalls();
  private readonly handleWorkerError = (event: ErrorEvent) => {
    this.failFatally(event.error ?? new Error(event.message || 'DuckDB-Wasm Worker failed.'));
  };

  constructor(private readonly options: DuckDbWasmDatabaseOptions) {
    assertLocalAsset(options.mainModule);
    assertLocalAsset(options.mainWorker);
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

  ownerConnection(): Effect.Effect<DuckDbWasmConnection, DataEngineError> {
    return this.calls.effect(async () => this.opened().connection);
  }

  connectWorker(): Effect.Effect<WorkspaceDatabaseConnection, DataEngineError> {
    return this.calls.effect(async () => new DuckDbWasmConnection(await this.opened().database.connect(), this.calls));
  }

  run(sql: string, values?: QueryValues): Effect.Effect<void, DataEngineError> {
    return this.ownerConnection().pipe(Effect.flatMap((connection) => connection.run(sql, values)));
  }

  readObjects(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError> {
    return this.ownerConnection().pipe(Effect.flatMap((connection) => connection.readObjects(sql, values)));
  }

  registerFileBuffer(name: string, contents: Uint8Array): Promise<string> {
    return Effect.runPromise(this.calls.effect(() => this.registerBuffer(name, contents)));
  }

  dropFile(reference: string): Promise<void> {
    return Effect.runPromise(this.calls.effect(() => this.dropBuffer(reference)));
  }

  private async registerBuffer(name: string, contents: Uint8Array): Promise<string> {
    const { database } = this.opened();
    await this.retryFailedFileDrops(database);
    const baseName = name.split('/').pop() || 'source.csv';
    const reference = `${sourceDirectory}/${crypto.randomUUID()}-${baseName}`;
    await database.registerFileBuffer(reference, contents);
    return reference;
  }

  private async dropBuffer(reference: string): Promise<void> {
    const database = this.database;
    if (!database) return;
    try {
      await database.dropFile(reference);
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
        await database.dropFile(reference);
        this.failedFileDrops.delete(reference);
      } catch {
        // The original request reported the release failure; keep the reference for another try.
      }
    }
  }

  /** After a fatal stop there is no connection left to close, so release succeeds at once. */
  closeOwnerConnection(): Effect.Effect<void, DataEngineError> {
    return Effect.suspend(() => this.connection ? this.calls.effect(() => this.releaseOwnerConnection()) : Effect.void);
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
    if (this.calls.stoppedError) {
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
      const connection = new DuckDbWasmConnection(await database.connect(), this.calls);
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

  /** Interrupting startup stops the engine, which settles the tracked startup work at once. */
  private stopEngineOnInterrupt<A>(operation: () => Promise<A>): Effect.Effect<A, DataEngineError> {
    return driverEffect(() => this.calls.track(operation), async () => {
      this.failFatally(new Error('CSV Viewer Web startup was cancelled.'));
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
    if (this.calls.stoppedError) return;
    const stoppedError = new Error(stoppedEngineMessage, { cause: toError(cause) });
    const database = this.database;
    this.connection = null;
    this.database = null;
    this.stopObservingWorker();
    this.fatalCleanup = database ? database.terminate().then(() => null, toError) : Promise.resolve(null);
    this.calls.stop(stoppedError);
    Deferred.doneUnsafe(this.stopped, Effect.void);
  }

  private throwIfFatal(): void {
    const { stoppedError } = this.calls;
    if (stoppedError) throw stoppedError;
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
