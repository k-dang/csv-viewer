import { expect } from 'vitest';
import {
  csvInternalRowIdField,
  type ComparisonAttemptOutcomeView,
  type ComparisonOperationId,
  type ComparisonId,
  type ComparisonView,
  type CsvDialectOptions,
  type CsvRow,
  type CsvEditState,
  type CsvSourceId,
  type CsvViewer,
  type WorkingCsvId,
  type WorkingCsvView,
  type WorkspaceCloseImpact,
  type ConfirmWorkspaceCloseOutcome,
} from '../shared/csv-viewer-contract';
import { CsvWorkspaceFixture } from './desktop-workspace';
import { WasmWorkspaceFixture } from './wasm-workspace';

/**
 * User-observable setup around CsvViewer. Engine-specific source and export mechanics stay in the
 * factory, while every contract case drives the same requests and expected values.
 */
export interface WorkspaceContractFixture {
  readonly viewer: CsvViewer;
  registerSource(fileName: string, contents: string): Promise<CsvSourceId>;
  removeSource(fileName: string): Promise<void>;
  openSource(fileName: string, contents: string, options?: CsvDialectOptions): Promise<WorkingCsvView>;
  /** Writes `fileName` inside the fixture, creating it or replacing what is there. */
  writeSource(fileName: string, contents: string): Promise<string>;
  /** Points the next Export CSV at `fileName` and returns a reader for the delivered bytes. */
  captureNextExport(fileName: string): () => Promise<string>;
  editState(workingCsvId: WorkingCsvId): Promise<CsvEditState>;
  latestComparison(comparisonId: ComparisonId): ComparisonView | null;
  confirmClose(confirmedImpact?: WorkspaceCloseImpact): Promise<ConfirmWorkspaceCloseOutcome>;
  disposeWorkspace(): Promise<void>;
  awaitComparisonOutcome(operationId: ComparisonOperationId): Promise<ComparisonAttemptOutcomeView>;
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
  {
    name: 'DuckDB-Wasm',
    create: () => WasmWorkspaceFixture.create(),
  },
];

/** The internal row identifiers of a row window, in order. */
export function rowIds(rows: CsvRow[]): string[] {
  return rows.map((row) => row[csvInternalRowIdField]);
}

/** Asserts on row windows with the internal row identifier stripped. */
export function expectVisibleRows(rows: CsvRow[]) {
  return expect(rows.map(({ [csvInternalRowIdField]: _rowId, ...visibleRow }) => visibleRow));
}
