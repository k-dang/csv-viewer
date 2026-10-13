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
} from '../../src/csv-viewer';

import type { WorkspaceDiagnostics } from '../../src/workspace-diagnostics';
import type { ComparisonExecutor } from '../../src/comparison/comparison-executor';
import type { WorkspaceRequestError } from '../../src/errors';
import type { CsvSourceUnavailableError } from '../../src/workspace-host';
import type { ExportPreparationFailure } from './database-failure-injection';

/**
 * User-observable setup around CsvViewer. Engine-specific source and export mechanics stay in the
 * factory, while every contract case drives the same requests and expected values.
 */
export interface WorkspaceContractFixture {
  readonly viewer: CsvViewer;
  registerSource(fileName: string, contents: string): Promise<CsvSourceId>;
  removeSource(fileName: string): Promise<void>;
  openSource(fileName: string, contents: string, options?: CsvDialectOptions): Promise<WorkingCsvView>;
  /** Fail one driver call after table allocation to exercise staged resource cleanup. */
  failNextMetadataRead(): void;
  /** Fail one CSV table load after its engine source has been acquired. */
  failNextCsvLoad(): void;
  /** Fail one physical table deletion; a later cleanup attempt uses the real driver. */
  failNextTableDrop(): void;
  /** Fail the next export worker's first `failures` close attempts without closing it; return whether it has since closed. */
  failNextExportWorkerRelease(failures: number): () => boolean;
  /** Fail export preparation and return whether its worker connection has closed. */
  failNextExportPreparation(failure: ExportPreparationFailure): () => boolean;
  /** Fail the next engine source acquisition, after the source was described, with a declared host failure. */
  failNextEngineSourceAcquire(failure: WorkspaceRequestError | CsvSourceUnavailableError): void;
  /** Fail one temporary engine source release. */
  failNextEngineSourceRelease(): void;
  /** Fail one owner connection close after the connection closes; the engine release still runs. */
  failNextDatabaseRelease(): void;
  /** Inject an unexpected failure from a real host request. */
  failNextRecentSources(): void;
  /** Inject an unexpected source-description failure during CSV open. */
  failNextDescribeSource(): void;
  /** Fail one Comparison snapshot deletion as a declared failure or defect; later cleanup uses the real driver. */
  failNextSnapshotDrop(mode?: 'failure' | 'defect'): Promise<void>;
  /** Strip the internal row identifiers from the next row window the engine returns. */
  corruptNextRowWindow(): void;
  /** Hold the read of the next row window's rows until released. */
  holdNextRowRead(): { entered: Promise<void>; release: () => void };
  /** Hold the next export's row read until released. */
  holdNextExportRead(): { entered: Promise<void>; release: () => void };
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
  create(executor?: ComparisonExecutor, diagnostics?: WorkspaceDiagnostics): Promise<WorkspaceContractFixture>;
};

/** A declared RPC failure keeps its tag. A defect stays a plain Error with no tag. */
export async function expectRpcFailure(work: Promise<unknown>, tag: string, message: RegExp | string): Promise<void> {
  const error = await rejected(work);
  expect(error).toMatchObject({ _tag: tag });
  expectMessage(error, message);
}

export async function expectRpcDefect(work: Promise<unknown>, message: RegExp | string): Promise<void> {
  const error = await rejected(work);
  expect(error).not.toHaveProperty('_tag');
  expectMessage(error, message);
}

async function rejected(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (caught) {
    if (caught instanceof Error) return caught;
  }
  throw new Error('expected the RPC to fail');
}

function expectMessage(error: Error, message: RegExp | string): void {
  if (message instanceof RegExp) expect(error.message).toMatch(message);
  else expect(error.message).toContain(message);
}

/** The internal row identifiers of a row window, in order. */
export function rowIds(rows: CsvRow[]): string[] {
  return rows.map((row) => row[csvInternalRowIdField]);
}

/** Asserts on row windows with the internal row identifier stripped. */
export function expectVisibleRows(rows: CsvRow[]) {
  return expect(rows.map( ({ [csvInternalRowIdField]: _rowId, ...visibleRow }) => visibleRow),
  );
}
