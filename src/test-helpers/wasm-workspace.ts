import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
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
} from '../shared/csv-viewer-contract';
import { CsvWorkspaceImplementation } from '../workspace/csv-workspace-implementation';
import { DuckDbWasmWorkspaceDatabase } from '../workspace/duckdb/duckdb-wasm-database';
import {
  CsvSourceUnavailableError,
  type CsvExportDelivery,
  type CsvExportRequestForDelivery,
  type CsvSourceDescription,
  type CsvWorkspaceHost,
} from '../workspace/workspace-host';
import type { WorkspaceContractFixture } from './workspace-contract';
import { WorkspaceContractObserver } from './workspace-contract-observer';

const require = createRequire(`${process.cwd()}/package.json`);
const encoder = new TextEncoder();

type MemorySource = {
  sourceId: CsvSourceId;
  name: string;
  contents: string | null;
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
      defaultDelimiter: source.name.toLowerCase().endsWith('.tsv') ? '\t' : ',',
    };
  }

  async withEngineSource<T>(
    sourceId: CsvSourceId,
    use: (reference: string) => Promise<T>,
  ): Promise<T> {
    const source = this.requireSource(sourceId);
    const extension = source.name.split('.').pop() ?? 'csv';
    const reference = await this.database.registerFileBuffer(
      `contract-${crypto.randomUUID()}.${extension}`,
      encoder.encode(source.contents),
    );
    try {
      return await use(reference);
    } finally {
      await this.database.dropFile(reference);
    }
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
    const mainWorker = pathToFileURL(
      require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-mvp.worker.cjs'),
    ).toString();
    const database = new DuckDbWasmWorkspaceDatabase({
      mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm'),
      mainWorker,
      createWorker: (reference) => Promise.resolve(new WebWorker(new URL(reference))),
    });
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

  disposeWorkspace(): Promise<void> {
    return this.workspace.dispose();
  }

  awaitComparisonOutcome(operationId: ComparisonOperationId): Promise<ComparisonAttemptOutcomeView> {
    return this.observer.awaitComparisonOutcome(operationId);
  }

  async dispose(): Promise<void> {
    this.observer.dispose();
    await this.workspace.dispose();
  }
}
