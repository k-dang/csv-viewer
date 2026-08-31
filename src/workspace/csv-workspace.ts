import type {
  ConfirmWorkspaceCloseOutcome,
  CsvViewer,
  WorkspaceCloseImpact,
} from '../shared/csv-viewer-contract';
import { CsvWorkspaceImplementation } from './csv-workspace-implementation';
import type { WorkspaceDatabase } from './database';
import type { CsvWorkspaceHost } from './workspace-host';

/** Main-side ownership operations never cross the renderer protocol. */
export interface CsvWorkspaceOwner extends CsvViewer {
  confirmClose(confirmedImpact?: WorkspaceCloseImpact): Promise<ConfirmWorkspaceCloseOutcome>;
  dispose(): Promise<void>;
}

/** Creates the product module from one host and one in-memory database adapter. */
export function createCsvViewer(
  host: CsvWorkspaceHost,
  database: WorkspaceDatabase,
): CsvWorkspaceOwner {
  return new CsvWorkspaceImplementation(host, database);
}
