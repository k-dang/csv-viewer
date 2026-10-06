import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeDuckDbWasmDatabase } from '../integration/fixtures/wasm-workspace';
import { ControllableWorker } from '../integration/fixtures/controllable-worker';
import { diagnosticCapture } from '../../../packages/workspace/test/diagnostic-capture';
import { DuckDbWasmWorkspaceDatabase } from './duckdb-wasm-database';
import type { CsvWorkspaceOwner } from '@csv-viewer/workspace/csv-workspace';
import { createCsvViewer } from '@csv-viewer/workspace/csv-workspace';
import type { ComparisonExecutor } from '../../../packages/workspace/src/comparison/comparison-executor';
import { DataEngineError } from '@csv-viewer/workspace/database';
import { openInScope } from '../../../packages/workspace/test/scoped-database';
import type { CsvViewerEvent } from '@csv-viewer/workspace/csv-viewer';
import { Deferred, Effect, Exit, Fiber } from 'effect';
import { AsyncDuckDB } from '@duckdb/duckdb-wasm';
import { WebWorkspaceHost } from './web-workspace-host';
import { disposeWorkspaceWhenPageHides, startWebCsvViewer } from './web-composition';

// The CsvViewer contract itself runs against this same Wasm engine from the integration suite,
// so these cases only cover what the web composition root adds:
// the startup gate, the browser capability set, browser-selection identity, and scoped source access.
let viewer: CsvWorkspaceOwner | undefined;

afterEach(async () => {
  await viewer?.dispose();
  viewer = undefined;
});

describe('web CsvViewer composition', () => {
  it('releases a CSV Source registered while its acquisition is interrupted', async () => {
    const { database, close } = await openInScope(createNodeDuckDbWasmDatabase().open());
    const file = new File(['name\nAda\n'], 'people.csv');
    const host = new WebWorkspaceHost(database, async () => file);
    const sourceId = host.registerSource(file);
    if (sourceId instanceof Object) throw new Error('CSV Source was not reserved.');
    const registered = Promise.withResolvers<string>();
    const releaseRegistration = Promise.withResolvers<void>();
    const register = AsyncDuckDB.prototype.registerFileBuffer;
    const registration = vi.spyOn(AsyncDuckDB.prototype, 'registerFileBuffer').mockImplementation(async function (this: AsyncDuckDB, reference, contents) {
      try {
        await register.call(this, reference, contents);
      } catch (cause) {
        registered.reject(cause);
        throw cause;
      }
      registered.resolve(reference);
      await releaseRegistration.promise;
    });
    const work = Effect.runFork(Effect.scoped(host.acquireEngineSource(sourceId).pipe(Effect.andThen(Effect.never))));

    try {
      const reference = await registered.promise;
      const read = `SELECT * FROM read_csv('${reference}', all_varchar = true)`;
      await expect(Effect.runPromise(database.readObjects(read))).resolves.toEqual([{ name: 'Ada' }]);

      const interruption = Effect.runPromise(Fiber.interrupt(work));
      releaseRegistration.resolve();
      await interruption;

      expect(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(work)))).toBe(true);
      await expect(Effect.runPromise(database.readObjects(read))).rejects.toThrow();
      await expect(Effect.runPromise(database.readObjects('SELECT 42 AS answer'))).resolves.toEqual([{ answer: 42 }]);
    } finally {
      releaseRegistration.resolve();
      await Effect.runPromise(Fiber.interrupt(work));
      registration.mockRestore();
      await close();
    }
  });

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
    expect(capture.outcome('workspace.release-database')).toBe('succeeded');
    expect(capture.logs.join('')).not.toContain('Workers are unavailable');
  });

  it('opens repeated browser selections as independent CSV Sources', async () => {
    const selectedFile = new File(
      ['id;name;status\n1;Ada;active\n2;Grace;active\n'],
      'people.txt',
      { type: 'text/plain' },
    );
    const selections = [selectedFile, selectedFile];
    const capture = diagnosticCapture();
    const started = await startWebCsvViewer(
      createNodeDuckDbWasmDatabase(),
      async () => selections.shift() ?? null,
      { diagnostics: capture.configuration },
    );
    if (started.status !== 'ready')
      throw new Error('Web startup check failed.');
    viewer = started.viewer;
    expect(capture.outcome('web.startup-check')).toBe('succeeded');

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
    viewer.onEvent(() => { throw new Error('PRIVATE subscriber defect.'); });
    viewer.onEvent((event) => events.push(event));

    database.failWorker();
    await expect(viewer.receive({ operation: 'PRIVATE malformed request' })).rejects.toThrow(
      'Reload CSV Viewer to start a new workspace.',
    );
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(capture.outcome('workspace.engine-stopped')).toBe('failed');
    expect(capture.outcome('workspace.notify-engine-stop')).toBe('defect');
    expect(capture.logs.join('')).not.toContain('PRIVATE');

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

  it('releases browser file reservations when a stopped workspace is disposed', async () => {
    const file = new File(['id\n1\n'], 'data.csv');
    const database = createNodeDuckDbWasmDatabase();
    const started = await startWebCsvViewer(database, async () => file, {
      limits: { sourceBytes: file.size, workspaceBytes: file.size },
    });
    if (started.status !== 'ready') throw new Error('Web startup check failed.');
    viewer = started.viewer;
    await expect(viewer.call({ operation: 'csv.open' })).resolves.toMatchObject({ status: 'opened' });
    const owner = await Effect.runPromise(database.ownerConnection());
    const run = vi.spyOn(owner, 'run');

    Deferred.doneUnsafe(database.stopped, Effect.void);
    await viewer.dispose();

    expect(run).not.toHaveBeenCalled();
    expect(await started.acquireDroppedSource(file)).toEqual(expect.any(String));
  }, 20_000);

  it('settles an admitted Comparison close before clearing sources after an engine stop', async () => {
    const database = createNodeDuckDbWasmDatabase();
    const file = new File(['id\n1\n'], 'data.csv');
    const host = new WebWorkspaceHost(database, async () => file);
    const validating = Promise.withResolvers<void>();
    const releasing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const capture = diagnosticCapture();
    const executor: ComparisonExecutor = {
      openAttempt: () => Effect.acquireRelease(Effect.succeed({
        validateKey: () => Effect.sync(() => validating.resolve()).pipe(Effect.andThen(Effect.never)),
        createSnapshot: () => Effect.die(new Error('The cancelled attempt must not create a snapshot.')),
      }), () => Effect.promise(() => {
        releasing.resolve();
        return release.promise;
      })),
      activateSnapshot: () => undefined,
      readWindow: () => Effect.die(new Error('No snapshot is available.')),
      dropSnapshot: () => Effect.die(new Error('A stopped engine must not drop snapshots.')),
      dispose: () => Effect.die(new Error('A stopped engine must not run executor cleanup.')),
    };
    viewer = await createCsvViewer(database.open(), host, {
      executor, diagnostics: capture.configuration, startup: { stopped: database.stopped },
    });
    const left = await viewer.call({ operation: 'csv.open' });
    const right = await viewer.call({ operation: 'csv.open' });
    if (left.status !== 'opened' || right.status !== 'opened') throw new Error('Both CSV Sources must open.');
    const comparison = await viewer.call({
      operation: 'comparison.open', baselineId: left.workingCsv.workingCsvId, candidateId: right.workingCsv.workingCsvId,
    });
    if (comparison.status === 'rejected') throw new Error('Comparison was rejected.');
    const comparisonId = comparison.comparison.comparisonId;
    await viewer.call({ operation: 'comparison.begin', comparisonId, kind: 'apply-key', key: ['id'] });
    await validating.promise;
    const close = viewer.call({ operation: 'comparison.close', comparisonId });
    try {
      await releasing.promise;
      Deferred.doneUnsafe(database.stopped, Effect.void);
      const disposal = viewer.dispose();
      release.resolve();
      await disposal;
      await expect(close).resolves.toEqual({ status: 'closed', comparisonId });
      expect(capture.completed().find((record) => record.message === 'comparison.compute')?.annotations)
        .toMatchObject({ outcome: 'cancelled' });
    } finally {
      release.resolve();
    }
  }, 20_000);

  it('releases an acquired database when a pending startup check outlives a fatal stop', async () => {
    const checking = Promise.withResolvers<void>();
    const checkResult = Promise.withResolvers<void>();
    const database = new FatalTestDatabase(Effect.promise(() => {
      checking.resolve();
      return checkResult.promise;
    }));
    const capture = diagnosticCapture();
    const startup = startWebCsvViewer(database, async () => null, { diagnostics: capture.configuration });

    await checking.promise;
    database.failWorker();
    await expect(startup).resolves.toEqual({ status: 'unsupported' });
    checkResult.resolve();
    for (const stage of ['workspace.close-database-connection', 'workspace.close-database-engine', 'workspace.release-database']) {
      expect(capture.outcome(stage)).toBe('succeeded');
    }
  });
});

function pageTransitionEvent(type: 'pagehide' | 'pageshow', persisted: boolean): Event {
  const event = new Event(type);
  Object.defineProperty(event, 'persisted', { value: persisted });
  return event;
}

/** Skips the engine start. Each test chooses the startup check and the engine release outcome. */
class FatalTestDatabase extends DuckDbWasmWorkspaceDatabase {
  constructor(
    private readonly check: Effect.Effect<void, DataEngineError> = Effect.void,
    private readonly engineRelease: Effect.Effect<void, DataEngineError> = Effect.void,
  ) {
    super({
      mainModule: 'duckdb.wasm',
      mainWorker: 'duckdb.worker.js',
      createWorker: () => Promise.reject(new Error('The test does not start a Worker.')),
    });
  }

  protected override start(): Effect.Effect<void, DataEngineError> {
    return Effect.void;
  }

  protected override verifyInMemoryCsvQuery(): Effect.Effect<void, DataEngineError> {
    return this.check;
  }

  protected override closeEngine(): Effect.Effect<void, DataEngineError> {
    return this.engineRelease;
  }

  failWorker(): void {
    Deferred.doneUnsafe(this.stopped, Effect.void);
  }
}

it('reports a failed startup check and failed cleanup without driver text', async () => {
  const capture = diagnosticCapture();
  const database = new FatalTestDatabase(
    Effect.fail(new DataEngineError({ cause: new Error('PRIVATE startup failure') })),
    Effect.fail(new DataEngineError({ cause: new Error('PRIVATE termination failure') })),
  );

  await expect(startWebCsvViewer(database, async () => null, { diagnostics: capture.configuration }))
    .resolves.toEqual({ status: 'unsupported' });

  expect(capture.outcome('web.startup-check')).toBe('recoverable-failure');
  expect(capture.outcome('workspace.release-database')).toBe('cleanup-failed');
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
  expect(capture.outcome('workspace.release-database')).toBe('cleanup-failed');
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
  expect(capture.outcome('workspace.release-database')).toBe('succeeded');
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
