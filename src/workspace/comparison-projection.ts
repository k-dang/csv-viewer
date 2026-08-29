import type {
  ComparisonAttemptOutcomeView,
  ComparisonId,
  ComparisonKeyDiagnostics,
  ComparisonSide,
  ComparisonSummary,
  ComparisonView,
  SourceKeyDiagnostics,
  WorkingCsvRef,
  WorkingCsvView,
} from '../shared/csv-viewer-contract';

export type ComparisonProjectionInput = {
  comparisonId: ComparisonId;
  version: number;
  baseline: WorkingCsvView;
  candidate: WorkingCsvView;
  availableKeyColumns: string[];
  operation: ComparisonView['operation'];
  applied: null | {
    key: string[];
    resultToken: string;
    freshness: { kind: 'current' } | { kind: 'outdated'; changedSides: ComparisonSide[] };
    summary: ComparisonSummary;
  };
  lastAttempt: ComparisonView['lastAttempt'];
};

/**
 * Copies internal Comparison state into the structured-clone-safe view callers receive. Every
 * array and object is copied, so no caller can reach back into workspace state through a result.
 */
export function projectComparison(input: ComparisonProjectionInput): ComparisonView {
  return {
    comparisonId: input.comparisonId,
    version: input.version,
    baseline: projectWorkingCsvRef(input.baseline),
    candidate: projectWorkingCsvRef(input.candidate),
    availableKeyColumns: [...input.availableKeyColumns],
    operation: input.operation ? { ...input.operation } : null,
    applied: input.applied
      ? {
          key: [...input.applied.key],
          resultToken: input.applied.resultToken,
          freshness:
            input.applied.freshness.kind === 'current'
              ? { kind: 'current' }
              : { kind: 'outdated', changedSides: [...input.applied.freshness.changedSides] },
          summary: copySummary(input.applied.summary),
        }
      : null,
    lastAttempt: copyAttemptOutcome(input.lastAttempt),
  };
}

export function copySummary(summary: ComparisonSummary): ComparisonSummary {
  return {
    rows: { ...summary.rows },
    changedColumns: summary.changedColumns.map((column) => ({ ...column })),
  };
}

function copyAttemptOutcome(attempt: ComparisonAttemptOutcomeView | null): ComparisonAttemptOutcomeView | null {
  if (!attempt) return null;
  if (attempt.status === 'invalid-key') {
    return { ...attempt, diagnostics: copyKeyDiagnostics(attempt.diagnostics) };
  }
  if (attempt.status === 'sources-changed') {
    return { ...attempt, changedSides: [...attempt.changedSides] };
  }
  if (attempt.status === 'failed') return { ...attempt, failure: { ...attempt.failure } };
  return { ...attempt };
}

function copyKeyDiagnostics(diagnostics: ComparisonKeyDiagnostics): ComparisonKeyDiagnostics {
  return {
    key: [...diagnostics.key],
    baseline: copySourceKeyDiagnostics(diagnostics.baseline),
    candidate: copySourceKeyDiagnostics(diagnostics.candidate),
  };
}

function copySourceKeyDiagnostics(diagnostics: SourceKeyDiagnostics): SourceKeyDiagnostics {
  return {
    ...diagnostics,
    blankExamples: diagnostics.blankExamples.map((example) => ({
      ...example,
      keyValues: [...example.keyValues],
    })),
    duplicateExamples: diagnostics.duplicateExamples.map((example) => ({
      ...example,
      keyValues: [...example.keyValues],
      rowIds: [...example.rowIds],
    })),
  };
}

function projectWorkingCsvRef(workingCsv: WorkingCsvView): WorkingCsvRef {
  return {
    workingCsvId: workingCsv.workingCsvId,
    source: { ...workingCsv.source },
    columns: workingCsv.columns.map((column) => ({ ...column })),
  };
}
