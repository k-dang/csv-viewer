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
} from '../src/contracts/csv-viewer';
import { CsvWorkspaceImplementation } from '../src/csv-workspace-implementation';
import { DuckDbWasmWorkspaceDatabase } from '../../../apps/web/src/duckdb-wasm-database';
import {
  CsvSourceUnavailableError,
  defaultDelimiterForSourceName,
  type CsvExportDelivery,
  type CsvExportRequestForDelivery,
  type CsvSourceDescription,
  type CsvWorkspaceHost,
} from '../src/workspace-host';
import type { WorkspaceContractFixture } from './workspace-contract';
import { WorkspaceContractObserver } from './workspace-contract-observer';

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
  readonly capabilities = { recentCsvSources: false } as const;
  private readonly sourcesByName = new Map<string, MemorySource>();
  private readonly sourcesById = new Map<CsvSourceId, MemorySource>();
  private readonly exportNames: string[] = [];
  private readonly exports = new Map<string, string>();

  constructor(private readonly database: DuckDbWasmWorkspaceDatabase) {}

  acquireSource(): Promise<CsvSourceId | null> {
    return Promise.resolve(null);
  }

  async describeSource(sourceId: CsvSourceId): Promise<CsvSourceDescription> {
    const source = this.requireSource(sourceId);
    return {
      sourceId,
      name: source.name,
      location: source.name,
      sizeBytes: encoder.encode(source.contents).byteLength,
      defaultDelimiter: defaultDelimiterForSourceName(source.name),
    };
  }

  async withEngineSource<T>(
    sourceId: CsvSourceId,
    use: (reference: string) => Promise<T>,
  ): Promise<T> {
    const source = this.requireSource(sourceId);
    const extension = source.name.split('.').pop() ?? 'csv';
    return this.database.withRegisteredFile(
      `contract-${crypto.randomUUID()}.${extension}`,
      encoder.encode(source.contents),
      use,
    );
  }

  deliverExport(request: CsvExportRequestForDelivery): Promise<CsvExportDelivery> {
    const name = this.exportNames.shift();
    if (!name) return Promise.resolve({ status: 'cancelled' });
    this.exports.set(name, request.contents);
    return Promise.resolve({ status: 'delivered' });
  }

  recentSources(): Promise<RecentCsvSource[]> {
    return Promise.resolve([]);
  }

  recordRecentSource(): Promise<void> {
    return Promise.resolve();
  }

  confirmDiscardChanges(): Promise<boolean> {
    return Promise.resolve(true);
  }

  writeSource(fileName: string, contents: string): CsvSourceId {
    const existing = this.sourcesByName.get(fileName);
    const source = existing ?? { sourceId: crypto.randomUUID(), name: fileName, contents };
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
      if (contents === undefined) throw new Error(`Export CSV did not deliver ${fileName}.`);
      return contents;
    };
  }

  private requireSource(sourceId: CsvSourceId): MemorySource & { contents: string } {
    const source = this.sourcesById.get(sourceId);
    if (!source || source.contents === null) {
      throw new CsvSourceUnavailableError('missing-source', 'CSV Source is no longer available.');
    }
    return { ...source, contents: source.contents };
  }
}

const nodeWasmOptions = {
  mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm'),
  mainWorker: pathToFileURL(
    require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-mvp.worker.cjs'),
  ).toString(),
  createWorker: (reference: string) => Promise.resolve(new WebWorker(new URL(reference))),
};

/**
 * Compiling the Wasm module costs around half a second, which dwarfs the work a contract case
 * does, so each test file compiles one engine and resets it between cases rather than paying the
 * compile per case. `vitest.setup.ts` terminates it once the file finishes.
 */
let sharedEngine: Promise<{ engine: AsyncDuckDB; closed: Promise<void> }> | null = null;

function acquireSharedEngine(): Promise<AsyncDuckDB> {
  sharedEngine ??= (async () => {
    // SAFETY: web-worker's Node implementation emits `close` after its worker thread exits.
    const worker = new WebWorker(new URL(nodeWasmOptions.mainWorker)) as NodeWebWorker;
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
 * Shares the file's compiled engine. Releasing drops the registered files, which outlive the
 * database itself, and reopening gives the next database an empty `:memory:` database.
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
    private readonly workspace: CsvWorkspaceImplementation,
    private readonly host: WasmContractHost,
  ) {
    this.observer = new WorkspaceContractObserver(workspace);
  }

  get viewer(): CsvViewer {
    return this.workspace;
  }

  static async create(): Promise<WasmWorkspaceFixture> {
    const database = new SharedEngineWasmDatabase();
    const host = new WasmContractHost(database);
    const workspace = new CsvWorkspaceImplementation(host, database);
    return new WasmWorkspaceFixture(workspace, host);
  }

  registerSource(fileName: string, contents: string): Promise<CsvSourceId> {
    return Promise.resolve(this.host.writeSource(fileName, contents));
  }

  removeSource(fileName: string): Promise<void> {
    this.host.removeSource(fileName);
    return Promise.resolve();
  }

  /** Registers a CSV Source and opens it as a Working CSV. */
  async openSource(
    fileName: string,
    contents: string,
    options?: CsvDialectOptions,
  ): Promise<WorkingCsvView> {
    const sourceId = await this.registerSource(fileName, contents);
    const result = await this.viewer.call({ operation: 'csv.open-recent', sourceId, options });
    if (result.status !== 'opened') {
      throw new Error(
        result.status === 'failed' ? result.message : `CSV Source was ${result.status}.`,
      );
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
