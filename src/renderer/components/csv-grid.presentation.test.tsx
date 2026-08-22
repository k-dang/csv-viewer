import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { workingCsvFixture } from '../testing/csv-fixtures';
import { withRuntime } from '../testing/test-csv-viewer-runtime';
import { CsvGrid } from './csv-grid';

vi.mock('ag-grid-react', () => ({ AgGridReact: () => null }));

// Kept apart from the edit-state tests: react-dom/server and react-test-renderer rendering the
// same context in one module makes React warn about concurrent renderers.
describe('CsvGrid presentation', () => {
  it('offers Export CSV for an open Working CSV without Unexported Changes', () => {
    const markup = renderToStaticMarkup(
      withRuntime(<CsvGrid workingCsv={workingCsvFixture()} themeMode="light" />),
    );

    expect(markup).toContain('aria-label="Export CSV"');
    expect(markup).not.toMatch(/<button[^>]*aria-label="Export CSV"[^>]*disabled/);
  });

  it('presents Unexported Changes using the product language', () => {
    const workingCsv = workingCsvFixture({
      dataRevision: 1,
      editState: {
        workingCsvId: 'working-csv-1',
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      },
    });

    const markup = renderToStaticMarkup(
      withRuntime(<CsvGrid workingCsv={workingCsv} themeMode="light" />),
    );

    expect(markup).toContain('Unexported Changes');
  });
});
