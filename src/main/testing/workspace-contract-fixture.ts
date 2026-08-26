import { expect, it } from 'vitest';
import {
  csvInternalRowIdField,
  type ComparisonAttemptOutcomeView,
  type ComparisonOperationId,
  type CsvDialectOptions,
  type CsvRow,
  type CsvSourceId,
  type WorkingCsvView,
} from '../../shared/csv-viewer-contract';
import type { CsvWorkspace } from '../../workspace/csv-workspace';
import { CsvWorkspaceFixture } from './csv-workspace-fixture';

/**
 * User-observable setup around a CsvWorkspace. Engine-specific source and export mechanics stay in
 * the factory, while every contract case drives the same workspace operations and expected values.
 */
export interface WorkspaceContractFixture {
  readonly workspace: CsvWorkspace;
  registerSource(fileName: string, contents: string): Promise<CsvSourceId>;
  removeSource(fileName: string): Promise<void>;
  openSource(
    fileName: string,
    contents: string,
    options?: CsvDialectOptions,
  ): Promise<WorkingCsvView>;
  replaceSourceContents(fileName: string, contents: string): Promise<void>;
  /** Points the next Export CSV at `fileName` and returns a reader for the delivered bytes. */
  captureNextExport(fileName: string): () => Promise<string>;
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

/** Runs one contract case against every workspace factory, disposing the fixture after each run. */
export function contractIt(
  name: string,
  testCase: (fixture: WorkspaceContractFixture) => Promise<void>,
): void {
  it.each(workspaceContractFactories)(`$name ${name}`, async ({ create }) => {
    const fixture = await create();
    try {
      await testCase(fixture);
    } finally {
      await fixture.dispose();
    }
  });
}

/** The internal row identifiers of a row window, in order. */
export function rowIds(rows: CsvRow[]): string[] {
  return rows.map((row) => row[csvInternalRowIdField]);
}

/** Asserts on row windows with the internal row identifier stripped. */
export function expectVisibleRows(rows: CsvRow[]) {
  return expect(rows.map(({ [csvInternalRowIdField]: _rowId, ...visibleRow }) => visibleRow));
}
