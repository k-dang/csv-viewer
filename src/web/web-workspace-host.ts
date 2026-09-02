import type {
  CsvSourceId,
  RecentCsvSource,
} from '../shared/csv-viewer-contract';
import type { DuckDbWasmWorkspaceDatabase } from '../workspace/duckdb/duckdb-wasm-database';
import {
  CsvSourceUnavailableError,
  defaultDelimiterForSourceName,
  type CsvExportDelivery,
  type CsvExportRequestForDelivery,
  type CsvSourceDescription,
  type CsvWorkspaceHost,
} from '../workspace/workspace-host';

export type WebCsvFilePicker = () => Promise<File | null>;

/** Keeps browser-selected CSV Sources in memory for the lifetime of one page. */
export class WebWorkspaceHost implements CsvWorkspaceHost {
  readonly capabilities = { recentCsvSources: false } as const;
  private readonly sources = new Map<CsvSourceId, File>();

  constructor(
    private readonly database: DuckDbWasmWorkspaceDatabase,
    private readonly pickFile: WebCsvFilePicker,
  ) {}

  async acquireSource(): Promise<CsvSourceId | null> {
    const file = await this.pickFile();
    if (!file) return null;
    const sourceId = crypto.randomUUID();
    this.sources.set(sourceId, file);
    return sourceId;
  }

  describeSource(sourceId: CsvSourceId): Promise<CsvSourceDescription> {
    const source = this.requireSource(sourceId);
    return Promise.resolve({
      sourceId,
      name: source.name,
      location: 'This browser session',
      sizeBytes: source.size,
      defaultDelimiter: defaultDelimiterForSourceName(source.name),
    });
  }

  async withEngineSource<T>(
    sourceId: CsvSourceId,
    use: (engineSourceReference: string) => Promise<T>,
  ): Promise<T> {
    const source = this.requireSource(sourceId);
    return this.database.withRegisteredFile(
      source.name,
      new Uint8Array(await source.arrayBuffer()),
      use,
    );
  }

  deliverExport(_request: CsvExportRequestForDelivery): Promise<CsvExportDelivery> {
    return Promise.resolve({ status: 'cancelled' });
  }

  recentSources(): Promise<RecentCsvSource[]> {
    return Promise.resolve([]);
  }

  recordRecentSource(): Promise<void> {
    return Promise.resolve();
  }

  confirmDiscardChanges(sourceName: string): Promise<boolean> {
    return Promise.resolve(
      window.confirm(`Reopen ${sourceName}?\n\nUnexported Changes will be lost.`),
    );
  }

  private requireSource(sourceId: CsvSourceId): File {
    const source = this.sources.get(sourceId);
    if (!source) {
      throw new CsvSourceUnavailableError(
        'missing-source',
        'Select the CSV Source again. It is no longer available in this browser session.',
      );
    }
    return source;
  }
}
