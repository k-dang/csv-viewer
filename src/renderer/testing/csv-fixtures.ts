import type { ComparisonView, WorkingCsvView } from '../../shared/csv-viewer-contract';

/** A minimal opened Working CSV. Tests override only the field under test. */
export function workingCsvFixture(overrides: Partial<WorkingCsvView> = {}): WorkingCsvView {
  const workingCsvId = overrides.workingCsvId ?? 'working-csv-1';
  return {
    workingCsvId,
    dataRevision: 0,
    source: {
      sourceId: workingCsvId,
      location: `/data/${workingCsvId}.csv`,
      name: `${workingCsvId}.csv`,
      sizeBytes: 24,
    },
    columns: [{ name: 'id', type: 'VARCHAR' }],
    rowCount: 1,
    dialect: {},
    ...overrides,
    editState: {
      workingCsvId,
      hasUnexportedChanges: false,
      canUndo: false,
      canRedo: false,
      ...overrides.editState,
    },
  };
}

/** A Comparison of two minimal Working CSVs, before any operation has run. */
export function comparisonFixture(overrides: Partial<ComparisonView> = {}): ComparisonView {
  return {
    comparisonId: 'comparison-1',
    version: 1,
    baseline: workingCsvFixture({ workingCsvId: 'baseline' }),
    candidate: workingCsvFixture({ workingCsvId: 'candidate' }),
    availableKeyColumns: ['id'],
    operation: null,
    applied: null,
    lastAttempt: null,
    ...overrides,
  };
}
