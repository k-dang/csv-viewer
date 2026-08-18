import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CsvEditState, WorkingCsvView } from '../../shared/ipc';
import { CsvGrid } from './csv-grid';

vi.mock('ag-grid-react', () => ({ AgGridReact: () => null }));

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('CsvGrid', () => {
  it('offers Export CSV for an open Working CSV without Unexported Changes', () => {
    const workingCsv: WorkingCsvView = {
      workingCsvId: 'working-csv-1',
      dataRevision: 0,
      file: { sourceId: 'source-1', location: '/data/source.csv', name: 'source.csv', sizeBytes: 24 },
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

    const markup = renderToStaticMarkup(<CsvGrid workingCsv={workingCsv} themeMode="light" />);

    expect(markup).toContain('aria-label="Export CSV"');
    expect(markup).not.toMatch(/<button[^>]*aria-label="Export CSV"[^>]*disabled/);
  });

  it('presents Unexported Changes using the product language', () => {
    const workingCsv: WorkingCsvView = {
      workingCsvId: 'working-csv-1',
      dataRevision: 1,
      file: { sourceId: 'source-1', location: '/data/source.csv', name: 'source.csv', sizeBytes: 24 },
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

    const markup = renderToStaticMarkup(<CsvGrid workingCsv={workingCsv} themeMode="light" />);

    expect(markup).toContain('Unexported Changes');
  });

  it('reports clean export state after an edited Working CSV is reopened', async () => {
    const editedWorkingCsv: WorkingCsvView = {
      workingCsvId: 'working-csv-1',
      dataRevision: 1,
      file: { sourceId: 'source-1', location: '/data/source.csv', name: 'source.csv', sizeBytes: 24 },
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
    const reopenedWorkingCsv: WorkingCsvView = {
      ...editedWorkingCsv,
      editState: {
        workingCsvId: 'working-csv-1',
        hasUnexportedChanges: false,
        canUndo: false,
        canRedo: false,
      },
    };
    const getCsvEditState = vi
      .fn()
      .mockResolvedValueOnce(editedWorkingCsv.editState)
      .mockResolvedValueOnce(reopenedWorkingCsv.editState);
    vi.stubGlobal('window', { csvViewer: { getCsvEditState } });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onUnexportedChangesChange = vi.fn();
    let renderer: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <CsvGrid
          workingCsv={editedWorkingCsv}
          themeMode="light"
          onUnexportedChangesChange={onUnexportedChangesChange}
        />,
      );
    });
    expect(onUnexportedChangesChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      renderer.update(
        <CsvGrid
          workingCsv={reopenedWorkingCsv}
          themeMode="light"
          onUnexportedChangesChange={onUnexportedChangesChange}
        />,
      );
    });

    expect(getCsvEditState).toHaveBeenCalledTimes(2);
    expect(onUnexportedChangesChange).toHaveBeenLastCalledWith(false);
  });

  it('ignores an edit-state response that arrives after the Working CSV changed', async () => {
    const firstWorkingCsv: WorkingCsvView = {
      workingCsvId: 'working-csv-1',
      dataRevision: 1,
      file: { sourceId: 'source-1', location: '/data/first.csv', name: 'first.csv', sizeBytes: 24 },
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
    const secondWorkingCsv: WorkingCsvView = {
      ...firstWorkingCsv,
      workingCsvId: 'working-csv-2',
      file: {
        sourceId: 'source-2',
        location: '/data/second.csv',
        name: 'second.csv',
        sizeBytes: 24,
      },
      editState: {
        workingCsvId: 'working-csv-2',
        hasUnexportedChanges: false,
        canUndo: false,
        canRedo: false,
      },
    };
    const pending = new Map<string, (editState: CsvEditState) => void>();
    const getCsvEditState = vi.fn(
      ({ workingCsvId }: { workingCsvId: string }) =>
        new Promise<CsvEditState>((resolve) => pending.set(workingCsvId, resolve)),
    );
    vi.stubGlobal('window', { csvViewer: { getCsvEditState } });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onUnexportedChangesChange = vi.fn();
    let renderer: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <CsvGrid
          workingCsv={firstWorkingCsv}
          themeMode="light"
          onUnexportedChangesChange={onUnexportedChangesChange}
        />,
      );
    });
    await act(async () => {
      renderer.update(
        <CsvGrid
          workingCsv={secondWorkingCsv}
          themeMode="light"
          onUnexportedChangesChange={onUnexportedChangesChange}
        />,
      );
    });

    await act(async () => {
      pending.get('working-csv-2')?.(secondWorkingCsv.editState);
      pending.get('working-csv-1')?.({
        workingCsvId: 'working-csv-1',
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      });
    });

    expect(onUnexportedChangesChange).toHaveBeenLastCalledWith(false);
    expect(onUnexportedChangesChange).not.toHaveBeenCalledWith(true);
  });
});
