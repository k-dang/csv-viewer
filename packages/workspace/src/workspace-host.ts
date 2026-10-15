import type { CsvCapacityExceeded, CsvSourceId, CsvViewerCapabilities, RecentCsvSource } from './csv-viewer';
import { Context, Effect, Layer, Schema, type Scope } from 'effect';
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

export interface SourceRegistry {
  acquireSource: CsvWorkspaceHost['acquireSource'];
  releaseSource: CsvWorkspaceHost['releaseSource'];
  describeSource: CsvWorkspaceHost['describeSource'];
  acquireEngineSource: CsvWorkspaceHost['acquireEngineSource'];
}

export const SourceRegistry = Context.Service<SourceRegistry>('csv-viewer/SourceRegistry');

export interface ExportSink {
  deliverExport: CsvWorkspaceHost['deliverExport'];
}

export const ExportSink = Context.Service<ExportSink>('csv-viewer/ExportSink');

export interface RecentSources {
  recentSources: CsvWorkspaceHost['recentSources'];
  recordRecentSource: CsvWorkspaceHost['recordRecentSource'];
}

export const RecentSources = Context.Service<RecentSources>('csv-viewer/RecentSources');

export interface Prompts {
  confirmDiscardChanges: CsvWorkspaceHost['confirmDiscardChanges'];
}

export const Prompts = Context.Service<Prompts>('csv-viewer/Prompts');

export const emptyRecentSources = {
  recentSources: (): Effect.Effect<RecentCsvSource[]> => Effect.succeed([]),
  recordRecentSource: (_sourceId: CsvSourceId): Effect.Effect<void> => Effect.void,
} satisfies RecentSources;

export const emptyRecentSourcesLayer = Layer.succeed(RecentSources, emptyRecentSources);

export function workspaceHostLayer(
  capabilities: CsvViewerCapabilities,
): Layer.Layer<CsvWorkspaceHost, never, SourceRegistry | ExportSink | RecentSources | Prompts> {
  return Layer.effect(CsvWorkspaceHost, Effect.gen(function* () {
    const sources = yield* SourceRegistry;
    const sink = yield* ExportSink;
    const recents = yield* RecentSources;
    const prompts = yield* Prompts;
    return {
      capabilities,
      acquireSource: () => sources.acquireSource(),
      releaseSource: (sourceId) => { sources.releaseSource(sourceId); },
      describeSource: (sourceId) => sources.describeSource(sourceId),
      acquireEngineSource: (sourceId) => sources.acquireEngineSource(sourceId),
      deliverExport: (request) => sink.deliverExport(request),
      recentSources: () => recents.recentSources(),
      recordRecentSource: (sourceId) => recents.recordRecentSource(sourceId),
      confirmDiscardChanges: (sourceName) => prompts.confirmDiscardChanges(sourceName),
    } satisfies CsvWorkspaceHost;
  }));
}

export function buildWorkspaceHost(layer: Layer.Layer<CsvWorkspaceHost>): CsvWorkspaceHost {
  return Context.get(Effect.runSync(Effect.scoped(Layer.build(layer))), CsvWorkspaceHost);
}

/** An expected CSV Source or export destination access failure, classified by the host. Its message is safe to show. */
export class CsvSourceUnavailableError extends Schema.TaggedError<CsvSourceUnavailableError>()('CsvSourceUnavailableError', {
  code: Schema.Literals(['missing-source', 'permission-denied', 'unreadable']),
  message: Schema.String,
}) {}
