import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeDuckDbWasmDatabase } from '../integration/fixtures/wasm-workspace';
import { DuckDbWasmWorkspaceDatabase } from './duckdb-wasm-database';
import type { CsvWorkspaceOwner } from '@csv-viewer/workspace/csv-workspace';
import type { CsvViewerEvent } from '@csv-viewer/workspace/csv-viewer';
import { disposeWorkspaceWhenPageHides, startWebCsvViewer } from './web-composition';

// The CsvViewer contract itself runs against this same Wasm engine from the integration suite,
// so these cases only cover what the web composition root adds:
// the startup gate, the browser capability set, and browser-selection identity.
let viewer: CsvWorkspaceOwner | undefined;

afterEach(async () => {
  await viewer?.dispose();
  viewer = undefined;
});

describe('web CsvViewer composition', () => {
  it('disposes the in-memory workspace once when the page ends', async () => {
    const page = new EventTarget();
    const dispose = vi.fn(async () => undefined);
    disposeWorkspaceWhenPageHides({ dispose }, page);

    page.dispatchEvent(new Event('pagehide'));
    page.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });

  it('reloads instead of restoring a disposed workspace from the back-forward cache', async () => {
    const page = new EventTarget();
    const dispose = vi.fn(async () => undefined);
    const reload = vi.fn();
    disposeWorkspaceWhenPageHides({ dispose }, page, reload);

    page.dispatchEvent(pageTransitionEvent('pagehide', true));
    page.dispatchEvent(pageTransitionEvent('pageshow', true));
    page.dispatchEvent(pageTransitionEvent('pageshow', true));

    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does not offer CSV Source selection when the pinned Worker cannot start', async () => {
    const pickFile = vi.fn<() => Promise<File | null>>();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const database = new DuckDbWasmWorkspaceDatabase({
      mainModule: 'duckdb-eh.wasm',
      mainWorker: 'duckdb-browser-eh.worker.js',
      createWorker: () => Promise.reject(new Error('Workers are unavailable.')),
    });

    await expect(startWebCsvViewer(database, pickFile)).resolves.toEqual({
      status: 'unsupported',
    });
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
    if (started.status !== 'ready')
      throw new Error('Web startup check failed.');
    viewer = started.viewer;

    expect(viewer.capabilities).toEqual({
      recentCsvSources: false,
      exportCsvSuccessMessage: 'Download started',
      warnOnPageUnload: true,
    });
    const open = {
      operation: 'csv.open',
      options: { delimiter: ';', header: true },
    } as const;
    const first = await viewer.call(open);
    const second = await viewer.call(open);
    if (first.status !== 'opened' || second.status !== 'opened') {
      throw new Error('Browser selections did not open.');
    }

    // The same physical file selected twice stays two unrelated CSV Sources: the browser gives the
    // runtime nothing it may treat as durable identity.
    expect(first.workingCsv.source.sourceId).not.toBe(
      second.workingCsv.source.sourceId,
    );
    expect(first.workingCsv.workingCsvId).not.toBe(
      second.workingCsv.workingCsvId,
    );
    expect(first.workingCsv.columns.map((column) => column.name)).toEqual([
      'id',
      'name',
      'status',
    ]);
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

  it('turns a fatal Worker failure into one terminal workspace event', async () => {
    const database = new FatalTestDatabase();
    const started = await startWebCsvViewer(database, async () => null);
    if (started.status !== 'ready') throw new Error('Web startup check failed.');
    viewer = started.viewer;
    const events: CsvViewerEvent[] = [];
    viewer.onEvent((event) => events.push(event));

    database.failWorker();
    database.failWorker();

    expect(events).toEqual([
      {
        type: 'fatal-error',
        message: 'The local data engine stopped unexpectedly.',
      },
    ]);
    await expect(viewer.call({ operation: 'csv.get-recent-sources' })).rejects.toThrow(
      'Reload CSV Viewer to start a new workspace.',
    );
  });
});

function pageTransitionEvent(type: 'pagehide' | 'pageshow', persisted: boolean): Event {
  const event = new Event(type);
  Object.defineProperty(event, 'persisted', { value: persisted });
  return event;
}

class FatalTestDatabase extends DuckDbWasmWorkspaceDatabase {
  private fatalListener: ((error: Error) => void) | undefined;

  constructor() {
    super({
      mainModule: 'duckdb.wasm',
      mainWorker: 'duckdb.worker.js',
      createWorker: () => Promise.reject(new Error('The test does not start a Worker.')),
    });
  }

  override withRegisteredFile<T>(
    _name: string,
    _contents: Uint8Array,
    use: (reference: string) => Promise<T>,
  ): Promise<T> {
    return use('/startup-check.csv');
  }

  override readObjects(): Promise<Array<Record<string, string>>> {
    return Promise.resolve([{ ready: 'true' }]);
  }

  override onFatalError(listener: (error: Error) => void): () => void {
    this.fatalListener = listener;
    return () => {
      this.fatalListener = undefined;
    };
  }

  failWorker(): void {
    this.fatalListener?.(new Error('Worker crashed.'));
  }
}

it('cancels a pending startup query on page hide without waiting for its response', async () => {
  const database = new DuckDbWasmWorkspaceDatabase({
    mainModule: 'duckdb.wasm', mainWorker: 'duckdb.worker.js',
    createWorker: () => new Promise(() => {}),
  });
  const close = vi.spyOn(database, 'close');
  const controller = new AbortController();
  const startup = startWebCsvViewer(database, async () => null, undefined, controller.signal);
  const settled = vi.fn();
  void startup.then(settled);
  const page = new EventTarget();
  const dispose = disposeWorkspaceWhenPageHides({ dispose: async () => {
    controller.abort();
    await startup;
  } }, page);
  page.dispatchEvent(new Event('pagehide'));
  dispose();
  await vi.waitFor(() => expect(settled).toHaveBeenCalledWith({ status: 'unsupported' }));
  expect(close).toHaveBeenCalledOnce();
});
