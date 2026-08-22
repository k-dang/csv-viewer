import type { WorkingCsvView } from '../../shared/csv-viewer-contract';

/** A minimal opened Working CSV. Tests override only the field under test. */
export function workingCsvFixture(overrides: Partial<WorkingCsvView> = {}): WorkingCsvView {
  const workingCsvId = overrides.workingCsvId ?? 'working-csv-1';
  return {
    workingCsvId,
    dataRevision: 0,
    file: {
      sourceId: 'source-1',
      location: '/data/source.csv',
      name: 'source.csv',
      sizeBytes: 24,
    },
    columns: [{ name: 'name', type: 'VARCHAR' }],
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
