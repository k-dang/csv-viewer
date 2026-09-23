import { Effect, Logger } from 'effect';
import { describe, expect, it } from 'vitest';
import { DuckDbComparisonExecutor } from '../../src/comparison/duckdb-comparison-executor';
import type { WorkspaceDatabaseConnection } from '../../src/database';
import { DataEngineError } from '../../src/database';
import { cleanupEffect } from '../../src/comparison/comparison-effects';
import type { ComparisonExecutor } from '../../src/comparison/comparison-executor';
import type { ComparisonSummary } from '../../src/csv-viewer';
import type { WorkspaceContractFixture } from './workspace-contract';
import type { WorkspaceContractFactory } from './workspace-contract';

export function defineDiagnosticsContract(factory: WorkspaceContractFactory): void {
  describe(`${factory.name} diagnostics`, () => {
    it('completes comparison and disposal when diagnostic output throws', async () => {
      const fixture = await factory.create(undefined, { logger: Logger.make(() => { throw new Error('PRIVATE output failure'); }) });
      try {
        const { comparisonId } = await prepareComparison(fixture);
        const started = await fixture.viewer.call({ operation: 'comparison.begin', comparisonId, kind: 'apply-key', key: ['id'] });
        if (started.status !== 'accepted') throw new Error('Not accepted');
        expect((await fixture.awaitComparisonOutcome(started.operationId)).status).toBe('applied');
        await fixture.disposeWorkspace();
      } finally { await fixture.dispose(); }
    });

    it('reports deferred table cleanup without changing key validation or retrying a released lease', async () => {
      const capture = diagnosticCapture();
      const fixture = await factory.create(deferredCleanupExecutor(), capture.configuration);
      try {
        const { comparisonId } = await prepareComparison(fixture);
        const started = await fixture.viewer.call({ operation: 'comparison.begin', comparisonId, kind: 'apply-key', key: ['id'] });
        if (started.status !== 'accepted') throw new Error('Not accepted');
        expect((await fixture.awaitComparisonOutcome(started.operationId)).status).toBe('invalid-key');
        await fixture.disposeWorkspace();
        const computation = capture.completed().find((span) => span.message === 'comparison.compute');
        expect(computation?.annotations.outcome).toBe('invalid-key');
        expect(computation?.annotations.cleanup).toBe('cleanup-failed');
        const failedRelease = capture.completed().find((span) => span.message === 'comparison.release-source' && span.annotations.outcome === 'cleanup-failed');
        expect(failedRelease?.annotations.operationId).toBe(started.operationId);
        expect(failedRelease?.annotations.failureCategory).toBe('recoverable-failure');
        expect(capture.completed().filter((span) => span.message === 'comparison.release-source')).toHaveLength(2);
        expect(capture.logs.join('')).not.toContain('PRIVATE');
      } finally { await fixture.dispose(); }
    });

    it('associates retried worker and source cleanup with the failed Comparison', async () => {
      const capture = diagnosticCapture();
      const fixture = await factory.create(retryCleanupExecutor(), capture.configuration);
      try {
        const { comparisonId } = await prepareComparison(fixture);
        const started = await fixture.viewer.call({ operation: 'comparison.begin', comparisonId, kind: 'apply-key', key: ['id'] });
        if (started.status !== 'accepted') throw new Error('Not accepted');
        expect((await fixture.awaitComparisonOutcome(started.operationId)).status).toBe('failed');
        await fixture.disposeWorkspace();
        const computation = capture.completed().find((span) => span.message === 'comparison.compute');
        expect(computation?.annotations.recoverableFailure).toBe(true);
        expect(computation?.annotations.cleanup).toBe('cleanup-failed');
        for (const stage of ['comparison.release-source', 'comparison.release-worker']) {
          const releases = capture.completed().filter((span) => span.message === stage);
          expect(releases.map((span) => span.annotations.outcome)).toEqual(['cleanup-failed', 'succeeded']);
          for (const release of releases) {
            expect(release.annotations.operationId).toBe(started.operationId);
            expect(release.annotations.requestId).toBe(computation?.annotations.requestId);
            expect(release.spans).toHaveProperty('comparison.compute');
          }
        }
        expect(capture.logs.join('')).not.toContain('PRIVATE');
      } finally { await fixture.dispose(); }
    });

    it.each(['invalid-key', 'recoverable-failure', 'defect', 'cleanup-failed'] as const)('classifies %s without exposing driver causes', async (outcome) => {
      const capture = diagnosticCapture();
      const executor = outcome === 'invalid-key' ? undefined : failingExecutor(outcome);
      const fixture = await factory.create(executor, capture.configuration);
      try {
        const { comparisonId } = await prepareComparison(fixture, '1,PRIVATE-CELL\n1,duplicate');
        const started = await fixture.viewer.call({ operation: 'comparison.begin', kind: 'apply-key', comparisonId, key: ['id'] });
        if (started.status !== 'accepted') throw new Error('Not accepted');
        expect((await fixture.awaitComparisonOutcome(started.operationId)).status).toBe(outcome === 'invalid-key' ? 'invalid-key' : 'failed');
        await fixture.disposeWorkspace();
        const computation = capture.completed().find((span) => span.message === 'comparison.compute');
        expect(computation?.annotations.outcome).toBe(outcome === 'invalid-key' ? 'invalid-key' : 'failed');
        expect(computation?.annotations.outcome).not.toBe('succeeded');
        if (outcome !== 'invalid-key') expect(computation?.annotations.failureCategory).toBe(outcome);
        if (outcome === 'cleanup-failed') {
          expect(computation?.annotations.recoverableFailure).toBe(true);
          expect(computation?.annotations.cleanup).toBe('cleanup-failed');
        }
        expect(capture.logs.join('')).not.toContain('PRIVATE');
        expect(capture.logs.join('')).toContain(started.operationId);
      } finally { await fixture.dispose(); }
    });

    it.each(['cancel', 'source-change', 'dispose'] as const)('retains the initiating context through %s and cleanup', async (action) => {
      const capture = diagnosticCapture();
      const entered = Promise.withResolvers<void>();
      const executor = failingExecutor('pending', entered.resolve);
      const fixture = await factory.create(executor, capture.configuration);
      try {
        const { comparisonId, baselineId } = await prepareComparison(fixture);
        const started = await fixture.viewer.call({ operation: 'comparison.begin', kind: 'apply-key', comparisonId, key: ['id'] });
        if (started.status !== 'accepted') throw new Error('Not accepted');
        await entered.promise;
        if (action === 'cancel') await fixture.viewer.call({ operation: 'comparison.cancel', comparisonId, operationId: started.operationId });
        else if (action === 'dispose') await fixture.disposeWorkspace();
        else await fixture.viewer.call({ operation: 'csv.reopen', workingCsvId: baselineId });
        expect((await fixture.awaitComparisonOutcome(started.operationId)).status).toBe(action === 'source-change' ? 'sources-changed' : 'cancelled');
        await fixture.disposeWorkspace();
        const request = capture.completed().find((span) => span.message === 'comparison.begin');
        const computation = capture.completed().find((span) => span.message === 'comparison.compute');
        expect(computation?.annotations.requestId).toBe(request?.annotations.requestId);
        expect(computation?.annotations.operationId).toBe(started.operationId);
        expect(computation?.annotations.interrupted).toBe(true);
        expect(computation?.annotations.cleanup).toBe('succeeded');
        const snapshot = capture.completed().find((span) => span.message === 'comparison.snapshot');
        expect(snapshot?.spans).toHaveProperty('comparison.compute');
        expect(snapshot?.annotations.outcome).toBe('interrupted');
        expect(capture.records.filter((record) => record.annotations.outcome === 'started').map((record) => record.message).sort())
          .toEqual(capture.completed().map((record) => record.message).sort());
        expect(capture.logs.join('')).not.toContain('PRIVATE');
      } finally { await fixture.dispose(); }
    });

    it('correlates background computation, resource release and disposal without source data', async () => {
      const capture = diagnosticCapture();
      const fixture = await factory.create(undefined, capture.configuration);
      try {
        const baseline = await fixture.openSource('PRIVATE-SOURCE.csv', 'id,value\n1,PRIVATE-CELL\n');
        const candidate = await fixture.openSource('PRIVATE-CANDIDATE.csv', 'id,value\n1,changed\n');
        const opened = await fixture.viewer.call({ operation: 'comparison.open', baselineId: baseline.workingCsvId, candidateId: candidate.workingCsvId });
        if (opened.status === 'rejected') throw new Error('Comparison rejected');
        const started = await fixture.viewer.call({ operation: 'comparison.begin', comparisonId: opened.comparison.comparisonId, kind: 'apply-key', key: ['id'] });
        if (started.status !== 'accepted') throw new Error('Comparison not accepted');
        expect((await fixture.awaitComparisonOutcome(started.operationId)).status).toBe('applied');
        const refreshed = await fixture.viewer.call({ operation: 'comparison.begin', comparisonId: opened.comparison.comparisonId, kind: 'refresh' });
        if (refreshed.status !== 'accepted') throw new Error('Refresh not accepted');
        expect((await fixture.awaitComparisonOutcome(refreshed.operationId)).status).toBe('applied');
        await fixture.disposeWorkspace();
        const records = capture.completed();
        for (const release of records.filter((span) => span.message === 'comparison.release-snapshot')) {
          const original = records.find((span) => span.message === 'comparison.compute' && span.annotations.operationId === release.annotations.operationId);
          expect(release.annotations.requestId).toBe(original?.annotations.requestId);
          expect(release.spans).toHaveProperty('comparison.snapshot');
        }
        expect(records.filter((span) => span.message === 'comparison.release-snapshot')).toHaveLength(2);
        const computation = records.find((span) => span.message === 'comparison.compute');
        if (!computation) throw new Error('Computation span missing');
        expect(computation.annotations.operationId).toBe(started.operationId);
        expect(computation.annotations.comparisonId).toBe(opened.comparison.comparisonId);
        expect(computation.annotations.baselineId).toBe(baseline.workingCsvId);
        expect(computation.annotations.outcome).toBe('applied');
        const request = records.find((span) => span.message === 'comparison.begin');
        expect(computation.spans).toHaveProperty('comparison.begin');
        expect(computation.annotations.requestId).toBe(request?.annotations.requestId);
        expect(records.filter((span) => span.message === 'comparison.validate-key')).toHaveLength(4);
        expect(records.some((span) => span.message === 'comparison.snapshot')).toBe(true);
        expect(records.some((span) => span.message === 'comparison.release-worker')).toBe(true);
        expect(records.find((span) => span.message === 'workspace.dispose')?.annotations.outcome).toBe('succeeded');
        for (const record of records) expect(record.spans[String(record.message)]).toBeGreaterThanOrEqual(0);
        const captured = capture.logs.join('');
        for (const secret of ['PRIVATE-SOURCE', 'PRIVATE-CANDIDATE', 'PRIVATE-CELL', baseline.source.location]) expect(captured).not.toContain(secret);
      } finally { await fixture.dispose(); }
    });
  });
}

function diagnosticCapture() {
  const logs: string[] = [];
  const records: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
  return {
    logs, records,
    configuration: { logger: Logger.make((options) => {
      logs.push(Logger.formatLogFmt.log(options));
      records.push(Logger.formatStructured.log(options));
    }) },
    completed: () => records.filter((record) => record.annotations.outcome !== 'started'),
  };
}

async function prepareComparison(fixture: WorkspaceContractFixture, rows = '1,PRIVATE-CELL') {
  const baseline = await fixture.openSource('PRIVATE-SOURCE.csv', `id,value\n${rows}\n`);
  const candidate = await fixture.openSource('PRIVATE-CANDIDATE.csv', 'id,value\n1,other\n');
  const opened = await fixture.viewer.call({ operation: 'comparison.open', baselineId: baseline.workingCsvId, candidateId: candidate.workingCsvId });
  if (opened.status === 'rejected') throw new Error('Comparison rejected');
  return { comparisonId: opened.comparison.comparisonId, baselineId: baseline.workingCsvId };
}

/** Controlled engine boundary for deterministic query failure and interruption. */
function failingExecutor(mode: 'recoverable-failure' | 'defect' | 'cleanup-failed' | 'pending', entered: () => void = () => undefined): ComparisonExecutor {
  const driverError = new Error('SELECT PRIVATE-COLUMN FROM PRIVATE-SOURCE.csv: PRIVATE-CELL', { cause: new Error('C:/PRIVATE/location.csv') });
  const snapshot: Effect.Effect<ComparisonSummary, DataEngineError> = mode === 'pending' ? Effect.never
    : mode === 'defect' ? Effect.die(driverError) : Effect.fail(new DataEngineError(driverError));
  return {
    openAttempt: () => Effect.acquireRelease(Effect.succeed({
      validateKey: () => Effect.succeed({ blankRowCount: 0, duplicateGroupCount: 0, blankExamples: [], duplicateExamples: [] }),
      createSnapshot: () => Effect.sync(entered).pipe(Effect.andThen(snapshot)),
    }), () => cleanupEffect(async () => { if (mode === 'cleanup-failed') throw driverError; })),
    activateSnapshot: () => undefined,
    readWindow: () => Effect.succeed({ totalRowCount: 0, rows: [] }),
    dropSnapshot: () => Effect.void,
    dispose: () => Effect.void,
  };
}


function retryCleanupExecutor(): ComparisonExecutor {
  const secret = new Error('PRIVATE driver failure');
  let closeFails = true;
  let sourceReleaseFails = true;
  const connection: WorkspaceDatabaseConnection = {
    run: async () => undefined,
    readObjects: async () => [],
    runCancellable: async () => undefined,
    readObjectsCancellable: async () => { throw secret; },
    cancelRunning: async () => undefined,
    close: async () => {
      if (closeFails) { closeFails = false; throw secret; }
    },
  };
  return new DuckDbComparisonExecutor({
    connectWorker: async () => connection,
    getOwnerConnection: async () => connection,
    acquireSource: async () => ({
      tableName: 'PRIVATE-table', columns: [{ name: 'id', type: 'VARCHAR' }],
      release: async () => {
        if (sourceReleaseFails) { sourceReleaseFails = false; throw secret; }
      },
    }),
  });
}

function deferredCleanupExecutor(): ComparisonExecutor {
  const responses = [[{ count: 1 }], [], [{ count: 0 }], [], [{ count: 0 }], [], [{ count: 0 }], []];
  const connection: WorkspaceDatabaseConnection = {
    run: async () => undefined,
    readObjects: async () => [],
    runCancellable: async () => undefined,
    readObjectsCancellable: async () => responses.shift() ?? [],
    cancelRunning: async () => undefined,
    close: async () => undefined,
  };
  let cleanupFailed = false;
  return new DuckDbComparisonExecutor({
    connectWorker: async () => connection,
    getOwnerConnection: async () => connection,
    acquireSource: async () => ({
      tableName: 'PRIVATE-table', columns: [{ name: 'id', type: 'VARCHAR' }],
      release: async () => {
        if (!cleanupFailed) {
          cleanupFailed = true;
          return new DataEngineError(new Error('PRIVATE retired table SQL'));
        }
      },
    }),
  });
}
