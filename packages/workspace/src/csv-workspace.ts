import type { WorkspaceDiagnostics } from './workspace-diagnostics';
import type { Context, Deferred, Effect } from 'effect';
import type { Rpc, RpcGroup } from 'effect/rpc';
import type {
  ConfirmWorkspaceCloseOutcome,
  CsvSourceId,
  CsvViewer,
  CsvViewerCapabilities,
  CsvViewerIntent,
  WorkspaceCloseImpact,
} from './csv-viewer';
import type { ComparisonExecutor } from './comparison/comparison-executor';
import { CsvWorkspaceImplementation } from './csv-workspace-implementation';
import type { CsvViewerRpcs } from './csv-viewer-rpcs';
import type { OpenWorkspaceDatabase } from './database';
import type { CsvSourceUnavailableError, CsvWorkspaceHost } from './workspace-host';
import type { WorkspaceRequestError } from './errors';

/** Web startup stays in the same Layer build while the page may interrupt it. */
export interface WorkspaceStartup {
  readonly signal?: AbortSignal;
  /** Completes once when the engine stops unexpectedly; the build and the workspace watch it. */
  readonly stopped: Deferred.Deferred<void>;
}

/**
 * The process that owns the services. Renderer calls go through `handlerContext`.
 * `confirmClose` and `dispose` stay on this side of the protocol.
 */
export interface CsvWorkspaceServer {
  readonly capabilities: CsvViewerCapabilities;
  readonly handlerContext: Context.Context<Rpc.ToHandler<RpcGroup.Rpcs<typeof CsvViewerRpcs>>>;
  confirmClose(confirmedImpact?: WorkspaceCloseImpact): Promise<ConfirmWorkspaceCloseOutcome>;
  dispose(): Promise<void>;
  publishIntent(intent: CsvViewerIntent): void;
}

/** Renderer Promise surface plus the owner methods the page calls on the same object. */
export interface CsvViewerSession extends CsvViewer {
  confirmClose(confirmedImpact?: WorkspaceCloseImpact): Promise<ConfirmWorkspaceCloseOutcome>;
  dispose(): Promise<void>;
}

export interface CreateCsvViewerOptions {
  /** Test override for Comparison execution. */
  readonly executor?: ComparisonExecutor;
  readonly diagnostics?: WorkspaceDiagnostics;
  readonly startup?: WorkspaceStartup;
  /** Desktop drop acquisition. Absent on web, where a `File` never becomes a path. */
  readonly acquireDroppedPath?: (filePath: string) => Effect.Effect<CsvSourceId, WorkspaceRequestError | CsvSourceUnavailableError>;
}

/**
 * The composition entry every runtime uses. Acquires the database, then builds the Working CSV,
 * Comparison, and diagnostics services on it and the host, and resolves once all of them exist.
 * A failed or interrupted acquisition releases whatever it acquired and rejects. `dispose` releases
 * the Working CSV tables, then the database; a stopped engine skips table release.
 */
export function createCsvViewer(
  openDatabase: OpenWorkspaceDatabase,
  host: CsvWorkspaceHost,
  options: CreateCsvViewerOptions = {},
): Promise<CsvWorkspaceServer> {
  return CsvWorkspaceImplementation.create(openDatabase, host, options);
}
