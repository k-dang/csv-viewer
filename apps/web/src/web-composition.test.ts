import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeDuckDbWasmDatabase } from '../integration/fixtures/wasm-workspace';
import { ControllableWorker } from '../integration/fixtures/controllable-worker';
import { diagnosticCapture } from '../../../packages/workspace/test/diagnostic-capture';
import { DuckDbWasmWorkspaceDatabase } from './duckdb-wasm-database';
import type { CsvWorkspaceOwner } from '@csv-viewer/workspace/csv-workspace';
import type { CsvViewerEvent } from '@csv-viewer/workspace/csv-viewer';
import { Deferred, Effect } from 'effect';
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
    const capture = diagnosticCapture();
    const database = new DuckDbWasmWorkspaceDatabase({
      mainModule: 'duckdb-eh.wasm',
      mainWorker: 'duckdb-browser-eh.worker.js',
      createWorker: () => Promise.reject(new Error('Workers are unavailable.')),
    });

    await expect(startWebCsvViewer(database, pickFile, { diagnostics: capture.configuration })).resolves.toEqual({
      status: 'unsupported',
    });
    expect(pickFile).not.toHaveBeenCalled();
    expect(capture.outcome('workspace.acquire-database')).toBe('recoverable-failure');
    expect(capture.outcome('web.startup-cleanup')).toBe('succeeded');
    expect(capture.logs.join('')).not.toContain('Workers are unavailable');
  });

  it('opens repeated browser selections as independent CSV Sources', async () => {
    const selectedFile = new File(
      ['id;name;status\n1;Ada;active\n2;Grace;active\n'],
      'people.txt',
      { type: 'text/plain' },
    );
    const selections = [selectedFile, selectedFile];
    const database = createNodeDuckDbWasmDatabase();
    const check = vi.spyOn(database, 'verifyInMemoryCsvQuery');
    const started = await startWebCsvViewer(
      database,
      async () => selections.shift() ?? null,
    );
    if (started.status !== 'ready')
      throw new Error('Web startup check failed.');
    viewer = started.viewer;
    expect(check).toHaveBeenCalledOnce();

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
    const capture = diagnosticCapture();
    const started = await startWebCsvViewer(database, async () => null, { diagnostics: capture.configuration });
    if (started.status !== 'ready') throw new Error('Web startup check failed.');
    viewer = started.viewer;
    const events: CsvViewerEvent[] = [];
    viewer.onEvent((event) => events.push(event));

    database.failWorker();
    await expect(viewer.receive({ operation: 'PRIVATE malformed request' })).rejects.toThrow(
      'Reload CSV Viewer to start a new workspace.',
    );
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(capture.outcome('workspace.engine-stopped')).toBe('failed');

    expect(events).toEqual([
      {
        type: 'fatal-error',
        message: 'The local data engine stopped unexpectedly.',
      },
    ]);
    await expect(viewer.call({ operation: 'csv.get-recent-sources' })).rejects.toThrow(
      'Reload CSV Viewer to start a new workspace.',
    );
    await expect(viewer.confirmClose()).rejects.toThrow(
      'Reload CSV Viewer to start a new workspace.',
    );
    const lateEvents: CsvViewerEvent[] = [];
    viewer.onEvent((event) => lateEvents.push(event));
    expect(lateEvents).toEqual(events);
  });

  it('rejects a build that finishes after a fatal Worker failure', async () => {
    const database = new FatalTestDatabase();
    const opening = Promise.withResolvers<void>();
    vi.spyOn(database, 'open').mockImplementation(async () => {
      await opening.promise;
      return database;
    });
    const startup = startWebCsvViewer(database, async () => null);

    database.failWorker();
    await expect(startup).resolves.toEqual({ status: 'unsupported' });
    opening.resolve();
  });
});

function pageTransitionEvent(type: 'pagehide' | 'pageshow', persisted: boolean): Event {
  const event = new Event(type);
  Object.defineProperty(event, 'persisted', { value: persisted });
  return event;
}

class FatalTestDatabase extends DuckDbWasmWorkspaceDatabase {
  constructor() {
    super({
      mainModule: 'duckdb.wasm',
      mainWorker: 'duckdb.worker.js',
      createWorker: () => Promise.reject(new Error('The test does not start a Worker.')),
    });
  }

  override open(): Promise<this> {
    return Promise.resolve(this);
  }

  override verifyInMemoryCsvQuery(): Promise<void> {
    return Promise.resolve();
  }

  override closeOwnerConnection(): Promise<void> {
    return Promise.resolve();
  }

  override closeEngine(): Promise<void> {
    return Promise.resolve();
  }

  failWorker(): void {
    Deferred.doneUnsafe(this.stopped, Effect.void);
  }
}

it('reports a failed startup check and failed cleanup without driver text', async () => {
  const capture = diagnosticCapture();
  const database = new FatalTestDatabase();
  vi.spyOn(database, 'verifyInMemoryCsvQuery').mockRejectedValue(new Error('PRIVATE startup failure'));
  vi.spyOn(database, 'closeEngine').mockRejectedValue(new Error('PRIVATE termination failure'));

  await expect(startWebCsvViewer(database, async () => null, { diagnostics: capture.configuration }))
    .resolves.toEqual({ status: 'unsupported' });

  expect(capture.outcome('web.startup-check')).toBe('recoverable-failure');
  expect(capture.outcome('web.startup-cleanup')).toBe('cleanup-failed');
  expect(capture.logs.join('')).not.toContain('PRIVATE');
});

it('reports Worker termination failure during acquisition as startup cleanup', async () => {
  const capture = diagnosticCapture();
  const worker = new ControllableWorker();
  worker.terminate.mockImplementation(() => { throw new Error('PRIVATE termination failure'); });
  const database = new DuckDbWasmWorkspaceDatabase({
    mainModule: 'duckdb.wasm', mainWorker: 'duckdb.worker.js',
    createWorker: () => Promise.resolve(worker),
  });
  const startup = startWebCsvViewer(database, async () => null, { diagnostics: capture.configuration });
  await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
  worker.emitError(new Error('PRIVATE Worker crash'));

  await expect(startup).resolves.toEqual({ status: 'unsupported' });
  expect(capture.outcome('web.startup-cleanup')).toBe('cleanup-failed');
  expect(capture.logs.join('')).not.toContain('PRIVATE');
});

it('cancels pending Worker creation on page hide without waiting for it to resolve', async () => {
  const creation = Promise.withResolvers<Worker>();
  const worker = new ControllableWorker();
  const database = new DuckDbWasmWorkspaceDatabase({
    mainModule: 'duckdb.wasm', mainWorker: 'duckdb.worker.js',
    createWorker: () => creation.promise,
  });
  const controller = new AbortController();
  const capture = diagnosticCapture();
  const startup = startWebCsvViewer(database, async () => null, { signal: controller.signal, diagnostics: capture.configuration });
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
  expect(capture.outcome('workspace.acquire-database')).toBe('interrupted');
  expect(capture.outcome('web.startup-cleanup')).toBe('succeeded');
  creation.resolve(worker);
  await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
});

it('reports a failed termination when a Worker arrives after cancelled startup', async () => {
  const capture = diagnosticCapture();
  const creation = Promise.withResolvers<Worker>();
  const workerRequested = Promise.withResolvers<void>();
  const worker = new ControllableWorker();
  worker.terminate.mockImplementation(() => { throw new Error('PRIVATE late termination failure'); });
  const database = new DuckDbWasmWorkspaceDatabase({
    mainModule: 'duckdb.wasm', mainWorker: 'duckdb.worker.js',
    createWorker: () => { workerRequested.resolve(); return creation.promise; },
  });
  const controller = new AbortController();
  const startup = startWebCsvViewer(database, async () => null, { signal: controller.signal, diagnostics: capture.configuration });
  await workerRequested.promise;
  controller.abort();
  await expect(startup).resolves.toEqual({ status: 'unsupported' });
  creation.resolve(worker);

  await vi.waitFor(() => expect(capture.outcome('web.startup-late-cleanup')).toBe('cleanup-failed'));
  expect(capture.logs.join('')).not.toContain('PRIVATE');
});
