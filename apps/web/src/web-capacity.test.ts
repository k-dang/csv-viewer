// @vitest-environment jsdom
import { File as NodeFile } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CsvWorkspaceOwner } from '@csv-viewer/workspace/csv-workspace';
import type { ComparisonView, WorkingCsvView } from '@csv-viewer/workspace/csv-viewer';
import { createNodeDuckDbWasmDatabase } from '../integration/fixtures/wasm-workspace';
import { startWebCsvViewer } from './web-composition';
import type { WebCsvCapacityLimits } from './web-workspace-host';

let viewer: CsvWorkspaceOwner | undefined;

beforeEach(() => {
  // jsdom's File lacks arrayBuffer; Node's File supplies the browser API used by ingestion.
  vi.stubGlobal('File', NodeFile);
});

afterEach(async () => {
  await viewer?.dispose();
  viewer = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('web CsvViewer capacity', () => {
  it('completes Aligned Comparison and Export CSV at the workspace limit', async () => {
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    viewer = await capacityViewer([csvFile(8), csvFile(8), csvFile(8)], { sourceBytes: 8, workspaceBytes: 16 });
    const baseline = await openWorkingCsv(viewer);
    const candidate = await openWorkingCsv(viewer);
    const comparison = await viewer.call({
      operation: 'comparison.open',
      baselineId: baseline.workingCsvId,
      candidateId: candidate.workingCsvId,
    });
    if (comparison.status === 'rejected') throw new Error('Comparison was rejected.');
    let latest: ComparisonView | undefined;
    viewer.onEvent((event) => {
      if (event.type === 'comparison' && event.event.kind === 'changed') latest = event.event.comparison;
    });
    await expect(viewer.call({
      operation: 'comparison.begin',
      kind: 'apply-key',
      comparisonId: comparison.comparison.comparisonId,
      key: ['id'],
    })).resolves.toMatchObject({ status: 'accepted' });
    await vi.waitFor(() => expect(latest?.applied?.summary.rows).toEqual({
      changed: 0,
      baselineOnly: 0,
      candidateOnly: 0,
      unchanged: 1,
      total: 1,
    }));
    await expect(viewer.call({ operation: 'csv.export', workingCsvId: baseline.workingCsvId })).resolves.toMatchObject({ status: 'exported' });
    expect(download).toHaveBeenCalledOnce();
    expect(await viewer.call({ operation: 'csv.open' })).toMatchObject({ status: 'capacity-exceeded' });
  });

  it.each([7, 8])('admits a %i-byte CSV Source at or below the file limit', async (size) => {
    viewer = await capacityViewer([csvFile(size)], { sourceBytes: 8, workspaceBytes: 16 });
    expect(await viewer.call({ operation: 'csv.open' })).toMatchObject({ status: 'opened' });
  });

  it.each([7, 8, 9])('checks a workspace total of 8 + %i bytes against 16 bytes', async (size) => {
    viewer = await capacityViewer([csvFile(8), csvFile(size)], { sourceBytes: 10, workspaceBytes: 16 });
    const first = await openWorkingCsv(viewer);
    const second = await viewer.call({ operation: 'csv.open' });
    if (size <= 8) {
      expect(second.status).toBe('opened');
    } else {
      expect(second).toEqual({
        status: 'capacity-exceeded',
        limit: 'workspace-source-bytes',
        limitBytes: 16,
        message: 'CSV Viewer Web supports up to 0.000016 MB of open CSV files. Use the desktop application for larger workspaces.',
      });
    }
    await expect(viewer.call({ operation: 'csv.get-rows', workingCsvId: first.workingCsvId, offset: 0, limit: 10 }))
      .resolves.toMatchObject({ rows: [{ id: '1111' }], filteredRowCount: 1 });
  });

  it('keeps the original byte budget through editing and reopen, releasing it only on confirmed close', async () => {
    viewer = await capacityViewer([csvFile(8), csvFile(8), csvFile(8)], { sourceBytes: 8, workspaceBytes: 8 });
    const first = await openWorkingCsv(viewer);
    const workingCsvId = first.workingCsvId;
    await expect(viewer.call({ operation: 'csv.reopen', workingCsvId })).resolves.toMatchObject({ status: 'opened' });
    const rows = await viewer.call({ operation: 'csv.get-rows', workingCsvId, offset: 0, limit: 1 });
    await viewer.call({ operation: 'csv.edit-cell', workingCsvId, rowId: rows.rows[0]!.__csvViewerRowId, column: 'id', value: 'a much longer value' });
    const close = await viewer.call({ operation: 'csv.close', workingCsvId });
    expect(close.status).toBe('confirmation-required');
    expect(await viewer.call({ operation: 'csv.open' })).toMatchObject({ status: 'capacity-exceeded' });
    await expect(viewer.call({ operation: 'csv.get-rows', workingCsvId, offset: 0, limit: 1 }))
      .resolves.toMatchObject({ rows: [{ id: 'a much longer value' }] });
    if (close.status !== 'confirmation-required') throw new Error('Expected close impact.');
    await expect(viewer.call({ operation: 'csv.close', workingCsvId, confirmedImpact: close.impact }))
      .resolves.toMatchObject({ status: 'closed' });
    expect(await viewer.call({ operation: 'csv.open' })).toMatchObject({ status: 'opened' });
  });

  it('releases failed opens and reserves nothing for a cancelled selection', async () => {
    const unreadable = csvFile(8);
    vi.spyOn(unreadable, 'arrayBuffer').mockRejectedValue(new Error('File read failed.'));
    viewer = await capacityViewer([unreadable, null, csvFile(8)], { sourceBytes: 8, workspaceBytes: 8 });
    expect(await viewer.call({ operation: 'csv.open' })).toMatchObject({ status: 'failed' });
    expect(await viewer.call({ operation: 'csv.open' })).toEqual({ status: 'cancelled' });
    expect(await viewer.call({ operation: 'csv.open' })).toMatchObject({ status: 'opened' });
  });

  it('includes an in-flight open in the workspace total before reading another file', async () => {
    const first = csvFile(8);
    const bytes = await first.arrayBuffer();
    const reading = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<ArrayBuffer>();
    vi.spyOn(first, 'arrayBuffer').mockImplementation(() => {
      reading.resolve();
      return finish.promise;
    });
    const second = csvFile(8);
    const secondRead = vi.spyOn(second, 'arrayBuffer');
    viewer = await capacityViewer([first, second], { sourceBytes: 8, workspaceBytes: 8 });
    const opening = viewer.call({ operation: 'csv.open' });
    try {
      await reading.promise;
      expect(await viewer.call({ operation: 'csv.open' })).toMatchObject({ status: 'capacity-exceeded', limit: 'workspace-source-bytes' });
      expect(secondRead).not.toHaveBeenCalled();
    } finally {
      finish.resolve(bytes);
      expect(await opening).toMatchObject({ status: 'opened' });
    }
  });

  it('uses decimal 100 MB and 200 MB limits by default', async () => {
    const oversized = csvFile(8);
    Object.defineProperty(oversized, 'size', { value: 100_000_001 });
    const exact = csvFile(8);
    Object.defineProperty(exact, 'size', { value: 100_000_000 });
    viewer = await capacityViewer([oversized, exact, exact, csvFile(8)]);
    expect(await viewer.call({ operation: 'csv.open' })).toEqual({
      status: 'capacity-exceeded', limit: 'source-bytes', limitBytes: 100_000_000,
      message: 'CSV Viewer Web supports files up to 100 MB. Use the desktop application for larger files.',
    });
    await openWorkingCsv(viewer);
    await openWorkingCsv(viewer);
    expect(await viewer.call({ operation: 'csv.open' })).toEqual({
      status: 'capacity-exceeded', limit: 'workspace-source-bytes', limitBytes: 200_000_000,
      message: 'CSV Viewer Web supports up to 200 MB of open CSV files. Use the desktop application for larger workspaces.',
    });
  });

  it('rejects a CSV Source above the file limit before reading its bytes', async () => {
    const file = new File(['id\n12345\n'], 'large.csv');
    const read = vi.spyOn(file, 'arrayBuffer');
    viewer = await capacityViewer([file], {
      sourceBytes: 8,
      workspaceBytes: 16,
    });
    await expect(viewer.call({ operation: 'csv.open' })).resolves.toEqual({
      status: 'capacity-exceeded',
      limit: 'source-bytes',
      limitBytes: 8,
      message: 'CSV Viewer Web supports files up to 0.000008 MB. Use the desktop application for larger files.',
    });
    expect(read).not.toHaveBeenCalled();
  });
});

function csvFile(size: number): File {
  return new File([`id\n${'1'.repeat(size - 4)}\n`], 'data.csv');
}

async function capacityViewer(
  selections: Array<File | null>,
  limits?: WebCsvCapacityLimits,
): Promise<CsvWorkspaceOwner> {
  const started = await startWebCsvViewer(createNodeDuckDbWasmDatabase(), async () => selections.shift() ?? null, limits);
  if (started.status !== 'ready') throw new Error('Web startup check failed.');
  return started.viewer;
}

async function openWorkingCsv(workspace: CsvWorkspaceOwner): Promise<WorkingCsvView> {
  const result = await workspace.call({ operation: 'csv.open' });
  if (result.status !== 'opened') throw new Error(`CSV Source did not open: ${result.status}`);
  return result.workingCsv;
}

