import type { CsvCapacityExceeded, CsvSourceId, CsvViewerCapabilities, RecentCsvSource } from './csv-viewer';
import type { Effect, Scope } from 'effect';
import type { DataEngineError } from './database';
import type { WorkspaceRequestError } from './errors';

export type CsvSourceDescription = {
  sourceId: CsvSourceId;
  /** File name of the CSV Source, used for display and dialect defaults. */
  name: string;
  /** Where the CSV Source lives, in whatever terms the runtime can show the user. */
  location: string;
  sizeBytes: number;
  /** Delimiter to use when the Working CSV has no explicit delimiter override. */
  defaultDelimiter: string;
};

/** The delimiter a CSV Source's file name implies, before any Working CSV override. */
export function defaultDelimiterForSourceName(name: string): string {
  return name.toLowerCase().endsWith('.tsv') ? '\t' : ',';
}

export type CsvExportRequestForDelivery = {
  sourceId: CsvSourceId;
  suggestedName: string;
  contents: string;
};

export type CsvExportDelivery = { status: 'delivered' } | { status: 'cancelled' };

export type CsvSourceUnavailableCode = 'missing-source' | 'permission-denied' | 'unreadable';

/**
 * Everything the workspace needs from its runtime: CSV Source acquisition, description,
 * exposure to the data engine, export delivery, and Recent CSV Sources. It speaks CSV Viewer
 * language and opaque CSV Source identity; paths and browser handles stay inside implementations.
 */
export interface CsvWorkspaceHost {
  readonly capabilities: CsvViewerCapabilities;
  /** Select and reserve one CSV Source, return a capacity rejection, or null for cancellation. */
  acquireSource(): Promise<CsvSourceId | CsvCapacityExceeded | null>;
  /** Releases resources reserved for a CSV Source. Durable source identity may be retained. */
  releaseSource(sourceId: CsvSourceId): void;
  describeSource(sourceId: CsvSourceId): Promise<CsvSourceDescription>;
  /**
   * Acquires an engine-readable reference for the current scope. The host releases it when the
   * scope closes, after the reader has finished. The opaque reference is passed to the reader;
   * hosts do not build SQL.
   */
  acquireEngineSource(sourceId: CsvSourceId): Effect.Effect<string, WorkspaceRequestError | DataEngineError | CsvSourceUnavailableError, Scope.Scope>;
  deliverExport(request: CsvExportRequestForDelivery): Promise<CsvExportDelivery>;
  recentSources(): Promise<RecentCsvSource[]>;
  recordRecentSource(sourceId: CsvSourceId): Promise<void>;
  confirmDiscardChanges(sourceName: string): Promise<boolean>;
}

export class CsvSourceUnavailableError extends Error {
  constructor(
    readonly code: CsvSourceUnavailableCode,
    message: string,
  ) {
    super(message);
    this.name = 'CsvSourceUnavailableError';
  }
}
