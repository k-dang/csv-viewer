import type { WorkspaceDiagnostics } from './workspace-diagnostics';
import type {
  ConfirmWorkspaceCloseOutcome,
  CsvViewer,
  CsvViewerRequest,
  CsvViewerResult,
  WorkspaceCloseImpact,
} from './csv-viewer';
import { CsvWorkspaceImplementation } from './csv-workspace-implementation';
import type { WorkspaceDatabase } from './database';
import type { CsvWorkspaceHost } from './workspace-host';

/** Main-side ownership operations never cross the renderer protocol. */
export interface CsvWorkspaceOwner extends CsvViewer {
  /** Decodes an untrusted request payload, then dispatches it. `call` is its typed form. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  receive(payload: unknown): Promise<CsvViewerResult<CsvViewerRequest>>;
  confirmClose(confirmedImpact?: WorkspaceCloseImpact): Promise<ConfirmWorkspaceCloseOutcome>;
  dispose(): Promise<void>;
}

/** Creates the product module from one host and one in-memory database adapter. */
export function createCsvViewer(
  host: CsvWorkspaceHost,
  database: WorkspaceDatabase,
  diagnostics?: WorkspaceDiagnostics,
): CsvWorkspaceOwner {
  return new CsvWorkspaceImplementation(host, database, undefined, diagnostics);
}
