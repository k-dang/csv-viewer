import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { workingCsvFixture } from '../testing/csv-fixtures';
import { withCsvViewer } from '../testing/test-csv-viewer';
import { CsvGrid } from './csv-grid';

const DataGrid = () => null;

// Kept apart from the edit-state tests: react-dom/server and react-test-renderer rendering the
// same context in one module makes React warn about concurrent renderers.
describe('CsvGrid presentation', () => {
  it('offers Export CSV for an open Working CSV without Unexported Changes', () => {
    const markup = renderToStaticMarkup(
      withCsvViewer(<CsvGrid workingCsv={workingCsvFixture()} themeMode="light" DataGrid={DataGrid} />),
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
      withCsvViewer(<CsvGrid workingCsv={workingCsv} themeMode="light" DataGrid={DataGrid} />),
    );

    expect(markup).toContain('Unexported Changes');
  });
});
