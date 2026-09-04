// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CsvEditState, CsvViewerRequest } from '@csv-viewer/workspace/csv-viewer';
import { workingCsvFixture } from '../test-helpers/csv-views';
import { createTestCsvViewer, withCsvViewer } from '../test-helpers/csv-viewer';
import { CsvGrid } from './csv-grid';

const DataGrid = () => null;

const editedWorkingCsvFixture = () =>
  workingCsvFixture({
    dataRevision: 1,
    editState: {
      workingCsvId: 'working-csv-1',
      hasUnexportedChanges: true,
      canUndo: true,
      canRedo: false,
    },
  });

afterEach(cleanup);

describe('CsvGrid', () => {
  it('presents Unexported Changes using the product language', () => {
    const workingCsv = editedWorkingCsvFixture();
    const viewer = createTestCsvViewer({
      handlers: { 'csv.get-edit-state': async () => workingCsv.editState },
    });

    render(withCsvViewer(<CsvGrid workingCsv={workingCsv} themeMode="light" DataGrid={DataGrid} />, viewer));

    expect(screen.getByText('Unexported Changes')).toBeDefined();
  });

  it('reports clean export state after an edited Working CSV is reopened', async () => {
    const editedWorkingCsv = editedWorkingCsvFixture();
    const reopenedWorkingCsv = workingCsvFixture({ dataRevision: 1 });
    const getCsvEditState = vi
      .fn()
      .mockResolvedValueOnce(editedWorkingCsv.editState)
      .mockResolvedValueOnce(reopenedWorkingCsv.editState);
    const viewer = createTestCsvViewer({
      handlers: { 'csv.get-edit-state': getCsvEditState },
    });
    const onUnexportedChangesChange = vi.fn();

    const { rerender } = render(
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
    await act(async () => {});
    expect(onUnexportedChangesChange).toHaveBeenLastCalledWith(true);

    await act(async () =>
      rerender(
        withCsvViewer(
          <CsvGrid
            workingCsv={reopenedWorkingCsv}
            themeMode="light"
            DataGrid={DataGrid}
            onUnexportedChangesChange={onUnexportedChangesChange}
          />,
          viewer,
        ),
      ),
    );

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

    const { rerender } = render(
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
    await act(async () =>
      rerender(
        withCsvViewer(
          <CsvGrid
            workingCsv={secondWorkingCsv}
            themeMode="light"
            DataGrid={DataGrid}
            onUnexportedChangesChange={onUnexportedChangesChange}
          />,
          viewer,
        ),
      ),
    );

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
