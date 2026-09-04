import { defineCsvViewerRequestContract } from './csv-viewer.contract';
import { defineCsvWorkspaceComparisonContract } from './comparison.contract';
import { defineCsvWorkspaceEditingContract } from './editing.contract';
import { defineCsvWorkspaceLifecycleContract } from './lifecycle.contract';
import { defineCsvWorkspaceWorkingCsvContract } from './working-csv.contract';
import type { WorkspaceContractFactory } from './workspace-contract';

/** Registers the complete CsvViewer behavior against one runtime adapter. */
export function defineCsvWorkspaceContract(
  factory: WorkspaceContractFactory,
): void {
  defineCsvViewerRequestContract(factory);
  defineCsvWorkspaceWorkingCsvContract(factory);
  defineCsvWorkspaceEditingContract(factory);
  defineCsvWorkspaceComparisonContract(factory);
  defineCsvWorkspaceLifecycleContract(factory);
}
