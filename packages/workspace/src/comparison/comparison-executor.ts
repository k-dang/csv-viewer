import { Context, type Effect, type Scope } from 'effect';
import type { DataEngineError } from '../database';
import type {
  ComparisonId,
  ComparisonOperationId,
  ComparisonRow,
  ComparisonSummary,
  SourceKeyDiagnostics,
  WorkingCsvId,
} from '../csv-viewer';

export type CreateComparisonSnapshotRequest = {
  artifactId: ComparisonOperationId;
  comparisonId: ComparisonId;
  baselineId: WorkingCsvId;
  candidateId: WorkingCsvId;
  key: string[];
  valueColumns: string[];
};

export type ReadComparisonSnapshotWindowRequest = {
  artifactId: ComparisonOperationId;
  keyCount: number;
  columnIndexes: number[];
  offset: number;
  limit: number;
  differencesOnly: boolean;
  swapped: boolean;
};

export type StoredComparisonWindow = {
  totalRowCount: number;
  rows: ComparisonRow[];
};

export interface ComparisonAttemptExecutor {
  validateKey(
    workingCsvId: WorkingCsvId,
    key: string[],
  ): Effect.Effect<SourceKeyDiagnostics, DataEngineError>;
  createSnapshot(request: CreateComparisonSnapshotRequest): Effect.Effect<ComparisonSummary, DataEngineError>;
}

export interface ComparisonExecutor {
  /** Acquires the dedicated connection in the calling attempt's scope. */
  openAttempt(): Effect.Effect<ComparisonAttemptExecutor, DataEngineError, Scope.Scope>;
  activateSnapshot(artifactId: ComparisonOperationId): void;
  readWindow(request: ReadComparisonSnapshotWindowRequest): Effect.Effect<StoredComparisonWindow, DataEngineError>;
  dropSnapshot(artifactId: ComparisonOperationId): Effect.Effect<void, DataEngineError>;
  dispose(): Effect.Effect<void, DataEngineError>;
}

export const ComparisonExecutor = Context.Service<ComparisonExecutor>('csv-viewer/ComparisonExecutor');
