import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkingCsvView } from '../../shared/ipc';
import { CsvGrid } from './csv-grid';

describe('CsvGrid', () => {
  it('offers Export CSV for an open Working CSV without Unexported Changes', () => {
    const session: WorkingCsvView = {
      workingCsvId: 'working-csv-1',
      dataRevision: 0,
      file: { path: '/data/source.csv', name: 'source.csv', sizeBytes: 24 },
      columns: [{ name: 'name', type: 'VARCHAR' }],
      rowCount: 1,
      dialect: {},
      editState: {
        workingCsvId: 'working-csv-1',
        hasUnexportedChanges: false,
        canUndo: false,
        canRedo: false,
      },
    };

    const markup = renderToStaticMarkup(<CsvGrid session={session} themeMode="light" />);

    expect(markup).toContain('aria-label="Export CSV"');
    expect(markup).not.toMatch(/<button[^>]*aria-label="Export CSV"[^>]*disabled/);
  });

  it('presents Unexported Changes using the product language', () => {
    const session: WorkingCsvView = {
      workingCsvId: 'working-csv-1',
      dataRevision: 1,
      file: { path: '/data/source.csv', name: 'source.csv', sizeBytes: 24 },
      columns: [{ name: 'name', type: 'VARCHAR' }],
      rowCount: 1,
      dialect: {},
      editState: {
        workingCsvId: 'working-csv-1',
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      },
    };

    const markup = renderToStaticMarkup(<CsvGrid session={session} themeMode="light" />);

    expect(markup).toContain('Unexported Changes');
  });
});
