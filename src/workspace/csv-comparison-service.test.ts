import { describe, expect, it, vi } from 'vitest';
import type {
  ComparisonOperationId,
  ComparisonSummary,
  WorkingCsvView,
  SourceKeyDiagnostics,
} from '../shared/csv-viewer-contract';
import { CsvComparisonService } from './csv-comparison-service';
import type {
  ComparisonExecutor,
  CreateComparisonSnapshotRequest,
  ReadComparisonSnapshotWindowRequest,
  StoredComparisonWindow,
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

  async readWindow(_request: ReadComparisonSnapshotWindowRequest): Promise<StoredComparisonWindow> {
    if (this.failWindowReads) throw new Error('scripted read failure');
    return { totalRowCount: 0, rows: [] };
  }

  async dropSnapshot(artifactId: string): Promise<void> {
    this.droppedArtifacts.push(artifactId);
    if (this.deferDrops) {
      await new Promise<void>((resolve) => this.pendingDrops.push(resolve));
    }
    if (this.dropFailuresRemaining > 0) {
      this.dropFailuresRemaining -= 1;
      throw new Error('scripted drop failure');
    }
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

  async dispose(): Promise<void> {
    this.releaseDrops();
    this.releaseWorkers();
    this.disposeCalled = true;
    for (const reject of this.pendingSnapshots.values()) reject(new Error('disposed'));
    this.pendingSnapshots.clear();
  }
}

const settles = { interval: 1 };

function waitForIdle(service: CsvComparisonService, comparisonId: string) {
  return vi.waitUntil(() => {
    const state = service.getState(comparisonId);
    return state && !state.operation ? state : false;
  }, settles);
}

function waitForPhase(
  service: CsvComparisonService,
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
    const service = new CsvComparisonService(store, new ScriptedComparisonExecutor());

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
    const service = new CsvComparisonService(store, new ScriptedComparisonExecutor());

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
    const service = new CsvComparisonService(store, new ScriptedComparisonExecutor());
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
    const service = new CsvComparisonService(store, executor);
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
    const service = new CsvComparisonService(store, new ScriptedComparisonExecutor());
    const opened = service.open({ baselineId: 'a', candidateId: 'b' });
    if (opened.status === 'rejected') throw new Error('open rejected');
    let close: Promise<Awaited<ReturnType<CsvComparisonService['close']>>> | null = null;
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
    const service = new CsvComparisonService(store, executor);
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
    await service.dispose();
  });

  it('keeps the published replacement when retiring the prior snapshot fails', async () => {
    const store = new FakeCsvStore();
    store.workingCsvs.set('a', workingCsv('a', 'a.csv'));
    store.workingCsvs.set('b', workingCsv('b', 'b.csv'));
    const executor = new ScriptedComparisonExecutor();
    const service = new CsvComparisonService(store, executor);
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
    const service = new CsvComparisonService(store, executor);
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
    const service = new CsvComparisonService(store, executor);
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

    await expect(service.dispose()).rejects.toThrow('Unable to dispose all Comparison resources');

    expect(executor.disposeCalled).toBe(true);
    error.mockRestore();
  });

  it('does not publish an invalid projection after a source disappears', async () => {
    const store = new FakeCsvStore();
    store.workingCsvs.set('a', workingCsv('a', 'a.csv'));
    store.workingCsvs.set('b', workingCsv('b', 'b.csv'));
    const service = new CsvComparisonService(store, new ScriptedComparisonExecutor());
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
    const service = new CsvComparisonService(store, executor);
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
    ).rejects.toThrow('scripted read failure');
    await service.dispose();
  });
});
