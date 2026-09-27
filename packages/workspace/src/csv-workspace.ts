import type { WorkspaceDiagnostics } from './workspace-diagnostics';
import type {
  ConfirmWorkspaceCloseOutcome,
  CsvViewer,
  CsvViewerRequest,
  CsvViewerResult,
  WorkspaceCloseImpact,
} from './csv-viewer';
import type { ComparisonExecutor } from './comparison/comparison-executor';
import { CsvWorkspaceImplementation } from './csv-workspace-implementation';
import type { OwnedWorkspaceDatabase } from './database';
import type { CsvWorkspaceHost } from './workspace-host';

/** Main-side ownership operations never cross the renderer protocol. */
export interface CsvWorkspaceOwner extends CsvViewer {
  /** Decodes an untrusted request payload, then dispatches it. `call` is its typed form. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  receive(payload: unknown): Promise<CsvViewerResult<CsvViewerRequest>>;
  confirmClose(confirmedImpact?: WorkspaceCloseImpact): Promise<ConfirmWorkspaceCloseOutcome>;
  dispose(): Promise<void>;
}

/**
 * The composition entry every runtime uses. Acquires the database, then builds the Working CSV,
 * Comparison, and diagnostics services on it and the host, and resolves once all of them exist.
 * A failed acquisition releases whatever was acquired and rejects. `dispose` releases the Working
 * CSV tables, then the database. The executor override is for tests.
 */
export function createCsvViewer(
  openDatabase: () => Promise<OwnedWorkspaceDatabase>,
  host: CsvWorkspaceHost,
  executor?: ComparisonExecutor,
  diagnostics?: WorkspaceDiagnostics,
): Promise<CsvWorkspaceOwner> {
  return CsvWorkspaceImplementation.create(openDatabase, host, executor, diagnostics);
}
