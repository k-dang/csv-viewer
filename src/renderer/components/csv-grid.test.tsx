import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkingCsvView } from '../../shared/ipc';
import { CsvGrid } from './csv-grid';

vi.mock('ag-grid-react', () => ({ AgGridReact: () => null }));

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

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

  it('reports clean export state after an edited Working CSV is reopened', async () => {
    const editedSession: WorkingCsvView = {
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
    const reopenedSession: WorkingCsvView = {
      ...editedSession,
      editState: {
        workingCsvId: 'working-csv-1',
        hasUnexportedChanges: false,
        canUndo: false,
        canRedo: false,
      },
    };
    const getCsvEditState = vi
      .fn()
      .mockResolvedValueOnce(editedSession.editState)
      .mockResolvedValueOnce(reopenedSession.editState);
    vi.stubGlobal('window', { csvViewer: { getCsvEditState } });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onUnexportedChangesChange = vi.fn();
    let renderer: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <CsvGrid
          session={editedSession}
          themeMode="light"
          onUnexportedChangesChange={onUnexportedChangesChange}
        />,
      );
    });
    expect(onUnexportedChangesChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      renderer.update(
        <CsvGrid
          session={reopenedSession}
          themeMode="light"
          onUnexportedChangesChange={onUnexportedChangesChange}
        />,
      );
    });

    expect(getCsvEditState).toHaveBeenCalledTimes(2);
    expect(onUnexportedChangesChange).toHaveBeenLastCalledWith(false);
  });
});
