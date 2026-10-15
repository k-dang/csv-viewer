import { Effect, Layer } from 'effect';
import type {
  CsvCapacityExceeded,
  CsvSourceId,
} from '@csv-viewer/workspace/csv-viewer';
import type { DuckDbWasmWorkspaceDatabase } from './duckdb-wasm-database';
import { scopedEngineSource } from '@csv-viewer/workspace/engine-source';
import { SourceTable, sourceDescription } from '@csv-viewer/workspace/source-table';
import {
  CsvSourceUnavailableError,
  emptyRecentSources,
  emptyRecentSourcesLayer,
  ExportSink,
  Prompts,
  SourceRegistry,
  workspaceHostLayer,
  type CsvExportDelivery,
  type CsvExportRequestForDelivery,
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
  private readonly sources = new SourceTable<File>();

  constructor(
    private readonly database: DuckDbWasmWorkspaceDatabase,
    private readonly pickFile: WebCsvFilePicker,
    private readonly limits: WebCsvCapacityLimits = webCsvCapacityLimits,
  ) {}

  acquireSource() {
    return Effect.promise(() => this.pickFile()).pipe(Effect.map((file) => file ? this.registerSource(file) : null));
  }

  /** Reserves selected or dropped bytes under the same browser capacity policy. */
  registerSource(file: File): CsvSourceId | CsvCapacityExceeded {
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
    return this.sources.reserve(file, () => false);
  }

  releaseSource(sourceId: CsvSourceId): void {
    this.sources.release(sourceId);
  }

  describeSource(sourceId: CsvSourceId) {
    return this.requireSource(sourceId).pipe(Effect.map((source) => sourceDescription(
      sourceId,
      source.name,
      'This browser session',
      source.size,
    )));
  }

  acquireEngineSource(sourceId: CsvSourceId) {
    return scopedEngineSource(Effect.gen({ self: this }, function* () {
      const source = yield* this.requireSource(sourceId);
      const contents = yield* Effect.tryPromise({
        try: () => source.arrayBuffer(),
        catch: () => new CsvSourceUnavailableError({ code: 'unreadable', message: 'The CSV Source could not be read.' }),
      });
      return yield* this.database.registerFileBuffer(source.name, new Uint8Array(contents));
    }), (reference) => this.database.dropFile(reference));
  }

  deliverExport(request: CsvExportRequestForDelivery) {
    return Effect.sync(() => {
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
        return { status: 'delivered' } satisfies CsvExportDelivery;
      } finally {
        download.remove();
        // Let the browser consume the click before invalidating the Blob URL.
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    });
  }

  recentSources() {
    return emptyRecentSources.recentSources();
  }

  recordRecentSource(sourceId: CsvSourceId) {
    return emptyRecentSources.recordRecentSource(sourceId);
  }

  confirmDiscardChanges(sourceName: string) {
    return Effect.sync(() => window.confirm(`Reopen ${sourceName}?\n\nUnexported Changes will be lost.`));
  }

  private requireSource(sourceId: CsvSourceId) {
    return this.sources.require(sourceId, new CsvSourceUnavailableError({
      code: 'missing-source',
      message: 'Select the CSV Source again. It is no longer available in this browser session.',
    }));
  }
}

export function webWorkspaceHostLayer(host: WebWorkspaceHost): Layer.Layer<CsvWorkspaceHost> {
  const sources: SourceRegistry = host;
  const sink: ExportSink = host;
  const prompts: Prompts = host;
  return workspaceHostLayer(host.capabilities).pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(SourceRegistry, sources),
    Layer.succeed(ExportSink, sink),
    emptyRecentSourcesLayer,
    Layer.succeed(Prompts, prompts),
  )));
}
