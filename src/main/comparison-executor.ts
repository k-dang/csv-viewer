import type { ComparisonRow, ComparisonSummary, SourceKeyDiagnostics } from '../shared/ipc';

export type CreateComparisonSnapshotRequest = {
  artifactId: string;
  baselineId: string;
  candidateId: string;
  key: string[];
  valueColumns: string[];
};

export type ReadComparisonSnapshotWindowRequest = {
  artifactId: string;
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
  validateKey(operationId: string, sessionId: string, key: string[]): Promise<SourceKeyDiagnostics>;
  createSnapshot(request: CreateComparisonSnapshotRequest): Promise<ComparisonSummary>;
  cancel(operationId: string): void;
  readWindow(request: ReadComparisonSnapshotWindowRequest): Promise<StoredComparisonWindow>;
  dropSnapshot(artifactId: string): Promise<void>;
  dispose(): Promise<void>;
}
