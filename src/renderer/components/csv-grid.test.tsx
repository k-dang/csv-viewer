import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { CsvEditState, CsvViewerRequest } from '../../shared/csv-viewer-contract';
import { enableActEnvironment } from '../testing/act-environment';
import { workingCsvFixture } from '../testing/csv-fixtures';
import { createTestCsvViewer, withCsvViewer } from '../testing/test-csv-viewer';
import { CsvGrid } from './csv-grid';

const DataGrid = () => null;

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
    const viewer = createTestCsvViewer({
      handlers: { 'csv.get-edit-state': getCsvEditState },
    });
    const onUnexportedChangesChange = vi.fn();
    let renderer: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        withCsvViewer(
          <CsvGrid
            workingCsv={editedWorkingCsv}
            themeMode="light"
            DataGrid={DataGrid}
            onUnexportedChangesChange={onUnexportedChangesChange}
          />,
          viewer,
        ),
      );
    });
    expect(onUnexportedChangesChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      renderer.update(
        withCsvViewer(
          <CsvGrid
            workingCsv={reopenedWorkingCsv}
            themeMode="light"
            DataGrid={DataGrid}
            onUnexportedChangesChange={onUnexportedChangesChange}
          />,
          viewer,
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
    const getCsvEditState = vi.fn((request: CsvViewerRequest) => {
      if (request.operation !== 'csv.get-edit-state') throw new Error('Unexpected request.');
      return new Promise<CsvEditState>((resolve) => pending.set(request.workingCsvId, resolve));
    });
    const viewer = createTestCsvViewer({
      handlers: { 'csv.get-edit-state': getCsvEditState },
    });
    const onUnexportedChangesChange = vi.fn();
    let renderer: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        withCsvViewer(
          <CsvGrid
            workingCsv={firstWorkingCsv}
            themeMode="light"
            DataGrid={DataGrid}
            onUnexportedChangesChange={onUnexportedChangesChange}
          />,
          viewer,
        ),
      );
    });
    await act(async () => {
      renderer.update(
        withCsvViewer(
          <CsvGrid
            workingCsv={secondWorkingCsv}
            themeMode="light"
            DataGrid={DataGrid}
            onUnexportedChangesChange={onUnexportedChangesChange}
          />,
          viewer,
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
