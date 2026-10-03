import { Effect } from 'effect';
import { DataEngineError } from '../../../../packages/workspace/src/database';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { AsyncDuckDB, VoidLogger } from '@duckdb/duckdb-wasm';
import WebWorker from 'web-worker';
import type {
  ComparisonAttemptOutcomeView,
  ComparisonId,
  ComparisonOperationId,
  ComparisonView,
  ConfirmWorkspaceCloseOutcome,
  CsvDialectOptions,
  CsvEditState,
  CsvSourceId,
  CsvViewer,
  RecentCsvSource,
  WorkingCsvId,
  WorkingCsvView,
  WorkspaceCloseImpact,
} from '../../../../packages/workspace/src/csv-viewer';
import { createCsvViewer, type CsvWorkspaceOwner } from '../../../../packages/workspace/src/csv-workspace';
import type { WorkspaceDiagnostics } from '../../../../packages/workspace/src/workspace-diagnostics';
import type { ComparisonExecutor } from '../../../../packages/workspace/src/comparison/comparison-executor';
import { DuckDbWasmWorkspaceDatabase } from '../../src/duckdb-wasm-database';
import { scopedEngineSource } from '../../../../packages/workspace/src/engine-source';
import {
  CsvSourceUnavailableError,
  defaultDelimiterForSourceName,
  type CsvExportDelivery,
  type CsvExportRequestForDelivery,
  type CsvSourceDescription,
  type CsvWorkspaceHost,
} from '../../../../packages/workspace/src/workspace-host';
import type { WorkspaceContractFixture } from '../../../../packages/workspace/test/contract/workspace-contract';
import { WorkspaceContractObserver } from '../../../../packages/workspace/test/contract/workspace-contract-observer';
import { failNextExportPreparation, failNextExportWorkerRelease, failNextCsvLoad, failNextDatabaseRelease, failNextMetadataRead, failNextSnapshotDrop, failNextTableDrop, holdNextExportRead, holdNextRowRead } from '../../../../packages/workspace/test/contract/database-failure-injection';

const require = createRequire(`${process.cwd()}/package.json`);
const encoder = new TextEncoder();

type MemorySource = {
  sourceId: CsvSourceId;
  name: string;
  contents: string | null;
};

type NodeWebWorker = InstanceType<typeof WebWorker> & {
  addEventListener(type: 'close', listener: () => void): void;
};

class WasmContractHost implements CsvWorkspaceHost {
  readonly capabilities = {
    recentCsvSources: false,
    exportCsvSuccessMessage: 'Export complete',
    warnOnPageUnload: false,
  } as const;
  private readonly sourcesByName = new Map<string, MemorySource>();
  private readonly sourcesById = new Map<CsvSourceId, MemorySource>();
  private readonly exportNames: string[] = [];
  private readonly exports = new Map<string, string>();

  constructor(private readonly database: DuckDbWasmWorkspaceDatabase) {}

  acquireSource(): Effect.Effect<CsvSourceId | null> {
    return Effect.succeed(null);
  }

  releaseSource(): void {
    // Contract fixtures remain available for subsequent source selections.
  }

  describeSource(sourceId: CsvSourceId) {
    return this.requireSource(sourceId).pipe(Effect.map((source) => ({
      sourceId,
      name: source.name,
      location: source.name,
      sizeBytes: encoder.encode(source.contents).byteLength,
      defaultDelimiter: defaultDelimiterForSourceName(source.name),
    } satisfies CsvSourceDescription)));
  }

  acquireEngineSource(sourceId: CsvSourceId) {
    return scopedEngineSource(Effect.gen({ self: this }, function* () {
      const source = yield* this.requireSource(sourceId);
      const extension = source.name.split('.').pop() ?? 'csv';
      return yield* this.database.registerFileBuffer(`contract-${crypto.randomUUID()}.${extension}`, encoder.encode(source.contents));
    }), (reference) => this.database.dropFile(reference));
  }

  deliverExport(request: CsvExportRequestForDelivery) {
    return Effect.sync(() => {
      const name = this.exportNames.shift();
      if (!name) return { status: 'cancelled' } satisfies CsvExportDelivery;
      this.exports.set(name, request.contents);
      return { status: 'delivered' } satisfies CsvExportDelivery;
    });
  }

  recentSources(): Effect.Effect<RecentCsvSource[]> {
    return Effect.succeed([]);
  }

  recordRecentSource() {
    return Effect.void;
  }

  confirmDiscardChanges() {
    return Effect.succeed(true);
  }

  writeSource(fileName: string, contents: string): CsvSourceId {
    const existing = this.sourcesByName.get(fileName);
    const source = existing ?? {
      sourceId: crypto.randomUUID(),
      name: fileName,
      contents,
    };
    source.contents = contents;
    this.sourcesByName.set(fileName, source);
    this.sourcesById.set(source.sourceId, source);
    return source.sourceId;
  }

  removeSource(fileName: string): void {
    const source = this.sourcesByName.get(fileName);
    if (source) source.contents = null;
  }

  captureNextExport(fileName: string): () => Promise<string> {
    this.exportNames.push(fileName);
    return async () => {
      const contents = this.exports.get(fileName);
      if (contents === undefined)
        throw new Error(`Export CSV did not deliver ${fileName}.`);
      return contents;
    };
  }

  private requireSource(sourceId: CsvSourceId) {
    return Effect.suspend(() => {
      const source = this.sourcesById.get(sourceId);
      if (!source || source.contents === null) {
        return Effect.fail(new CsvSourceUnavailableError({ code: 'missing-source', message: 'CSV Source is no longer available.' }));
      }
      return Effect.succeed({ ...source, contents: source.contents });
    });
  }
}

/**
 * DuckDB-Wasm's Worker `console.log`s every error it hands back, and a Worker thread writes to the
 * process streams rather than through Vitest, so the thread starts on a bootstrap that stubs
 * `console.log` before importing the real Worker script. Errors still arrive as rejections.
 */
function createQuietWorker(reference: string): NodeWebWorker {
  const bootstrap = `console.log = () => {}; await import(${JSON.stringify(reference)});`;
  // SAFETY: web-worker's Node implementation emits `close` after its worker thread exits.
  return new WebWorker(`data:text/javascript,${encodeURIComponent(bootstrap)}`, { type: 'module', }) as NodeWebWorker;
}

export const nodeWasmOptions = {
  mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'),
  mainWorker: pathToFileURL(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-eh.worker.cjs')).toString(),
  createWorker: (reference: string) =>
    Promise.resolve(createQuietWorker(reference)),
};

/**
 * Compiling the Wasm module costs around half a second, which dwarfs the work a contract case
 * does, so each test file compiles one engine and resets it between cases rather than paying the
 * compile per case. `vitest.setup.ts` terminates it once the file finishes.
 */
let sharedEngine: Promise<{
  engine: AsyncDuckDB;
  closed: Promise<void>;
}> | null = null;

function acquireSharedEngine(): Promise<AsyncDuckDB> {
  sharedEngine ??= (async () => {
    const worker = createQuietWorker(nodeWasmOptions.mainWorker);
    const closed = new Promise<void>((resolve) => {
      worker.addEventListener('close', resolve);
    });
    const engine = new AsyncDuckDB(new VoidLogger(), worker);
    await engine.instantiate(nodeWasmOptions.mainModule);
    return { engine, closed };
  })();
  return sharedEngine.then(({ engine }) => engine);
}

/**
 * Terminates the file's shared engine, if any case in the file created one. Terminating returns
 * before the worker thread has actually exited, so this waits for the exit as well - otherwise
 * workers accumulate across the files sharing a Vitest process.
 */
export async function closeSharedWasmEngine(): Promise<void> {
  const pending = sharedEngine;
  if (!pending) return;
  sharedEngine = null;
  const { engine, closed } = await pending;
  await engine.terminate();
  await closed;
}

/**
 * Shares the file's compiled engine. Releasing the engine drops the registered files, which
 * outlive the database itself, and the next `open` gives its database an empty `:memory:` database.
 */
export class SharedEngineWasmDatabase extends DuckDbWasmWorkspaceDatabase {
  constructor() {
    super(nodeWasmOptions);
  }

  protected createEngine(): Promise<AsyncDuckDB> {
    return acquireSharedEngine();
  }

  protected async releaseEngine(database: AsyncDuckDB): Promise<void> {
    await database.dropFiles();
  }
}

/** The single-threaded Wasm build the browser ships, hosted on Node's Worker implementation. */
export function createNodeDuckDbWasmDatabase(): DuckDbWasmWorkspaceDatabase {
  return new DuckDbWasmWorkspaceDatabase(nodeWasmOptions);
}

/** Node-hosted contract fixture for the same single-threaded Wasm build used by the browser. */
export class WasmWorkspaceFixture implements WorkspaceContractFixture {
  private readonly observer: WorkspaceContractObserver;

  private constructor(
    private readonly workspace: CsvWorkspaceOwner,
    private readonly database: DuckDbWasmWorkspaceDatabase,
    private readonly host: WasmContractHost,
  ) {
    this.observer = new WorkspaceContractObserver(workspace);
  }

  get viewer(): CsvViewer {
    return this.workspace;
  }

  static async create(executor?: ComparisonExecutor, diagnostics?: WorkspaceDiagnostics): Promise<WasmWorkspaceFixture> {
    const database = new SharedEngineWasmDatabase();
    const host = new WasmContractHost(database);
    const workspace = await createCsvViewer(database.open(), host, { executor, diagnostics });
    return new WasmWorkspaceFixture(workspace, database, host);
  }

  failNextMetadataRead(): void { failNextMetadataRead(this.database); }
  failNextCsvLoad(): void { failNextCsvLoad(this.database); }

  failNextExportPreparation(failure: 'read' | 'serialization') { return failNextExportPreparation(this.database, failure); }

  failNextExportWorkerRelease(failures: number) { return failNextExportWorkerRelease(this.database, failures); }

  failNextTableDrop(): void { failNextTableDrop(this.database); }
  failNextEngineSourceRelease(): void {
    const original = this.database.dropFile.bind(this.database);
    this.database.dropFile = () => Effect.suspend(() => {
      this.database.dropFile = original;
      return Effect.fail(new DataEngineError({ cause: new Error('PRIVATE engine source reference at C:\\PRIVATE.csv') }));
    });
  }
  failNextDatabaseRelease(): void { failNextDatabaseRelease(this.database); }
  failNextDescribeSource(): void {
    const describeSource = this.host.describeSource.bind(this.host);
    this.host.describeSource = () => {
      this.host.describeSource = describeSource;
      return Effect.die(new Error('PRIVATE SQL SELECT * FROM secrets at C:\\PRIVATE.csv', {
        cause: new Error('PRIVATE nested driver detail'),
      }));
    };
  }
  failNextRecentSources(): void {
    const recentSources = this.host.recentSources.bind(this.host);
    this.host.recentSources = () => {
      this.host.recentSources = recentSources;
      throw new Error('PRIVATE SQL SELECT * FROM secrets at C:\\PRIVATE.csv', {
        cause: new Error('PRIVATE nested driver detail'),
      });
    };
  }

  failNextSnapshotDrop(mode?: 'failure' | 'defect'): Promise<void> { return failNextSnapshotDrop(this.database, mode); }

  holdNextRowRead() { return holdNextRowRead(this.database); }
  holdNextExportRead() { return holdNextExportRead(this.database); }

  registerSource(fileName: string, contents: string): Promise<CsvSourceId> {
    return Promise.resolve(this.host.writeSource(fileName, contents));
  }

  removeSource(fileName: string): Promise<void> {
    this.host.removeSource(fileName);
    return Promise.resolve();
  }

  /** Registers a CSV Source and opens it as a Working CSV. */
  async openSource(fileName: string, contents: string, options?: CsvDialectOptions): Promise<WorkingCsvView> {
    const sourceId = await this.registerSource(fileName, contents);
    const result = await this.viewer.call({
      operation: 'csv.open-recent',
      sourceId,
      options,
    });
    if (result.status !== 'opened') {
      throw new Error(result.status === 'failed' ? result.message : `CSV Source was ${result.status}.`);
    }
    return result.workingCsv;
  }

  writeSource(fileName: string, contents: string): Promise<string> {
    return Promise.resolve(this.host.writeSource(fileName, contents));
  }

  captureNextExport(fileName: string): () => Promise<string> {
    return this.host.captureNextExport(fileName);
  }

  editState(workingCsvId: WorkingCsvId): Promise<CsvEditState> {
    return this.viewer.call({ operation: 'csv.get-edit-state', workingCsvId });
  }

  latestComparison(comparisonId: ComparisonId): ComparisonView | null {
    return this.observer.latestComparison(comparisonId);
  }

  confirmClose(confirmedImpact?: WorkspaceCloseImpact): Promise<ConfirmWorkspaceCloseOutcome> {
    return this.workspace.confirmClose(confirmedImpact);
  }

  async disposeWorkspace(): Promise<void> {
    await this.workspace.dispose();
  }

  awaitComparisonOutcome(operationId: ComparisonOperationId): Promise<ComparisonAttemptOutcomeView> {
    return this.observer.awaitComparisonOutcome(operationId);
  }

  async dispose(): Promise<void> {
    this.observer.dispose();
    await this.disposeWorkspace();
  }
}
