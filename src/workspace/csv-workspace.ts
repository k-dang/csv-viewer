import type {
  ConfirmWorkspaceCloseOutcome,
  CsvViewer,
  WorkspaceCloseImpact,
} from '../shared/csv-viewer-contract';
import { CsvWorkspaceImplementation } from './csv-workspace-implementation';
import type { CsvWorkspaceHost } from './workspace-host';

/** Main-side ownership operations never cross the renderer protocol. */
export interface CsvWorkspaceOwner extends CsvViewer {
  confirmClose(confirmedImpact?: WorkspaceCloseImpact): Promise<ConfirmWorkspaceCloseOutcome>;
  dispose(): Promise<void>;
}

/** Creates the product module for one runtime host. */
export function createCsvViewer(host: CsvWorkspaceHost): CsvWorkspaceOwner {
  return new CsvWorkspaceImplementation(host);
}
