import type { CsvCapacityExceeded, CsvSourceId, CsvViewerCapabilities, RecentCsvSource } from './csv-viewer';
import { Context, Data, type Effect, type Scope } from 'effect';
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
  kind?: 'view';
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
  acquireSource(): Effect.Effect<CsvSourceId | CsvCapacityExceeded | null, CsvSourceUnavailableError | WorkspaceRequestError>;
  /** Releases resources reserved for a CSV Source. Durable source identity may be retained. */
  releaseSource(sourceId: CsvSourceId): void;
  describeSource(sourceId: CsvSourceId): Effect.Effect<CsvSourceDescription, CsvSourceUnavailableError | WorkspaceRequestError>;
  /**
   * Acquires an engine-readable reference for the current scope. The host releases it when the
   * scope closes, after the reader has finished. The opaque reference is passed to the reader;
   * hosts do not build SQL.
   */
  acquireEngineSource(sourceId: CsvSourceId): Effect.Effect<string, WorkspaceRequestError | DataEngineError | CsvSourceUnavailableError, Scope.Scope>;
  deliverExport(request: CsvExportRequestForDelivery): Effect.Effect<CsvExportDelivery, CsvSourceUnavailableError | WorkspaceRequestError>;
  recentSources(): Effect.Effect<RecentCsvSource[], CsvSourceUnavailableError | WorkspaceRequestError>;
  recordRecentSource(sourceId: CsvSourceId): Effect.Effect<void, CsvSourceUnavailableError | WorkspaceRequestError>;
  confirmDiscardChanges(sourceName: string): Effect.Effect<boolean, CsvSourceUnavailableError | WorkspaceRequestError>;
}

/** Each runtime supplies its own host when it composes the workspace. */
export const CsvWorkspaceHost = Context.Service<CsvWorkspaceHost>('csv-viewer/Host');

/** An expected CSV Source or export destination access failure, classified by the host. Its message is safe to show. */
export class CsvSourceUnavailableError extends Data.TaggedError('CsvSourceUnavailableError')<{
  code: CsvSourceUnavailableCode;
  message: string;
}> {}
