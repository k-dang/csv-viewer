import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { CsvEditState } from '../../shared/csv-viewer-contract';
import { enableActEnvironment } from '../testing/act-environment';
import { workingCsvFixture } from '../testing/csv-fixtures';
import { createTestCsvViewerRuntime, withRuntime } from '../testing/test-csv-viewer-runtime';
import { CsvGrid } from './csv-grid';

vi.mock('ag-grid-react', () => ({ AgGridReact: () => null }));

enableActEnvironment();

describe('CsvGrid edit state', () => {
  it('reports clean export state after an edited Working CSV is reopened', async () => {
    const editedWorkingCsv = workingCsvFixture({
      dataRevision: 1,
      editState: {
        workingCsvId: 'working-csv-1',
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      },
    });
    const reopenedWorkingCsv = workingCsvFixture({ dataRevision: 1 });
    const getCsvEditState = vi
      .fn()
      .mockResolvedValueOnce(editedWorkingCsv.editState)
      .mockResolvedValueOnce(reopenedWorkingCsv.editState);
    const runtime = createTestCsvViewerRuntime({ getCsvEditState });
    const onUnexportedChangesChange = vi.fn();
    let renderer: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        withRuntime(
          <CsvGrid
            workingCsv={editedWorkingCsv}
            themeMode="light"
            onUnexportedChangesChange={onUnexportedChangesChange}
          />,
          runtime,
        ),
      );
    });
    expect(onUnexportedChangesChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      renderer.update(
        withRuntime(
          <CsvGrid
            workingCsv={reopenedWorkingCsv}
            themeMode="light"
            onUnexportedChangesChange={onUnexportedChangesChange}
          />,
          runtime,
        ),
      );
    });

    expect(getCsvEditState).toHaveBeenCalledTimes(2);
    expect(onUnexportedChangesChange).toHaveBeenLastCalledWith(false);
  });

  it('ignores an edit-state response that arrives after the Working CSV changed', async () => {
    const firstWorkingCsv = workingCsvFixture({ workingCsvId: 'working-csv-1' });
    const secondWorkingCsv = workingCsvFixture({ workingCsvId: 'working-csv-2' });
    const pending = new Map<string, (editState: CsvEditState) => void>();
    const getCsvEditState = vi.fn(
      ({ workingCsvId }: { workingCsvId: string }) =>
        new Promise<CsvEditState>((resolve) => pending.set(workingCsvId, resolve)),
    );
    const runtime = createTestCsvViewerRuntime({ getCsvEditState });
    const onUnexportedChangesChange = vi.fn();
    let renderer: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        withRuntime(
          <CsvGrid
            workingCsv={firstWorkingCsv}
            themeMode="light"
            onUnexportedChangesChange={onUnexportedChangesChange}
          />,
          runtime,
        ),
      );
    });
    await act(async () => {
      renderer.update(
        withRuntime(
          <CsvGrid
            workingCsv={secondWorkingCsv}
            themeMode="light"
            onUnexportedChangesChange={onUnexportedChangesChange}
          />,
          runtime,
        ),
      );
    });

    const resolveFirst = pending.get('working-csv-1');
    const resolveSecond = pending.get('working-csv-2');
    expect(resolveFirst).toBeDefined();
    expect(resolveSecond).toBeDefined();

    await act(async () => {
      resolveSecond?.(secondWorkingCsv.editState);
      resolveFirst?.({
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
