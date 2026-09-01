import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeDuckDbWasmDatabase } from '../test-helpers/wasm-workspace';
import { DuckDbWasmWorkspaceDatabase } from '../workspace/duckdb/duckdb-wasm-database';
import type { CsvWorkspaceOwner } from '../workspace/csv-workspace';
import { startWebCsvViewer } from './web-composition';

// The CsvViewer contract itself is proven against this same Wasm engine in
// csv-viewer-contract.test.ts, so these cases only cover what the web composition root adds:
// the startup gate, the browser capability set, and browser-selection identity.
let viewer: CsvWorkspaceOwner | undefined;

afterEach(async () => {
  await viewer?.dispose();
  viewer = undefined;
});

describe('web CsvViewer composition', () => {
  it('does not offer CSV Source selection when the pinned Worker cannot start', async () => {
    const pickFile = vi.fn<() => Promise<File | null>>();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const database = new DuckDbWasmWorkspaceDatabase({
      mainModule: 'duckdb-mvp.wasm',
      mainWorker: 'duckdb-browser-mvp.worker.js',
      createWorker: () => Promise.reject(new Error('Workers are unavailable.')),
    });

    await expect(startWebCsvViewer(database, pickFile)).resolves.toEqual({ status: 'unsupported' });
    expect(pickFile).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('opens repeated browser selections as independent CSV Sources', async () => {
    const selectedFile = new File(
      ['id;name;status\n1;Ada;active\n2;Grace;active\n'],
      'people.txt',
      { type: 'text/plain' },
    );
    const selections = [selectedFile, selectedFile];
    const started = await startWebCsvViewer(
      createNodeDuckDbWasmDatabase(),
      async () => selections.shift() ?? null,
    );
    if (started.status !== 'ready') throw new Error('Web startup check failed.');
    viewer = started.viewer;

    expect(viewer.capabilities).toEqual({ recentCsvSources: false });
    const open = { operation: 'csv.open', options: { delimiter: ';', header: true } } as const;
    const first = await viewer.call(open);
    const second = await viewer.call(open);
    if (first.status !== 'opened' || second.status !== 'opened') {
      throw new Error('Browser selections did not open.');
    }

    // The same physical file selected twice stays two unrelated CSV Sources: the browser gives the
    // runtime nothing it may treat as durable identity.
    expect(first.workingCsv.source.sourceId).not.toBe(second.workingCsv.source.sourceId);
    expect(first.workingCsv.workingCsvId).not.toBe(second.workingCsv.workingCsvId);
    expect(first.workingCsv.columns.map((column) => column.name)).toEqual(['id', 'name', 'status']);
    await expect(
      viewer.call({
        operation: 'csv.get-rows',
        workingCsvId: first.workingCsv.workingCsvId,
        offset: 0,
        limit: 10,
      }),
    ).resolves.toMatchObject({ filteredRowCount: 2 });

    await expect(viewer.call(open)).resolves.toEqual({ status: 'cancelled' });
  }, 20_000);
});
