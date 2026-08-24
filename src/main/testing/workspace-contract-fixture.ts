import type {
  ComparisonAttemptOutcomeView,
  ComparisonOperationId,
  CsvDialectOptions,
  CsvSourceId,
  WorkingCsvView,
} from '../../shared/csv-viewer-contract';
import type { CsvWorkspace } from '../../workspace/csv-workspace';
import { CsvWorkspaceFixture } from './csv-workspace-fixture';

export type CapturedCsvExport = {
  readText(): Promise<string>;
};

/**
 * User-observable setup around a CsvWorkspace. Engine-specific source and export mechanics stay in
 * the factory, while every contract case drives the same workspace operations and expected values.
 */
export interface WorkspaceContractFixture {
  readonly workspace: CsvWorkspace;
  registerSource(fileName: string, contents: string): Promise<CsvSourceId>;
  removeSource(sourceId: CsvSourceId): Promise<void>;
  openSource(
    fileName: string,
    contents: string,
    options?: CsvDialectOptions,
  ): Promise<WorkingCsvView>;
  replaceSourceContents(fileName: string, contents: string): Promise<void>;
  captureNextExport(fileName: string): CapturedCsvExport;
  awaitComparisonOutcome(
    operationId: ComparisonOperationId,
  ): Promise<ComparisonAttemptOutcomeView>;
  dispose(): Promise<void>;
}

export type WorkspaceContractFactory = {
  name: string;
  create(): Promise<WorkspaceContractFixture>;
};

export const workspaceContractFactories: WorkspaceContractFactory[] = [
  {
    name: 'native DuckDB',
    create: () => CsvWorkspaceFixture.create(),
  },
];
