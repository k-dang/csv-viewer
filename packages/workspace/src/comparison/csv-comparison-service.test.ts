import { Context, Effect, Layer, ManagedRuntime } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupEffect, databaseEffect } from './comparison-effects';
import type {
  CloseComparisonResult,
  ComparisonOperationId,
  ComparisonSummary,
  WorkingCsvView,
  SourceKeyDiagnostics,
} from '../csv-viewer';
import { CsvComparisonService } from './csv-comparison-service';
import {
  ComparisonExecutor,
  type CreateComparisonSnapshotRequest,
  type ReadComparisonSnapshotWindowRequest,
  type StoredComparisonWindow,
} from './comparison-executor';

function workingCsv(workingCsvId: string, name: string, columns = ['id', 'name', 'status']): WorkingCsvView {
  return {
    workingCsvId,
    dataRevision: 0,
    source: {
      sourceId: workingCsvId,
      location: `C:/fixtures/${name}`,
      name,
      sizeBytes: 10,
    },
    columns: columns.map((column) => ({ name: column, type: 'VARCHAR' })),
    rowCount: 0,
    dialect: {},
    editState: {
      workingCsvId,
      hasUnexportedChanges: false,
      canUndo: false,
      canRedo: false,
    },
  };
}

class FakeCsvStore {
  readonly workingCsvs = new Map<string, WorkingCsvView>();
  private listeners = new Set<(workingCsvId: string) => void>();

  getState(workingCsvId: string) {
    return this.workingCsvs.get(workingCsvId) ?? null;
  }

  list() {
    return [...this.workingCsvs.values()];
  }

  isClosing() {
    return false;
  }

  subscribeToDataChanges(listener: (workingCsvId: string) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  change(workingCsvId: string) {
    const current = this.workingCsvs.get(workingCsvId);
    if (current)
      this.workingCsvs.set(workingCsvId, {
        ...current,
        dataRevision: current.dataRevision + 1,
      });
    for (const listener of this.listeners) listener(workingCsvId);
  }
}

const validDiagnostics: SourceKeyDiagnostics = {
  blankRowCount: 0,
  duplicateGroupCount: 0,
  blankExamples: [],
  duplicateExamples: [],
};

const emptySummary: ComparisonSummary = {
  rows: {
    changed: 0,
    baselineOnly: 0,
    candidateOnly: 0,
    unchanged: 0,
    total: 0,
  },
  changedColumns: [],
};

class ScriptedComparisonExecutor implements ComparisonExecutor {
  deferSnapshots = false;
  deferDrops = false;
  deferReleases = false;
  failWindowReads = false;
  dropFailuresRemaining = 0;
  releaseAttemptCount = 0;
  disposeCalled = false;
  readonly droppedArtifacts: string[] = [];
  private readonly pendingSnapshots = new Map<string, (error: Error) => void>();
  private readonly pendingDrops: Array<() => void> = [];
  private readonly pendingReleases: Array<() => void> = [];

  openAttempt() {
    return Effect.acquireRelease(Effect.succeed({
      validateKey: () => databaseEffect(() => this.validateKey()),
      createSnapshot: (request: CreateComparisonSnapshotRequest) => databaseEffect(() => this.createSnapshot(request)).pipe(
        Effect.onInterrupt(() => Effect.sync(() => this.cancel(request.artifactId))),
      ),
    }), () => cleanupEffect(() => this.release()));
  }

  async validateKey(): Promise<SourceKeyDiagnostics> {
    return validDiagnostics;
  }

  async createSnapshot(request: CreateComparisonSnapshotRequest): Promise<ComparisonSummary> {
    if (!this.deferSnapshots) return emptySummary;
    return new Promise((_resolve, reject) => {
      this.pendingSnapshots.set(request.artifactId, reject);
    });
  }

  activateSnapshot(_artifactId: ComparisonOperationId): void {}

  cancel(operationId: string): void {
    this.pendingSnapshots.get(operationId)?.(new Error('cancelled'));
    this.pendingSnapshots.delete(operationId);
  }

  readWindow(_request: ReadComparisonSnapshotWindowRequest) {
    return databaseEffect(async (): Promise<StoredComparisonWindow> => {
      if (this.failWindowReads) throw new Error('scripted read failure');
      return { totalRowCount: 0, rows: [] };
    });
  }

  dropSnapshot(artifactId: string) {
    return databaseEffect(async (): Promise<void> => {
      this.droppedArtifacts.push(artifactId);
      if (this.deferDrops) {
        await new Promise<void>((resolve) => this.pendingDrops.push(resolve));
      }
      if (this.dropFailuresRemaining > 0) {
        this.dropFailuresRemaining -= 1;
        throw new Error('scripted drop failure');
      }
    });
  }

  async release(): Promise<void> {
    this.releaseAttemptCount += 1;
    if (this.deferReleases) {
      await new Promise<void>((resolve) => this.pendingReleases.push(resolve));
    }
  }

  releaseDrops(): void {
    for (const resolve of this.pendingDrops.splice(0)) resolve();
  }

  releaseWorkers(): void {
    for (const resolve of this.pendingReleases.splice(0)) resolve();
  }

  hasPendingSnapshot(artifactId: string): boolean {
    return this.pendingSnapshots.has(artifactId);
  }

  dispose() {
    return databaseEffect(async (): Promise<void> => {
      this.releaseDrops();
      this.releaseWorkers();
      this.disposeCalled = true;
      for (const reject of this.pendingSnapshots.values()) reject(new Error('disposed'));
      this.pendingSnapshots.clear();
    });
  }
}

const runtimeDisposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(runtimeDisposals.splice(0).map((dispose) => dispose()));
});

const TestComparisons = Context.Service<CsvComparisonService>('test/Comparisons');

function createService(store: FakeCsvStore, executor: ComparisonExecutor) {
  const runtime = ManagedRuntime.make(Layer.effect(TestComparisons, Effect.gen(function* () {
    return new CsvComparisonService(store, yield* ComparisonExecutor, yield* Effect.scope);
  })).pipe(Layer.provide(Layer.succeed(ComparisonExecutor, executor))));
  runtimeDisposals.push(() => runtime.dispose());
  const service = runtime.runSync(TestComparisons);
  return {
    candidatesFor: service.candidatesFor.bind(service),
    open: service.open.bind(service),
    getState: service.getState.bind(service),
    swap: service.swap.bind(service),
    subscribe: service.subscribe.bind(service),
    dependentComparisonIds: service.dependentComparisonIds.bind(service),
    begin: (request: Parameters<CsvComparisonService['begin']>[0]) => {
      const result = runtime.runSync(service.begin(request));
      return result.status === 'accepted'
        ? { ...result, completion: runtime.runPromise(result.completion) }
        : result;
    },
    cancel: (request: Parameters<CsvComparisonService['cancel']>[0]) => runtime.runPromise(service.cancel(request)),
    close: (id: string) => runtime.runPromise(service.close(id)),
    getWindow: (request: Parameters<CsvComparisonService['getWindow']>[0]) => runtime.runPromise(service.getWindow(request)),
    dispose: async () => {
      await runtime.runPromise(service.dispose());
      await runtime.dispose();
    },
  };
}

const settles = { interval: 1 };

function waitForIdle(service: ReturnType<typeof createService>, comparisonId: string) {
  return vi.waitUntil(() => {
    const state = service.getState(comparisonId);
    return state && !state.operation ? state : false;
  }, settles);
}

function waitForPhase(
  service: ReturnType<typeof createService>,
  comparisonId: string,
  phase: 'validating' | 'comparing' | 'summarizing',
) {
  return vi.waitUntil(() => {
    const operation = service.getState(comparisonId)?.operation;
    return operation?.phase === phase ? operation : false;
  }, settles);
}

function waitForArtifactDrop(executor: ScriptedComparisonExecutor, artifactId: string) {
  return vi.waitUntil(() => executor.droppedArtifacts.includes(artifactId), settles);
}

function waitForReleaseAttemptCount(executor: ScriptedComparisonExecutor, expectedCount: number) {
  return vi.waitUntil(() => executor.releaseAttemptCount >= expectedCount, settles);
}

describe('CsvComparisonService interaction contract', () => {
  it('orders compatible candidates first and explains incompatible columns', () => {
    const store = new FakeCsvStore();
    store.workingCsvs.set('a', workingCsv('a', 'baseline.csv'));
    store.workingCsvs.set('b', workingCsv('b', 'z-compatible.csv'));
    store.workingCsvs.set('c', workingCsv('c', 'a-incompatible.csv', ['id', 'title']));
    const service = createService(store, new ScriptedComparisonExecutor());

    expect(service.candidatesFor('a')).toEqual([
      expect.objectContaining({
        workingCsv: expect.objectContaining({ workingCsvId: 'b' }),
        compatibility: { kind: 'compatible' },
      }),
      expect.objectContaining({
        workingCsv: expect.objectContaining({ workingCsvId: 'c' }),
        compatibility: {
          kind: 'incompatible',
          missingFromBaseline: ['title'],
          missingFromCandidate: ['name', 'status'],
        },
      }),
    ]);
  });

  it('reuses an unordered pair without changing its orientation', () => {
    const store = new FakeCsvStore();
    store.workingCsvs.set('a', workingCsv('a', 'a.csv'));
    store.workingCsvs.set('b', workingCsv('b', 'b.csv'));
    const service = createService(store, new ScriptedComparisonExecutor());

    const opened = service.open({ baselineId: 'a', candidateId: 'b' });
    const reversed = service.open({ baselineId: 'b', candidateId: 'a' });

    expect(opened.status).toBe('created');
    expect(reversed).toMatchObject({
      status: 'existing',
      comparison: {
        baseline: { workingCsvId: 'a' },
        candidate: { workingCsvId: 'b' },
      },
    });
  });

  it('resolves source-unavailable when a source disappears before generation starts', async () => {
    const store = new FakeCsvStore();
    store.workingCsvs.set('a', workingCsv('a', 'a.csv'));
    store.workingCsvs.set('b', workingCsv('b', 'b.csv'));
    const service = createService(store, new ScriptedComparisonExecutor());
    const opened = service.open({ baselineId: 'a', candidateId: 'b' });
    if (opened.status === 'rejected') throw new Error('open rejected');

    const begun = service.begin({
      kind: 'apply-key',
      comparisonId: opened.comparison.comparisonId,
      key: ['id'],
    });
    if (begun.status !== 'accepted') throw new Error('begin rejected');
    store.workingCsvs.delete('a');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(begun.completion).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'source-unavailable', retryable: false },
      comparison: null,
    });
    await expect(service.close(opened.comparison.comparisonId)).resolves.toEqual({
      status: 'closed',
      comparisonId: opened.comparison.comparisonId,
    });

    error.mockRestore();
    await service.dispose();
  });

  it('publishes a replacement before retiring the prior snapshot', async () => {
    const store = new FakeCsvStore();
    store.workingCsvs.set('a', workingCsv('a', 'a.csv'));
    store.workingCsvs.set('b', workingCsv('b', 'b.csv'));
    const executor = new ScriptedComparisonExecutor();
    const service = createService(store, executor);
    const opened = service.open({ baselineId: 'a', candidateId: 'b' });
    if (opened.status === 'rejected') throw new Error('open rejected');

    const first = service.begin({
      kind: 'apply-key',
      comparisonId: opened.comparison.comparisonId,
      key: ['id'],
    });
    if (first.status !== 'accepted') throw new Error('apply rejected');
    await first.completion;

    executor.deferDrops = true;
    const refresh = service.begin({
      kind: 'refresh',
      comparisonId: opened.comparison.comparisonId,
    });
    if (refresh.status !== 'accepted') throw new Error('refresh rejected');
    while (executor.droppedArtifacts.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    store.change('a');
    expect(service.getState(opened.comparison.comparisonId)?.applied?.freshness).toEqual({
      kind: 'outdated',
      changedSides: ['baseline'],
    });
    executor.releaseDrops();
    const outcome = await refresh.completion;
    if (outcome.status !== 'applied') throw new Error(`Refresh completed as ${outcome.status}.`);
    expect(outcome.comparison.applied?.freshness).toEqual({
      kind: 'outdated',
      changedSides: ['baseline'],
    });
  });

  it('makes operation completion awaitable before publishing the running state', async () => {
    const store = new FakeCsvStore();
    store.workingCsvs.set('a', workingCsv('a', 'a.csv'));
    store.workingCsvs.set('b', workingCsv('b', 'b.csv'));
    const service = createService(store, new ScriptedComparisonExecutor());
    const opened = service.open({ baselineId: 'a', candidateId: 'b' });
    if (opened.status === 'rejected') throw new Error('open rejected');
    let close: Promise<CloseComparisonResult> | null = null;
    service.subscribe((event) => {
      if (event.kind === 'changed' && event.comparison.operation) {
        close = service.close(event.comparison.comparisonId);
      }
    });

    service.begin({
      kind: 'apply-key',
      comparisonId: opened.comparison.comparisonId,
      key: ['id'],
    });

    expect(close).not.toBeNull();
    await expect(close).resolves.toEqual({
      status: 'closed',
      comparisonId: opened.comparison.comparisonId,
    });
    expect(service.getState(opened.comparison.comparisonId)).toBeNull();
    await service.dispose();
  });

  it('publishes cancellation instead of translating an interrupted executor into query failure', async () => {
    const store = new FakeCsvStore();
    store.workingCsvs.set('a', workingCsv('a', 'a.csv'));
    store.workingCsvs.set('b', workingCsv('b', 'b.csv'));
    const executor = new ScriptedComparisonExecutor();
    executor.deferSnapshots = true;
    const service = createService(store, executor);
    const errorLog = vi.spyOn(console, 'error');
    const opened = service.open({ baselineId: 'a', candidateId: 'b' });
    if (opened.status === 'rejected') throw new Error('open rejected');

    const begun = service.begin({
      kind: 'apply-key',
      comparisonId: opened.comparison.comparisonId,
      key: ['id'],
    });
    if (begun.status !== 'accepted') throw new Error('begin rejected');
    await vi.waitUntil(() => executor.hasPendingSnapshot(begun.operationId), {
      interval: 1,
    });
    await expect(
      service.cancel({
        comparisonId: opened.comparison.comparisonId,
        operationId: begun.operationId,
      }),
    ).resolves.toEqual({
      status: 'requested',
    });

    const cancelled = await waitForIdle(service, opened.comparison.comparisonId);
    expect(cancelled).toMatchObject({
      applied: null,
      lastAttempt: { attemptId: begun.operationId, status: 'cancelled' },
    });
    expect(executor.droppedArtifacts).toContain(begun.operationId);
    expect(executor.releaseAttemptCount).toBeGreaterThan(0);
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
    await service.dispose();
  });

  it('keeps the published replacement when retiring the prior snapshot fails', async () => {
    const store = new FakeCsvStore();
    store.workingCsvs.set('a', workingCsv('a', 'a.csv'));
    store.workingCsvs.set('b', workingCsv('b', 'b.csv'));
    const executor = new ScriptedComparisonExecutor();
    const service = createService(store, executor);
    const opened = service.open({ baselineId: 'a', candidateId: 'b' });
    if (opened.status === 'rejected') throw new Error('open rejected');
    service.begin({
      kind: 'apply-key',
      comparisonId: opened.comparison.comparisonId,
      key: ['id'],
    });
    const first = await waitForIdle(service, opened.comparison.comparisonId);
    const firstToken = first?.applied?.resultToken;
    if (!firstToken) throw new Error('result not applied');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    executor.dropFailuresRemaining = 1;

    service.begin({
      kind: 'apply-key',
      comparisonId: opened.comparison.comparisonId,
      key: ['id'],
    });
    const replacement = await waitForIdle(service, opened.comparison.comparisonId);

    expect(replacement?.lastAttempt?.status).toBe('applied');
    expect(replacement?.applied?.resultToken).not.toBe(firstToken);
    expect(executor.droppedArtifacts).toContain(firstToken);

    service.begin({
      kind: 'refresh',
      comparisonId: opened.comparison.comparisonId,
    });
    await waitForIdle(service, opened.comparison.comparisonId);
    expect(executor.droppedArtifacts.filter((artifactId) => artifactId === firstToken)).toHaveLength(2);
    error.mockRestore();
    await service.dispose();
  });

  it('publishes a replacement atomically before retiring the prior snapshot', async () => {
    const store = new FakeCsvStore();
    store.workingCsvs.set('a', workingCsv('a', 'a.csv'));
    store.workingCsvs.set('b', workingCsv('b', 'b.csv'));
    const executor = new ScriptedComparisonExecutor();
    const service = createService(store, executor);
    const opened = service.open({ baselineId: 'a', candidateId: 'b' });
    if (opened.status === 'rejected') throw new Error('open rejected');
    service.begin({
      kind: 'apply-key',
      comparisonId: opened.comparison.comparisonId,
      key: ['id'],
    });
    const first = await waitForIdle(service, opened.comparison.comparisonId);
    const firstToken = first?.applied?.resultToken;
    if (!firstToken) throw new Error('result not applied');
    executor.deferDrops = true;
    executor.deferReleases = true;
    const releaseAttemptCountBeforeRefresh = executor.releaseAttemptCount;

    service.begin({
      kind: 'refresh',
      comparisonId: opened.comparison.comparisonId,
    });
    await waitForPhase(service, opened.comparison.comparisonId, 'summarizing');
    await waitForArtifactDrop(executor, firstToken);

    const published = service.getState(opened.comparison.comparisonId);
    expect(executor.droppedArtifacts).toContain(firstToken);
    expect(published?.operation?.phase).toBe('summarizing');
    expect(published?.lastAttempt).toBeNull();
    expect(published?.applied?.resultToken).not.toBe(firstToken);

    executor.deferDrops = false;
    executor.releaseDrops();
    await waitForReleaseAttemptCount(executor, releaseAttemptCountBeforeRefresh + 1);
    expect(service.getState(opened.comparison.comparisonId)?.operation?.phase).toBe('summarizing');
    executor.deferReleases = false;
    executor.releaseWorkers();
    const completed = await waitForIdle(service, opened.comparison.comparisonId);
    expect(completed?.operation).toBeNull();
    expect(completed?.lastAttempt?.status).toBe('applied');
    await service.dispose();
  });

  it('disposes the executor even when snapshot cleanup fails', async () => {
    const store = new FakeCsvStore();
    store.workingCsvs.set('a', workingCsv('a', 'a.csv'));
    store.workingCsvs.set('b', workingCsv('b', 'b.csv'));
    const executor = new ScriptedComparisonExecutor();
    const service = createService(store, executor);
    const opened = service.open({ baselineId: 'a', candidateId: 'b' });
    if (opened.status === 'rejected') throw new Error('open rejected');
    service.begin({
      kind: 'apply-key',
      comparisonId: opened.comparison.comparisonId,
      key: ['id'],
    });
    await waitForIdle(service, opened.comparison.comparisonId);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    executor.dropFailuresRemaining = 1;

    await expect(service.dispose()).rejects.toThrow('The data engine could not complete the operation.');

    expect(executor.disposeCalled).toBe(true);
    error.mockRestore();
  });

  it('does not publish an invalid projection after a source disappears', async () => {
    const store = new FakeCsvStore();
    store.workingCsvs.set('a', workingCsv('a', 'a.csv'));
    store.workingCsvs.set('b', workingCsv('b', 'b.csv'));
    const service = createService(store, new ScriptedComparisonExecutor());
    const opened = service.open({ baselineId: 'a', candidateId: 'b' });
    if (opened.status === 'rejected') throw new Error('open rejected');
    service.begin({
      kind: 'apply-key',
      comparisonId: opened.comparison.comparisonId,
      key: ['id'],
    });
    await waitForIdle(service, opened.comparison.comparisonId);
    const events: string[] = [];
    service.subscribe((event) => events.push(event.kind));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    store.workingCsvs.delete('a');

    expect(() => store.change('a')).not.toThrow();

    expect(events).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      `Comparison ${opened.comparison.comparisonId} has an unavailable source projection.`,
    );
    error.mockRestore();
    await service.dispose();
  });

  it('does not disguise a current snapshot read failure as result replacement', async () => {
    const store = new FakeCsvStore();
    store.workingCsvs.set('a', workingCsv('a', 'a.csv'));
    store.workingCsvs.set('b', workingCsv('b', 'b.csv'));
    const executor = new ScriptedComparisonExecutor();
    const service = createService(store, executor);
    const opened = service.open({ baselineId: 'a', candidateId: 'b' });
    if (opened.status === 'rejected') throw new Error('open rejected');
    service.begin({
      kind: 'apply-key',
      comparisonId: opened.comparison.comparisonId,
      key: ['id'],
    });
    const applied = await waitForIdle(service, opened.comparison.comparisonId);
    const resultToken = applied?.applied?.resultToken;
    if (!resultToken) throw new Error('result not applied');
    executor.failWindowReads = true;

    await expect(
      service.getWindow({
        comparisonId: opened.comparison.comparisonId,
        resultToken,
        offset: 0,
        limit: 100,
        rows: 'all',
        columns: 'csv-order',
      }),
    ).rejects.toThrow('The data engine could not complete the operation.');
    await service.dispose();
  });

  it.each(['none', 'cancel', 'source-change'] as const)(
    'preserves validation outcomes when worker cleanup fails with %s during cleanup',
    async (interruption) => {
      const store = new FakeCsvStore();
      store.workingCsvs.set('a', workingCsv('a', 'a.csv'));
      store.workingCsvs.set('b', workingCsv('b', 'b.csv'));
      const executor = new ScriptedComparisonExecutor();
      const service = createService(store, executor);
      const opened = service.open({ baselineId: 'a', candidateId: 'b' });
      if (opened.status === 'rejected') throw new Error('open rejected');
      const comparisonId = opened.comparison.comparisonId;
      const first = service.begin({ kind: 'apply-key', comparisonId, key: ['id'] });
      if (first.status !== 'accepted') throw new Error('begin rejected');
      const applied = await first.completion;
      if (applied.status !== 'applied') throw new Error('result not applied');
      const snapshot = applied.comparison.applied;
      if (!snapshot) throw new Error('snapshot missing');

      const diagnostics: SourceKeyDiagnostics = {
        blankRowCount: 1,
        duplicateGroupCount: 1,
        blankExamples: [{ rowId: '1', keyValues: [null] }],
        duplicateExamples: [{ keyValues: ['active'], rowCount: 2, rowIds: ['2', '3'] }],
      };
      const cleanupStarted = Promise.withResolvers<void>();
      const cleanup = Promise.withResolvers<void>();
      const validate = vi.spyOn(executor, 'validateKey').mockResolvedValue(diagnostics);
      const release = vi.spyOn(executor, 'release').mockImplementationOnce(() => {
        cleanupStarted.resolve();
        return cleanup.promise;
      });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const replacement = service.begin({ kind: 'apply-key', comparisonId, key: ['status'] });
        if (replacement.status !== 'accepted') throw new Error('begin rejected');
        await cleanupStarted.promise;
        if (interruption === 'cancel') {
          await service.cancel({ comparisonId, operationId: replacement.operationId });
        } else if (interruption === 'source-change') {
          store.change('a');
        }
        cleanup.reject(new Error('worker close failed'));
        const result = await replacement.completion;
        if (interruption === 'none') {
          expect(result).toMatchObject({
            status: 'invalid-key',
            diagnostics: { key: ['status'], baseline: diagnostics, candidate: diagnostics },
          });
        } else if (interruption === 'cancel') {
          expect(result.status).toBe('cancelled');
        } else {
          expect(result).toMatchObject({ status: 'sources-changed', changedSides: ['baseline'] });
        }
        expect(service.getState(comparisonId)?.applied?.resultToken).toBe(snapshot.resultToken);
        await expect(service.getWindow({
          comparisonId, resultToken: snapshot.resultToken, offset: 0, limit: 100,
          rows: 'all', columns: 'csv-order',
        })).resolves.toMatchObject({ status: 'ready' });
        expect(errors).toHaveBeenCalled();
      } finally {
        validate.mockRestore();
        release.mockRestore();
        await service.dispose();
        errors.mockRestore();
      }
    },
  );

  it('settles a defect, keeps it observable, and allows a subsequent attempt', async () => {
    const store = new FakeCsvStore();
    store.workingCsvs.set('a', workingCsv('a', 'a.csv'));
    store.workingCsvs.set('b', workingCsv('b', 'b.csv'));
    const executor = new ScriptedComparisonExecutor();
    const defect = new Error('unexpected activation defect');
    const activate = vi.spyOn(executor, 'activateSnapshot').mockImplementationOnce(() => {
      throw defect;
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = createService(store, executor);
    const opened = service.open({ baselineId: 'a', candidateId: 'b' });
    if (opened.status === 'rejected') throw new Error('open rejected');
    const request = { kind: 'apply-key' as const, comparisonId: opened.comparison.comparisonId, key: ['id'] };
    const begun = service.begin(request);
    if (begun.status !== 'accepted') throw new Error('begin rejected');
    await expect(begun.completion).resolves.toMatchObject({ status: 'failed', failure: { code: 'query-failed' } });
    expect(errors).toHaveBeenCalled();
    expect(executor.droppedArtifacts).toContain(begun.operationId);
    const retry = service.begin(request);
    if (retry.status !== 'accepted') throw new Error('retry rejected');
    await expect(retry.completion).resolves.toMatchObject({ status: 'applied' });
    await service.dispose();
    activate.mockRestore();
    errors.mockRestore();
  });

  it('shares reentrant closure and rejects new work from the settlement subscriber', async () => {
    const store = new FakeCsvStore();
    store.workingCsvs.set('a', workingCsv('a', 'a.csv'));
    store.workingCsvs.set('b', workingCsv('b', 'b.csv'));
    const service = createService(store, new ScriptedComparisonExecutor());
    const opened = service.open({ baselineId: 'a', candidateId: 'b' });
    if (opened.status === 'rejected') throw new Error('open rejected');
    const request = { kind: 'apply-key' as const, comparisonId: opened.comparison.comparisonId, key: ['id'] };
    const events: string[] = [];
    const rejectedAttempts: ReturnType<ReturnType<typeof createService>['begin']>[] = [];
    const closes: Promise<CloseComparisonResult>[] = [];
    service.subscribe((event) => {
      events.push(event.kind);
      if (event.kind !== 'changed') return;
      if (event.comparison.operation) {
        closes.push(service.close(request.comparisonId), service.close(request.comparisonId));
      } else {
        rejectedAttempts.push(service.begin(request));
      }
    });
    const begun = service.begin(request);
    if (begun.status !== 'accepted') throw new Error('begin rejected');
    await begun.completion;
    await expect(Promise.all(closes)).resolves.toEqual([
      { status: 'closed', comparisonId: request.comparisonId },
      { status: 'closed', comparisonId: request.comparisonId },
    ]);
    expect(rejectedAttempts).toMatchObject([
      { status: 'rejected', fault: { code: 'comparison-not-found' } },
    ]);
    expect(events).toEqual(['changed', 'changed', 'closed']);
    expect(service.getState(request.comparisonId)).toBeNull();
    await service.dispose();
  });
});
