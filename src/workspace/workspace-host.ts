import type { CsvSourceId, CsvViewerCapabilities, RecentCsvSource } from '../shared/csv-viewer-contract';

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
  /** Ask the user for one CSV Source. Resolves to null when the selection is cancelled. */
  acquireSource(): Promise<CsvSourceId | null>;
  describeSource(sourceId: CsvSourceId): Promise<CsvSourceDescription>;
  /**
   * Makes the CSV Source readable by the data engine for the duration of `use`, which receives
   * the reference the engine reads it by. The reference is an opaque string the workspace passes
   * through to its reader; hosts do not build SQL.
   */
  withEngineSource<T>(sourceId: CsvSourceId, use: (engineSourceReference: string) => Promise<T>): Promise<T>;
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
