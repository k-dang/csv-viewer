import type {
  ComparisonId,
  ComparisonOperationId,
  ComparisonRow,
  ComparisonSummary,
  SourceKeyDiagnostics,
  WorkingCsvId,
} from './contracts/csv-viewer';

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

export interface ComparisonExecutor {
  validateKey(
    operationId: ComparisonOperationId,
    workingCsvId: WorkingCsvId,
    key: string[],
  ): Promise<SourceKeyDiagnostics>;
  createSnapshot(request: CreateComparisonSnapshotRequest): Promise<ComparisonSummary>;
  activateSnapshot(artifactId: ComparisonOperationId): void;
  cancel(operationId: ComparisonOperationId): void;
  release(operationId: ComparisonOperationId): Promise<void>;
  readWindow(request: ReadComparisonSnapshotWindowRequest): Promise<StoredComparisonWindow>;
  dropSnapshot(artifactId: ComparisonOperationId): Promise<void>;
  dispose(): Promise<void>;
}
