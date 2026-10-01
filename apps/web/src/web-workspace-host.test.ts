// @vitest-environment jsdom
import { Effect, Exit } from 'effect';
import { CsvSourceUnavailableError } from '@csv-viewer/workspace/workspace-host';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeDuckDbWasmDatabase } from '../integration/fixtures/wasm-workspace';
import { WebWorkspaceHost } from './web-workspace-host';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WebWorkspaceHost', () => {
  it('keeps unexpected picker rejections as defects even when they use a source error class', async () => {
    const failure = new CsvSourceUnavailableError('unreadable', 'PRIVATE picker failure.');
    const host = new WebWorkspaceHost(createNodeDuckDbWasmDatabase(), async () => { throw failure; });

    const exit = await Effect.runPromiseExit(host.acquireSource());

    expect(exit).toEqual(Exit.die(failure));
  });

  it('classifies a failed File read as an unreadable source without leaking browser details', async () => {
    const file = new File(['name\nAda\n'], 'people.csv');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => { throw new Error('PRIVATE browser failure.'); } });
    const host = new WebWorkspaceHost(createNodeDuckDbWasmDatabase(), async () => file);
    const sourceId = await Effect.runPromise(host.acquireSource());
    if (!sourceId || sourceId instanceof Object) throw new Error('CSV Source was not selected.');

    const exit = await Effect.runPromiseExit(Effect.scoped(host.acquireEngineSource(sourceId)));

    expect(exit).toEqual(Exit.fail(new CsvSourceUnavailableError('unreadable', 'The CSV Source could not be read.')));
  });

  it('hands an exported CSV to the browser as a named download', async () => {
    const downloadClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export');
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const host = new WebWorkspaceHost(
      createNodeDuckDbWasmDatabase(),
      async () => null,
    );

    await expect(
      Effect.runPromise(host.deliverExport({
        sourceId: 'source-1',
        suggestedName: 'people.csv',
        contents: 'name\nAda\n',
      })),
    ).resolves.toEqual({ status: 'delivered' });

    const exportedBlob = createObjectUrl.mock.calls[0]?.[0];
    expect(exportedBlob).toBeInstanceOf(Blob);
    if (!(exportedBlob instanceof Blob)) throw new Error('Export did not create a Blob.');
    expect(exportedBlob.type).toBe('text/csv;charset=utf-8');
    expect(downloadClick).toHaveBeenCalledOnce();
    expect(downloadClick.mock.instances[0]).toMatchObject({
      download: 'people.csv',
      href: 'blob:export',
    });
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    await expect(readBlobText(exportedBlob)).resolves.toBe('name\nAda\n');
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:export');
  });
});

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsText(blob);
  });
}
