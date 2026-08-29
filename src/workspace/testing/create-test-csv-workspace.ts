import type { ComparisonExecutor } from '../comparison-executor';
import { CsvWorkspaceImplementation } from '../csv-workspace-implementation';
import type { CsvWorkspaceHost } from '../workspace-host';

/** Internal construction for tests that need controlled Comparison execution. */
export function createTestCsvWorkspace(
  host: CsvWorkspaceHost,
  executor?: ComparisonExecutor,
): CsvWorkspaceImplementation {
  return new CsvWorkspaceImplementation(host, executor);
}
