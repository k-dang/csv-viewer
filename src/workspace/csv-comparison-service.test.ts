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
import type { CsvWorkspace } from './csv-workspace';
import {
  workspaceContractFactories,
  type WorkspaceContractFixture,
} from '../main/testing/workspace-contract-fixture';

function workingCsv(
  workingCsvId: string,
  name: string,
  columns = ['id', 'name', 'status'],
): WorkingCsvView {
  return {
    workingCsvId,
    dataRevision: 0,
    file: { sourceId: workingCsvId, location: `C:/fixtures/${name}`, name, sizeBytes: 10 },
    columns: columns.map((column) => ({ name: column, type: 'VARCHAR' })),
    rowCount: 0,
    dialect: {},
    editState: { workingCsvId, hasUnexportedChanges: false, canUndo: false, canRedo: false },
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
      this.workingCsvs.set(workingCsvId, { ...current, dataRevision: current.dataRevision + 1 });
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
  rows: { changed: 0, baselineOnly: 0, candidateOnly: 0, unchanged: 0, total: 0 },
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
  private readonly snapshotStartWaiters = new Map<string, () => void>();
  private readonly pendingDrops: Array<() => void> = [];
  private readonly pendingReleases: Array<() => void> = [];

  async validateKey(): Promise<SourceKeyDiagnostics> {
    return validDiagnostics;
  }

  async createSnapshot(request: CreateComparisonSnapshotRequest): Promise<ComparisonSummary> {
    if (!this.deferSnapshots) return emptySummary;
    return new Promise((_resolve, reject) => {
      this.pendingSnapshots.set(request.artifactId, reject);
      this.snapshotStartWaiters.get(request.artifactId)?.();
      this.snapshotStartWaiters.delete(request.artifactId);
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

  awaitSnapshotStart(artifactId: string): Promise<void> {
    if (this.pendingSnapshots.has(artifactId)) return Promise.resolve();
    return new Promise((resolve) => this.snapshotStartWaiters.set(artifactId, resolve));
  }

  async dispose(): Promise<void> {
    this.releaseDrops();
    this.releaseWorkers();
    this.disposeCalled = true;
    for (const reject of this.pendingSnapshots.values()) reject(new Error('disposed'));
    this.pendingSnapshots.clear();
  }
}

async function waitForIdle(service: CsvComparisonService, comparisonId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = service.getState(comparisonId);
    if (!state?.operation) return state;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Comparison did not settle.');
}

async function waitForPhase(
  service: CsvComparisonService,
  comparisonId: string,
  phase: 'validating' | 'comparing' | 'summarizing',
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = service.getState(comparisonId);
    if (state?.operation?.phase === phase) return state.operation;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Comparison did not reach ${phase}.`);
}

async function waitForArtifactDrop(
  executor: ScriptedComparisonExecutor,
  artifactId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (executor.droppedArtifacts.includes(artifactId)) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Comparison artifact ${artifactId} was not retired.`);
}

async function waitForReleaseAttemptCount(
  executor: ScriptedComparisonExecutor,
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (executor.releaseAttemptCount >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Comparison worker release attempt count did not reach ${expectedCount}.`);
}

/** Polls the workspace until the Comparison has no operation in flight. */
async function waitForWorkspaceIdle(
  workspace: CsvWorkspace,
  comparisonId: string,
): Promise<ComparisonView> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const comparison = await workspace.getComparisonState(comparisonId);
    if (comparison && !comparison.operation) return comparison;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Comparison did not settle.');
}

function contractIt(
  name: string,
  testCase: (fixture: WorkspaceContractFixture) => Promise<void>,
): void {
  it.each(workspaceContractFactories)(`$name ${name}`, async ({ create }) => {
    const fixture = await create();
    try {
      await testCase(fixture);
    } finally {
      await fixture.dispose();
    }
  });
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
    expect(outcome.status).toBe('applied');
    expect(outcome.comparison.applied?.freshness).toEqual({
      kind: 'outdated',
      changedSides: ['baseline'],
    });
  });

  contractIt(
    'keeps the old result readable while a draft key fails validation, then marks it outdated',
    async (fixture) => {
      const workspace = fixture.workspace;
      const baseline = await fixture.openSource(
        'a.csv',
        'id,name,status\n1,Ada,active\n2,Bob,old\n',
      );
      const candidate = await fixture.openSource(
        'b.csv',
        'id,name,status\n1,Ada,active\n2,Bob,new\n',
      );
      const opened = await workspace.openComparison({
        baselineId: baseline.workingCsvId,
        candidateId: candidate.workingCsvId,
      });
      if (opened.status === 'rejected') throw new Error('open rejected');

      expect(
        (
          await workspace.beginComparison({
            kind: 'apply-key',
            comparisonId: opened.comparison.comparisonId,
            key: ['id'],
          })
        ).status,
      ).toBe('accepted');
      const applied = await waitForWorkspaceIdle(workspace, opened.comparison.comparisonId);
      expect(applied?.applied?.summary.rows).toEqual({
        changed: 1,
        baselineOnly: 0,
        candidateOnly: 0,
        unchanged: 1,
        total: 2,
      });
      const resultToken = applied?.applied?.resultToken;

      await workspace.editCsvCell({
        workingCsvId: baseline.workingCsvId,
        rowId: '2',
        column: 'id',
        value: '1',
      });
      expect(
        (
          await workspace.beginComparison({
            kind: 'apply-key',
            comparisonId: opened.comparison.comparisonId,
            key: ['id'],
          })
        ).status,
      ).toBe('accepted');
      const invalid = await waitForWorkspaceIdle(workspace, opened.comparison.comparisonId);
      expect(invalid.lastAttempt?.status).toBe('invalid-key');
      expect(invalid.applied?.resultToken).toBe(resultToken);

      await expect(
        workspace.getComparisonState(opened.comparison.comparisonId),
      ).resolves.toMatchObject({
        applied: { freshness: { kind: 'outdated', changedSides: ['baseline'] } },
      });
    },
  );

  contractIt(
    'serves bounded presentation windows and invalidates the old token after Swap sides',
    async (fixture) => {
      const workspace = fixture.workspace;
      const baseline = await fixture.openSource(
        'a.csv',
        'id,name,status\n1,Ada,old\n2,Bob,same\n',
      );
      const candidate = await fixture.openSource(
        'b.csv',
        'id,status,name\n1,new,Ada\n3,added,Cat\n',
      );
      const opened = await workspace.openComparison({
        baselineId: baseline.workingCsvId,
        candidateId: candidate.workingCsvId,
      });
      if (opened.status === 'rejected') throw new Error('open rejected');
      await workspace.beginComparison({
        kind: 'apply-key',
        comparisonId: opened.comparison.comparisonId,
        key: ['id'],
      });
      const applied = await waitForWorkspaceIdle(workspace, opened.comparison.comparisonId);
      const token = applied.applied?.resultToken;
      if (!token) throw new Error('result not applied');

      expect(
        await workspace.getComparisonWindow({
          comparisonId: opened.comparison.comparisonId,
          resultToken: token,
          offset: 0,
          limit: 100,
          rows: 'differences',
          columns: 'changed-first',
        }),
      ).toMatchObject({
        status: 'ready',
        window: {
          totalRowCount: 3,
          valueColumns: [
            { name: 'status', changedRowCount: 1 },
            { name: 'name', changedRowCount: 0 },
          ],
        },
      });

      const swapped = await workspace.swapComparison(opened.comparison.comparisonId);
      expect(swapped).toMatchObject({
        status: 'changed',
        comparison: { baseline: { workingCsvId: candidate.workingCsvId } },
      });
      if (swapped.status !== 'changed' || !swapped.comparison.applied) {
        throw new Error('comparison not swapped');
      }
      expect(
        await workspace.getComparisonWindow({
          comparisonId: opened.comparison.comparisonId,
          resultToken: token,
          offset: 0,
          limit: 100,
          rows: 'all',
          columns: 'csv-order',
        }),
      ).toMatchObject({ status: 'result-replaced' });
      expect(
        await workspace.getComparisonWindow({
          comparisonId: opened.comparison.comparisonId,
          resultToken: swapped.comparison.applied.resultToken,
          offset: 0,
          limit: 100,
          rows: 'all',
          columns: 'csv-order',
        }),
      ).toMatchObject({
        status: 'ready',
        window: {
          valueColumns: [
            { name: 'status', changedRowCount: 1 },
            { name: 'name', changedRowCount: 0 },
          ],
        },
      });
    },
  );

  contractIt(
    'awaits active work and emits no changed state after closing a Comparison',
    async (fixture) => {
      const workspace = fixture.workspace;
      const baseline = await fixture.openSource('a.csv', 'id,value\n1,a\n2,b\n');
      const candidate = await fixture.openSource('b.csv', 'id,value\n1,a\n2,c\n');
      const opened = await workspace.openComparison({
        baselineId: baseline.workingCsvId,
        candidateId: candidate.workingCsvId,
      });
      if (opened.status === 'rejected') throw new Error('open rejected');
      const events: string[] = [];
      workspace.onComparisonEvent((event) => events.push(event.kind));

      await workspace.beginComparison({
        kind: 'apply-key',
        comparisonId: opened.comparison.comparisonId,
        key: ['id'],
      });
      await workspace.closeComparison(opened.comparison.comparisonId);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(events.at(-1)).toBe('closed');
      await expect(
        workspace.getComparisonState(opened.comparison.comparisonId),
      ).resolves.toBeNull();
    },
  );

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
    await waitForPhase(service, opened.comparison.comparisonId, 'comparing');
    await executor.awaitSnapshotStart(begun.operationId);
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
    service.begin({ kind: 'apply-key', comparisonId: opened.comparison.comparisonId, key: ['id'] });
    const first = await waitForIdle(service, opened.comparison.comparisonId);
    const firstToken = first?.applied?.resultToken;
    if (!firstToken) throw new Error('result not applied');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    executor.dropFailuresRemaining = 1;

    service.begin({ kind: 'apply-key', comparisonId: opened.comparison.comparisonId, key: ['id'] });
    const replacement = await waitForIdle(service, opened.comparison.comparisonId);

    expect(replacement?.lastAttempt?.status).toBe('applied');
    expect(replacement?.applied?.resultToken).not.toBe(firstToken);
    expect(executor.droppedArtifacts).toContain(firstToken);

    service.begin({ kind: 'refresh', comparisonId: opened.comparison.comparisonId });
    await waitForIdle(service, opened.comparison.comparisonId);
    expect(executor.droppedArtifacts.filter((artifactId) => artifactId === firstToken)).toHaveLength(
      2,
    );
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
    service.begin({ kind: 'apply-key', comparisonId: opened.comparison.comparisonId, key: ['id'] });
    const first = await waitForIdle(service, opened.comparison.comparisonId);
    const firstToken = first?.applied?.resultToken;
    if (!firstToken) throw new Error('result not applied');
    executor.deferDrops = true;
    executor.deferReleases = true;
    const releaseAttemptCountBeforeRefresh = executor.releaseAttemptCount;

    service.begin({ kind: 'refresh', comparisonId: opened.comparison.comparisonId });
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
    expect(service.getState(opened.comparison.comparisonId)?.operation?.phase).toBe(
      'summarizing',
    );
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
    service.begin({ kind: 'apply-key', comparisonId: opened.comparison.comparisonId, key: ['id'] });
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
    service.begin({ kind: 'apply-key', comparisonId: opened.comparison.comparisonId, key: ['id'] });
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
    service.begin({ kind: 'apply-key', comparisonId: opened.comparison.comparisonId, key: ['id'] });
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
