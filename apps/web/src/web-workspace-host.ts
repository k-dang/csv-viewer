import type {
  CsvCapacityExceeded,
  CsvSourceId,
  RecentCsvSource,
} from '@csv-viewer/workspace/csv-viewer';
import type { DuckDbWasmWorkspaceDatabase } from './duckdb-wasm-database';
import {
  CsvSourceUnavailableError,
  defaultDelimiterForSourceName,
  type CsvExportDelivery,
  type CsvExportRequestForDelivery,
  type CsvSourceDescription,
  type CsvWorkspaceHost,
} from '@csv-viewer/workspace/workspace-host';

export type WebCsvFilePicker = () => Promise<File | null>;

export type WebCsvCapacityLimits = {
  sourceBytes: number;
  workspaceBytes: number;
};

// Provisional policy in original file bytes, not an estimate of engine memory.
const webCsvCapacityLimits: WebCsvCapacityLimits = {
  sourceBytes: 100_000_000,
  workspaceBytes: 200_000_000,
};

/** Keeps browser-selected CSV Sources in memory for the lifetime of one page. */
export class WebWorkspaceHost implements CsvWorkspaceHost {
  readonly capabilities = {
    recentCsvSources: false,
    exportCsvSuccessMessage: 'Download started',
    warnOnPageUnload: true,
  } as const;
  private readonly sources = new Map<CsvSourceId, File>();

  constructor(
    private readonly database: DuckDbWasmWorkspaceDatabase,
    private readonly pickFile: WebCsvFilePicker,
    private readonly limits: WebCsvCapacityLimits = webCsvCapacityLimits,
  ) {}

  async acquireSource(): Promise<CsvSourceId | CsvCapacityExceeded | null> {
    const file = await this.pickFile();
    if (!file) return null;
    if (file.size > this.limits.sourceBytes) {
      return {
        status: 'capacity-exceeded',
        limit: 'source-bytes',
        limitBytes: this.limits.sourceBytes,
        message: `CSV Viewer Web supports files up to ${this.limits.sourceBytes / 1_000_000} MB. Use the desktop application for larger files.`,
      };
    }
    const reservedBytes = [...this.sources.values()].reduce((total, source) => total + source.size, 0);
    if (reservedBytes + file.size > this.limits.workspaceBytes) {
      return {
        status: 'capacity-exceeded',
        limit: 'workspace-source-bytes',
        limitBytes: this.limits.workspaceBytes,
        message: `CSV Viewer Web supports up to ${this.limits.workspaceBytes / 1_000_000} MB of open CSV files. Use the desktop application for larger workspaces.`,
      };
    }
    // Check and reserve without yielding so concurrent selections include in-flight opens.
    const sourceId = crypto.randomUUID();
    this.sources.set(sourceId, file);
    return sourceId;
  }

  releaseSource(sourceId: CsvSourceId): void {
    this.sources.delete(sourceId);
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

  deliverExport(request: CsvExportRequestForDelivery): Promise<CsvExportDelivery> {
    const url = URL.createObjectURL(
      new Blob([request.contents], { type: 'text/csv;charset=utf-8' }),
    );
    const download = document.createElement('a');
    download.href = url;
    download.download = request.suggestedName;
    download.hidden = true;
    document.body.append(download);

    try {
      download.click();
      return Promise.resolve({ status: 'delivered' });
    } finally {
      download.remove();
      // Let the browser consume the click before invalidating the Blob URL.
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }
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
