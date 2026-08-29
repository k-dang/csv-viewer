import { describe, expect, it } from 'vitest';
import type { ComparisonAttemptOutcomeView } from '../shared/csv-viewer-contract';
import type { ComparisonProjectionInput } from './comparison-projection';
import { projectComparison } from './comparison-projection';

function projectionInput(lastAttempt: ComparisonAttemptOutcomeView): ComparisonProjectionInput {
  const workingCsv = {
    workingCsvId: 'working-csv',
    dataRevision: 0,
    source: { sourceId: 'source', name: 'a.csv', location: 'a.csv', sizeBytes: 1 },
    columns: [{ name: 'id', type: 'VARCHAR' }],
    rowCount: 1,
    dialect: {},
    editState: {
      workingCsvId: 'working-csv',
      hasUnexportedChanges: false,
      canUndo: false,
      canRedo: false,
    },
  };
  return {
    comparisonId: 'comparison',
    version: 1,
    baseline: workingCsv,
    candidate: workingCsv,
    availableKeyColumns: ['id'],
    operation: null,
    applied: null,
    lastAttempt,
  };
}

describe('projectComparison', () => {
  it('copies the failure a failed attempt carries', () => {
    const lastAttempt: ComparisonAttemptOutcomeView = {
      attemptId: 'attempt',
      status: 'failed',
      failure: { code: 'query-failed', message: 'Comparison failed.', retryable: true },
    };

    const projected = projectComparison(projectionInput(lastAttempt));

    expect(projected.lastAttempt).toEqual(lastAttempt);
    if (projected.lastAttempt?.status !== 'failed') throw new Error('Attempt was not failed.');
    projected.lastAttempt.failure.message = 'mutated';
    if (lastAttempt.status !== 'failed') throw new Error('Attempt was not failed.');
    expect(lastAttempt.failure.message).toBe('Comparison failed.');
  });

  it('copies the diagnostics an invalid-key attempt carries', () => {
    const lastAttempt: ComparisonAttemptOutcomeView = {
      attemptId: 'attempt',
      status: 'invalid-key',
      diagnostics: {
        key: ['id'],
        baseline: {
          blankRowCount: 1,
          duplicateGroupCount: 1,
          blankExamples: [{ rowId: '1', keyValues: [null] }],
          duplicateExamples: [{ keyValues: ['a'], rowCount: 2, rowIds: ['1', '2'] }],
        },
        candidate: {
          blankRowCount: 0,
          duplicateGroupCount: 0,
          blankExamples: [],
          duplicateExamples: [],
        },
      },
    };

    const projected = projectComparison(projectionInput(lastAttempt));

    expect(projected.lastAttempt).toEqual(lastAttempt);
    if (projected.lastAttempt?.status !== 'invalid-key') {
      throw new Error('Attempt was not invalid-key.');
    }
    projected.lastAttempt.diagnostics.key.push('mutated');
    projected.lastAttempt.diagnostics.baseline.duplicateExamples[0].rowIds.push('3');
    if (lastAttempt.status !== 'invalid-key') throw new Error('Attempt was not invalid-key.');
    expect(lastAttempt.diagnostics.key).toEqual(['id']);
    expect(lastAttempt.diagnostics.baseline.duplicateExamples[0].rowIds).toEqual(['1', '2']);
  });
});
