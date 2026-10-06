import type { WorkspaceDiagnostics } from './workspace-diagnostics';
import type { Deferred } from 'effect';
import type {
  ConfirmWorkspaceCloseOutcome,
  CsvViewer,
  CsvViewerRequest,
  CsvViewerResult,
  WorkspaceCloseImpact,
} from './csv-viewer';
import type { ComparisonExecutor } from './comparison/comparison-executor';
import { CsvWorkspaceImplementation } from './csv-workspace-implementation';
import type { OpenWorkspaceDatabase } from './database';
import type { CsvWorkspaceHost } from './workspace-host';

/** Web startup stays in the same Layer build while the page may interrupt it. */
export interface WorkspaceStartup {
  readonly signal?: AbortSignal;
  /** Completes once when the engine stops unexpectedly; the build and the workspace watch it. */
  readonly stopped: Deferred.Deferred<void>;
}

/** Main-side ownership operations never cross the renderer protocol. */
export interface CsvWorkspaceOwner extends CsvViewer {
  /** Decodes an untrusted request payload, then dispatches it. `call` is its typed form. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  receive(payload: unknown): Promise<CsvViewerResult<CsvViewerRequest>>;
  confirmClose(confirmedImpact?: WorkspaceCloseImpact): Promise<ConfirmWorkspaceCloseOutcome>;
  dispose(): Promise<void>;
}

export interface CreateCsvViewerOptions {
  /** Test override for Comparison execution. */
  readonly executor?: ComparisonExecutor;
  readonly diagnostics?: WorkspaceDiagnostics;
  readonly startup?: WorkspaceStartup;
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
): Promise<CsvWorkspaceOwner> {
  return CsvWorkspaceImplementation.create(openDatabase, host, options);
}
