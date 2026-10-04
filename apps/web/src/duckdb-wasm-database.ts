import {
  AsyncDuckDB,
  type AsyncDuckDBConnection,
  type AsyncPreparedStatement,
  VoidLogger,
} from '@duckdb/duckdb-wasm';
import { toError } from '@csv-viewer/workspace/errors';
import { quoteLiteral, type QueryValues } from '@csv-viewer/workspace/csv-query';
import type { EngineRow } from '@csv-viewer/workspace/csv-result-normalization';
import { Deferred, Effect, type Scope } from 'effect';
import {
  driverEffect,
  releaseOnClose,
  stoppedEngineMessage,
  DataEngineError,
  type WorkspaceDatabase,
  type WorkspaceDatabaseConnection,
} from '@csv-viewer/workspace/database';
import { observeCleanup, observeStage } from '@csv-viewer/workspace/workspace-diagnostics';

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
    const { promise, resolve, reject } = Promise.withResolvers<A>();
    this.pending.add(reject);
    (async () => call())().then(resolve, reject).finally(() => this.pending.delete(reject));
    return promise;
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
          if (rows.length % 512 === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (isCancelled()) return rows;
          }
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
 * One single-threaded, in-memory DuckDB-Wasm Worker and its owner connection, held from `open`
 * until its scope closes. A Worker error stops the engine for the rest of the page.
 */
export class DuckDbWasmWorkspaceDatabase implements WorkspaceDatabase {
  /** Completes once on a Worker error or a cancelled startup; web composition hands it to the workspace. */
  readonly stopped = Deferred.makeUnsafe<void>();
  private database: AsyncDuckDB | null = null;
  private connection: DuckDbWasmConnection | null = null;
  private worker: DuckDbWasmWorker | null = null;
  private fatalCleanup: Promise<Error | null> | null = null;
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
   * Starts the engine, then proves its in-memory CSV path as `web.startup-check`. Both release
   * steps are registered first and do nothing until their resource exists, so closing the scope
   * closes the owner connection, then stops the engine, whether startup finished, failed, or was
   * interrupted. Interrupting startup stops the engine.
   */
  open(): Effect.Effect<this, DataEngineError, Scope.Scope> {
    return Effect.gen({ self: this }, function* () {
      yield* releaseOnClose('engine', this.closeEngine());
      yield* releaseOnClose('connection', this.closeOwnerConnection());
      yield* this.start();
      yield* observeStage('web.startup-check', this.verifyInMemoryCsvQuery());
      return this;
    });
  }

  /** Starts the Worker and opens the owner connection under the network-isolation settings. */
  protected start(): Effect.Effect<void, DataEngineError> {
    return Effect.gen({ self: this }, function* () {
      const database = yield* this.createEngine();
      this.database = database;
      yield* this.startup(() => database.open({
        path: ':memory:',
        maximumThreads: 1,
        allowUnsignedExtensions: false,
        query: { castBigIntToDouble: false },
        filesystem: { allowFullHTTPReads: false, forceFullHTTPReads: false },
        opfs: { fileHandling: 'manual' },
      }));
      yield* this.startup(async () => {
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
      });
    });
  }

  ownerConnection(): Effect.Effect<DuckDbWasmConnection, DataEngineError> {
    return Effect.try({
      try: () => this.opened().connection,
      catch: (cause) => new DataEngineError({ cause }),
    });
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

  registerFileBuffer(name: string, contents: Uint8Array): Effect.Effect<string, DataEngineError> {
    return this.calls.effect(() => this.registerBuffer(name, contents));
  }

  dropFile(reference: string): Effect.Effect<void, DataEngineError> {
    return this.calls.effect(() => this.dropBuffer(reference));
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

  /** The owner connection's release step. After a fatal stop there is no connection left to close. */
  protected closeOwnerConnection(): Effect.Effect<void, DataEngineError> {
    return Effect.suspend(() => this.connection ? this.calls.effect(() => this.releaseOwnerConnection()) : Effect.void);
  }

  /** The engine's release step. After a fatal stop, reports the outcome of the termination that stop began. */
  protected closeEngine(): Effect.Effect<void, DataEngineError> {
    return driverEffect(() => this.stopEngine());
  }

  protected verifyInMemoryCsvQuery(): Effect.Effect<void, DataEngineError> {
    return this.startup(async () => {
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

  /**
   * Builds and compiles the engine. The engine is reachable while it instantiates: a Worker error
   * clears DuckDB-Wasm's pending request without rejecting it, so the fatal stop and the engine
   * release step must be able to terminate it. Overridden where one engine is shared by several
   * databases; an override need not set `database`, which `start` assigns.
   */
  protected createEngine(): Effect.Effect<AsyncDuckDB, DataEngineError> {
    return Effect.gen({ self: this }, function* () {
      const worker = yield* this.createWorker();
      this.worker = worker;
      worker.addEventListener('error', this.handleWorkerError);
      const database = new AsyncDuckDB(new VoidLogger(), worker);
      this.database = database;
      yield* this.startup(() => database.instantiate(this.options.mainModule));
      return database;
    });
  }

  /** Disposes the engine. Overridden where the caller owns it and resets it instead. */
  protected async releaseEngine(database: AsyncDuckDB): Promise<void> {
    this.stopObservingWorker();
    await database.terminate();
  }

  /**
   * Waits for the Worker without holding up interruption. Unlike `driverEffect`, interruption does
   * not wait for creation to settle, because a pending Worker creation cannot be cancelled. It stops
   * the engine instead, and a Worker that arrives afterwards is terminated as its own cleanup stage.
   */
  private createWorker(): Effect.Effect<DuckDbWasmWorker, DataEngineError> {
    return Effect.callback<DuckDbWasmWorker, DataEngineError>((resume) => {
      const creating = (async () => this.options.createWorker(this.options.mainWorker))();
      creating.then(
        (worker) => resume(Effect.succeed(worker)),
        (cause) => resume(Effect.fail(new DataEngineError({ cause }))),
      );
      return Effect.suspend(() => {
        this.cancelStartup();
        const late = Effect.promise(() => creating.catch(() => null)).pipe(
          Effect.flatMap((worker) => worker ? Effect.try(() => worker.terminate()) : Effect.void),
        );
        return Effect.forkDetach(observeCleanup('web.startup-late-cleanup', late));
      }).pipe(Effect.asVoid);
    });
  }

  /** A startup call. Interrupting it stops the engine, which settles the call at once. */
  private startup<A>(operation: () => Promise<A>): Effect.Effect<A, DataEngineError> {
    return driverEffect(() => this.calls.track(operation), async () => this.cancelStartup());
  }

  private cancelStartup(): void {
    this.failFatally(new Error('CSV Viewer Web startup was cancelled.'));
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
