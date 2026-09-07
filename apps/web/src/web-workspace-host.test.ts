// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DuckDbWasmWorkspaceDatabase } from './duckdb-wasm-database';
import { WebWorkspaceHost } from './web-workspace-host';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WebWorkspaceHost', () => {
  it('hands an exported CSV to the browser as a named download', async () => {
    const downloadClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export');
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const host = new WebWorkspaceHost(
      // SAFETY: Export delivery does not access the database dependency.
      {} as DuckDbWasmWorkspaceDatabase,
      async () => null,
    );

    await expect(
      host.deliverExport({
        sourceId: 'source-1',
        suggestedName: 'people.csv',
        contents: 'name\nAda\n',
      }),
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
