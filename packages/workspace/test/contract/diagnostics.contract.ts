import { Effect, Logger } from 'effect';
import { describe, expect, it } from 'vitest';
import { DuckDbComparisonExecutor } from '../../src/comparison/duckdb-comparison-executor';
import { DataEngineError } from '../../src/database';
import { cleanupEffect } from '../../src/comparison/comparison-effects';
import type { ComparisonExecutor } from '../../src/comparison/comparison-executor';
import type { ComparisonSummary } from '../../src/csv-viewer';
import type { WorkspaceContractFixture } from './workspace-contract';
import type { WorkspaceContractFactory } from './workspace-contract';
import { diagnosticCapture } from '../diagnostic-capture';
import { stubConnection } from '../stub-connection';

export function defineDiagnosticsContract(factory: WorkspaceContractFactory): void {
  describe(`${factory.name} diagnostics`, () => {
    it.each(['read', 'serialization'] as const)('releases the export worker after a %s failure without marking edits exported', async (failure) => {
      const capture = diagnosticCapture();
      const fixture = await factory.create(undefined, capture.configuration);
      try {
        const { workingCsvId } = await fixture.openSource('export-preparation.csv', 'name\nAda\n');
        await fixture.viewer.call({ operation: 'csv.edit-cell', workingCsvId, rowId: '1', column: 'name', value: 'Grace' });
        const exported = fixture.captureNextExport('exported.csv');
        const released = fixture.failNextExportPreparation(failure);
        await expect(fixture.viewer.call({ operation: 'csv.export', workingCsvId })).rejects.toThrow(
          failure === 'read' ? 'The data engine could not complete the operation.' : 'The CSV workspace could not complete the request.',
        );
        expect(released()).toBe(true);
        expect(await fixture.editState(workingCsvId)).toMatchObject({ hasUnexportedChanges: true, canUndo: true });
        expect(capture.completed().find((record) => record.message === 'csv.export')?.annotations).toMatchObject({
          outcome: 'failed', cleanup: 'succeeded', failureCategory: failure === 'read' ? 'recoverable-failure' : 'defect',
        });
        await expect(fixture.viewer.call({ operation: 'csv.export', workingCsvId })).resolves.toMatchObject({ status: 'exported' });
        expect(await exported()).toBe('name\nGrace\n');
        expect(capture.logs.join('')).not.toContain('PRIVATE');
      } finally { await fixture.dispose(); }
    });

    it('preserves Unexported Changes and reports a failed export worker release', async () => {
      const capture = diagnosticCapture();
      const fixture = await factory.create(undefined, capture.configuration);
      try {
        const { workingCsvId } = await fixture.openSource('export-cleanup.csv', 'name\nAda\n');
        await fixture.viewer.call({ operation: 'csv.edit-cell', workingCsvId, rowId: '1', column: 'name', value: 'Grace' });
        fixture.captureNextExport('exported.csv');
        fixture.failNextExportWorkerRelease();
        await expect(fixture.viewer.call({ operation: 'csv.export', workingCsvId })).rejects.toThrow('The data engine could not complete the operation.');
        expect(await fixture.editState(workingCsvId)).toMatchObject({ hasUnexportedChanges: true, canUndo: true });
        expect(capture.completed().find((record) => record.message === 'csv.export')?.annotations).toMatchObject({ outcome: 'failed', cleanup: 'cleanup-failed', failureCategory: 'recoverable-failure' });
        expect(capture.logs.join('')).not.toContain('PRIVATE');
      } finally { await fixture.dispose(); }
    });

    it('separates expected synchronous and Promise failures from a host defect', async () => {
      const capture = diagnosticCapture();
      const fixture = await factory.create(undefined, capture.configuration);
      try {
        const opened = await fixture.openSource('PRIVATE-failure.csv', 'name\nAda\n');
        const missingId = crypto.randomUUID();
        await expect(fixture.viewer.call({ operation: 'csv.get-edit-state', workingCsvId: missingId }))
          .rejects.toThrow(/^Working CSV is no longer active\.$/);
        await expect(fixture.viewer.call({
          operation: 'csv.rename-column', workingCsvId: opened.workingCsvId, column: 'name', name: ' ',
        })).rejects.toThrow(/^CSV column name cannot be blank\.$/);
        fixture.failNextRecentSources();
        await expect(fixture.viewer.call({ operation: 'csv.get-recent-sources' }))
          .rejects.toThrow(/^The CSV workspace could not complete the request\.$/);

        const records = capture.completed();
        for (const operation of ['csv.get-edit-state', 'csv.rename-column']) {
          expect(records.find((record) => record.message === operation)?.annotations.failureCategory)
            .toBe('recoverable-failure');
        }
        expect(records.find((record) => record.message === 'csv.get-recent-sources')?.annotations.failureCategory)
          .toBe('defect');
        expect(capture.logs.join('')).not.toContain('PRIVATE');
        expect(capture.logs.join('')).not.toContain('SELECT * FROM secrets');
      } finally { await fixture.dispose(); }
    });

    it('records malformed requests under one fixed stage without request content', async () => {
      const capture = diagnosticCapture();
      const fixture = await factory.create(undefined, capture.configuration);
      const acquired = capture.records.length;
      try {
        const workingCsvId = crypto.randomUUID();
        const malformed = [
          { operation: 'PRIVATE-OPERATION', workingCsvId, value: 'PRIVATE-VALUE' },
          { operation: 'csv.edit-cell', workingCsvId, rowId: 'PRIVATE-ROW', column: 'PRIVATE-COLUMN', value: 42 },
        ];
        for (const request of malformed) {
          // SAFETY: Each payload is deliberately outside the public request union.
          await expect(fixture.viewer.call(request as never)).rejects.toThrow(/^Malformed CSV Viewer request\.$/);
        }

        const records = capture.completed(acquired);
        expect(records.map((record) => [record.message, record.annotations.outcome])).toEqual([
          ['csv-viewer.request', 'malformed-request'],
          ['csv-viewer.request', 'malformed-request'],
        ]);
        for (const record of records) expect(record.annotations).not.toHaveProperty('workingCsvId');
        for (const secret of ['PRIVATE', workingCsvId, 'csv.edit-cell']) expect(capture.logs.join('')).not.toContain(secret);
      } finally { await fixture.dispose(); }
    });

    it('reports unexpected source-description failures as defects during open and reopen', async () => {
      const capture = diagnosticCapture();
      const fixture = await factory.create(undefined, capture.configuration);
      try {
        const sourceId = await fixture.registerSource('PRIVATE-open.csv', 'name\nAda\n');
        fixture.failNextDescribeSource();
        await expect(fixture.viewer.call({ operation: 'csv.open-recent', sourceId }))
          .rejects.toThrow(/^The CSV workspace could not complete the request\.$/);

        const opened = await fixture.viewer.call({ operation: 'csv.open-recent', sourceId });
        if (opened.status !== 'opened') throw new Error(`Open was ${opened.status}.`);
        fixture.failNextDescribeSource();
        await expect(fixture.viewer.call({
          operation: 'csv.reopen', workingCsvId: opened.workingCsv.workingCsvId,
        })).rejects.toThrow(/^The CSV workspace could not complete the request\.$/);

        const records = capture.completed();
        for (const operation of ['csv.open-recent', 'csv.reopen']) {
          expect(records.find((record) => record.message === operation && record.annotations.failureCategory === 'defect')
            ?.annotations.outcome).toBe('failed');
        }
        expect(capture.logs.join('')).not.toContain('PRIVATE');
        expect(capture.logs.join('')).not.toContain('SELECT * FROM secrets');
      } finally { await fixture.dispose(); }
    });

    it('traces CSV open, reopen, staged cleanup, and product outcomes without source data', async () => {
      const capture = diagnosticCapture();
      const fixture = await factory.create(undefined, capture.configuration);
      try {
        const sourceId = await fixture.registerSource('PRIVATE-SOURCE.csv', 'name\nPRIVATE-CELL\n');
        const opened = await fixture.viewer.call({ operation: 'csv.open-recent', sourceId });
        if (opened.status !== 'opened') throw new Error(`Open was ${opened.status}.`);
        await expect(fixture.viewer.call({
          operation: 'csv.reopen', workingCsvId: opened.workingCsv.workingCsvId, options: { delimiter: '||' },
        })).resolves.toMatchObject({ status: 'failed' });
        fixture.failNextTableDrop();
        await expect(fixture.viewer.call({ operation: 'csv.reopen', workingCsvId: opened.workingCsv.workingCsvId }))
          .resolves.toMatchObject({ status: 'opened' });
        const partialSourceId = await fixture.registerSource('PRIVATE-PARTIAL.csv', 'name\nPRIVATE-CELL\n');
        fixture.failNextMetadataRead();
        fixture.failNextTableDrop();
        await expect(fixture.viewer.call({ operation: 'csv.open-recent', sourceId: partialSourceId }))
          .resolves.toMatchObject({ status: 'failed' });
        await fixture.disposeWorkspace();
        const records = capture.completed();
        const successfulOpen = records.find((record) => record.message === 'csv.open-recent' && record.annotations.outcome === 'opened');
        const failedOpen = records.find((record) => record.message === 'csv.open-recent' && record.annotations.outcome === 'failed');
        const failedReopen = records.find((record) => record.message === 'csv.reopen' && record.annotations.outcome === 'failed');
        const committedReopen = records.find((record) => record.message === 'csv.reopen' && record.annotations.outcome === 'opened');
        expect(successfulOpen?.annotations.cleanup).toBe('succeeded');
        expect(failedOpen?.annotations.cleanup).toBe('cleanup-failed');
        expect(failedOpen?.annotations.failureCategory).toBe('recoverable-failure');
        expect(failedOpen?.annotations.csvFailureCategory).toBe('engine');
        expect(failedReopen?.annotations.failureCategory).toBe('recoverable-failure');
        expect(failedReopen?.annotations.csvFailureCategory).toBe('dialect');
        expect(failedReopen?.annotations.workingCsvId).toBe(opened.workingCsv.workingCsvId);
        expect(committedReopen?.annotations.cleanup).toBe('cleanup-failed');
        const retirement = records.find((record) => record.message === 'csv.release-retired' && record.annotations.requestId === committedReopen?.annotations.requestId);
        expect(retirement?.annotations.outcome).toBe('cleanup-failed');
        expect(retirement?.spans).toHaveProperty('csv.reopen');
        for (const stage of ['csv.describe-source', 'csv.prepare-table', 'csv.access-and-load', 'csv.read-metadata', 'csv.release-staging']) {
          const record = records.find((entry) => entry.message === stage && entry.annotations.requestId === failedOpen?.annotations.requestId);
          expect(record?.spans).toHaveProperty('csv.open-recent');
        }
        const release = records.find((record) => record.message === 'csv.release-staging' && record.annotations.requestId === failedOpen?.annotations.requestId);
        expect(release?.annotations.cleanup).toBe('cleanup-failed');
        expect(capture.logs.join('')).not.toContain('PRIVATE');
      } finally { await fixture.dispose(); }
    });

    it('reports a retired-table deletion failure after an admitted reader finishes', async () => {
      const capture = diagnosticCapture();
      const fixture = await factory.create(undefined, capture.configuration);
      try {
        const original = await fixture.openSource('PRIVATE-reader.csv', 'name\nAda\n');
        const hold = fixture.holdNextRowRead();
        const reading = fixture.viewer.call({ operation: 'csv.get-rows', workingCsvId: original.workingCsvId, offset: 0, limit: 10 });
        await hold.entered;
        try {
          await fixture.writeSource('PRIVATE-reader.csv', 'name\nGrace\n');
          await expect(fixture.viewer.call({ operation: 'csv.reopen', workingCsvId: original.workingCsvId }))
            .resolves.toMatchObject({ status: 'opened' });
          fixture.failNextTableDrop();
        } finally {
          hold.release();
        }
        await expect(reading).resolves.toMatchObject({ rows: expect.arrayContaining([expect.objectContaining({ name: 'Ada' })]) });
        const release = capture.completed().find((record) => record.message === 'csv.release-retired' && record.annotations.outcome === 'cleanup-failed');
        expect(release?.annotations.workingCsvId).toBe(original.workingCsvId);
        expect(release?.spans).toHaveProperty('csv.get-rows');
        const read = capture.completed().find((record) => record.message === 'csv.get-rows' && record.annotations.requestId === release?.annotations.requestId);
        expect(read?.annotations).toMatchObject({ outcome: 'succeeded', cleanup: 'cleanup-failed' });
        expect(capture.logs.join('')).not.toContain('PRIVATE');
        await fixture.disposeWorkspace();
      } finally { await fixture.dispose(); }
    });

    it('correlates Working CSV reads, edits, export, and close without cell data', async () => {
      const reopenReserved = Promise.withResolvers<void>();
      const capture = diagnosticCapture((record) => {
        if (record.message === 'csv.queue-wait' && record.annotations.outcome === 'started' && record.spans['csv.reopen'] !== undefined) {
          reopenReserved.resolve();
        }
      });
      const fixture = await factory.create(undefined, capture.configuration);
      try {
        const original = await fixture.openSource('PRIVATE-EDITS.csv', 'PRIVATE-COLUMN\nPRIVATE-CELL\n');
        const workingCsvId = original.workingCsvId;
        const request = { workingCsvId, rowId: '1', column: 'PRIVATE-COLUMN' };
        await fixture.viewer.call({ operation: 'csv.get-rows', workingCsvId, offset: 0, limit: 10, search: 'PRIVATE-SEARCH' });
        await fixture.writeSource('PRIVATE-EDITS.csv', 'PRIVATE-COLUMN\nPRIVATE-RELOADED\n');
        const reopening = fixture.viewer.call({ operation: 'csv.reopen', workingCsvId });
        await reopenReserved.promise;
        const queuedEdit = fixture.viewer.call({ operation: 'csv.edit-cell', ...request, value: 'PRIVATE-EDIT' });
        await expect(fixture.viewer.call({ operation: 'csv.edit-cell', ...request, column: 'PRIVATE-MISSING', value: 'PRIVATE-EDIT' }))
          .rejects.toThrow('Unknown CSV column');
        await Promise.all([reopening, queuedEdit]);
        await fixture.viewer.call({ operation: 'csv.undo', workingCsvId });
        fixture.captureNextExport('PRIVATE-EXPORT.csv');
        await expect(fixture.viewer.call({ operation: 'csv.export', workingCsvId })).resolves.toMatchObject({ status: 'exported' });
        await expect(fixture.viewer.call({ operation: 'csv.close', workingCsvId })).resolves.toMatchObject({ status: 'closed' });

        const records = capture.completed();
        const requests = records.filter((record) => record.annotations.workingCsvId === workingCsvId && record.spans[String(record.message)] !== undefined && Object.keys(record.spans).length === 1);
        // The queued edits can complete before the reopen request records its Recent CSV Source.
        const summary = requests.map((record) => [record.message, record.annotations.outcome]);
        expect(summary[0]).toEqual(['csv.get-rows', 'succeeded']);
        expect(summary.slice(1, 4)).toEqual(expect.arrayContaining([
          ['csv.reopen', 'opened'],
          ['csv.edit-cell', 'succeeded'],
          ['csv.edit-cell', 'failed'],
        ]));
        expect(summary.slice(4)).toEqual([
          ['csv.undo', 'succeeded'],
          ['csv.export', 'exported'],
          ['csv.close', 'closed'],
        ]);
        expect(requests).toHaveLength(7);
        for (const record of requests) {
          expect(record.annotations.workspaceId).toBeDefined();
          expect(record.annotations.cleanup).toBe('succeeded');
        }
        const rejected = requests.find((record) => record.annotations.outcome === 'failed');
        expect(rejected?.annotations.failureCategory).toBe('recoverable-failure');
        const read = requests.find((record) => record.message === 'csv.get-rows');
        const leaseRelease = records.find((record) => record.message === 'csv.release-lease' && record.annotations.requestId === read?.annotations.requestId);
        expect(leaseRelease?.spans).toHaveProperty('csv.get-rows');

        const reopen = requests.find((record) => record.message === 'csv.reopen');
        const edit = requests.find((record) => record.message === 'csv.edit-cell' && record.annotations.outcome === 'succeeded');
        const waited = records.find((record) => record.message === 'csv.queue-wait' && record.annotations.requestId === edit?.annotations.requestId);
        expect(waited?.spans).toHaveProperty('csv.edit-cell');
        expect(records.some((record) => record.message === 'csv.access-and-load' && record.annotations.requestId === reopen?.annotations.requestId)).toBe(true);

        const captured = capture.logs.join('');
        for (const secret of ['PRIVATE', original.source.location]) expect(captured).not.toContain(secret);
        await fixture.disposeWorkspace();
      } finally { await fixture.dispose(); }
    });

    it('reports the existing outcome when opening the same Comparison pair again', async () => {
      const capture = diagnosticCapture();
      const fixture = await factory.create(undefined, capture.configuration);
      try {
        const { comparisonId, baselineId, candidateId } = await prepareComparison(fixture);
        await expect(fixture.viewer.call({ operation: 'comparison.open', baselineId, candidateId }))
          .resolves.toMatchObject({ status: 'existing', comparison: { comparisonId } });
        const opens = capture.completed().filter((record) => record.message === 'comparison.open');
        expect(opens.map((record) => record.annotations.outcome)).toEqual(['created', 'existing']);
      } finally { await fixture.dispose(); }
    });

    it('reports failed snapshot cleanup when closing a Comparison and successful cleanup on retry', async () => {
      const capture = diagnosticCapture();
      const fixture = await factory.create(undefined, capture.configuration);
      try {
        const { comparisonId } = await prepareComparison(fixture);
        const started = await fixture.viewer.call({ operation: 'comparison.begin', comparisonId, kind: 'apply-key', key: ['id'] });
        if (started.status !== 'accepted') throw new Error('Not accepted');
        expect((await fixture.awaitComparisonOutcome(started.operationId)).status).toBe('applied');
        await fixture.failNextSnapshotDrop();
        await expect(fixture.viewer.call({ operation: 'comparison.close', comparisonId }))
          .resolves.toMatchObject({ status: 'failed', failure: { code: 'cleanup-failed' } });
        await expect(fixture.viewer.call({ operation: 'comparison.close', comparisonId }))
          .resolves.toMatchObject({ status: 'closed' });
        const closes = capture.completed().filter((record) => record.message === 'comparison.close');
        expect(closes.map((record) => record.annotations)).toMatchObject([
          { comparisonId, outcome: 'failed', cleanup: 'cleanup-failed', failureCategory: 'recoverable-failure' },
          { comparisonId, outcome: 'closed', cleanup: 'succeeded' },
        ]);
      } finally { await fixture.dispose(); }
    });

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

    it('associates retried worker cleanup with the failed Comparison', async () => {
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
        const releases = capture.completed().filter((span) => span.message === 'comparison.release-worker');
        expect(releases.map((span) => span.annotations.outcome)).toEqual(['cleanup-failed', 'succeeded']);
        for (const release of releases) {
          expect(release.annotations.operationId).toBe(started.operationId);
          expect(release.annotations.requestId).toBe(computation?.annotations.requestId);
          expect(release.spans).toHaveProperty('comparison.compute');
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

    it('correlates database acquisition and release with the workspace', async () => {
      const capture = diagnosticCapture();
      const fixture = await factory.create(undefined, capture.configuration);
      try {
        await fixture.viewer.call({ operation: 'csv.get-recent-sources' });
        await fixture.disposeWorkspace();
        const records = capture.completed();
        const workspaceId = records.find((record) => record.message === 'csv.get-recent-sources')?.annotations.workspaceId;
        expect(workspaceId).toEqual(expect.any(String));
        for (const stage of ['workspace.acquire-database', 'workspace.release-database']) {
          const matching = records.filter((record) => record.message === stage);
          expect(matching.map((record) => [record.annotations.outcome, record.annotations.workspaceId])).toEqual([['succeeded', workspaceId]]);
        }
      } finally { await fixture.dispose(); }
    });

    it('keeps an opened CSV readable when its engine source cannot be released', async () => {
      const capture = diagnosticCapture();
      const fixture = await factory.create(undefined, capture.configuration);
      try {
        const sourceId = await fixture.registerSource('PRIVATE-SOURCE.csv', 'name\nAda\n');
        fixture.failNextEngineSourceRelease();
        const opened = await fixture.viewer.call({ operation: 'csv.open-recent', sourceId });
        if (opened.status !== 'opened') throw new Error(`Open was ${opened.status}.`);
        const rows = await fixture.viewer.call({
          operation: 'csv.get-rows', workingCsvId: opened.workingCsv.workingCsvId, offset: 0, limit: 10,
        });
        expect(rows.rows[0].name).toBe('Ada');

        const records = capture.completed();
        const request = records.find((record) => record.message === 'csv.open-recent' && record.annotations.outcome === 'opened');
        expect(request?.annotations.cleanup).toBe('cleanup-failed');
        expect(records.find((record) => record.message === 'csv.release-engine-source' && record.annotations.requestId === request?.annotations.requestId)
          ?.annotations.outcome).toBe('cleanup-failed');
        expect(capture.logs.join('')).not.toContain('PRIVATE');
      } finally { await fixture.dispose(); }
    });

    it('keeps a reopened CSV readable when its engine source cannot be released', async () => {
      const capture = diagnosticCapture();
      const fixture = await factory.create(undefined, capture.configuration);
      try {
        const opened = await fixture.openSource('PRIVATE-SOURCE.csv', 'name\nAda\n');
        await fixture.writeSource('PRIVATE-SOURCE.csv', 'name\nGrace\n');
        fixture.failNextEngineSourceRelease();
        const reopened = await fixture.viewer.call({ operation: 'csv.reopen', workingCsvId: opened.workingCsvId });
        expect(reopened.status).toBe('opened');
        const rows = await fixture.viewer.call({ operation: 'csv.get-rows', workingCsvId: opened.workingCsvId, offset: 0, limit: 10 });
        expect(rows.rows[0].name).toBe('Grace');

        const records = capture.completed();
        const request = records.find((record) => record.message === 'csv.reopen' && record.annotations.outcome === 'opened');
        expect(request?.annotations.cleanup).toBe('cleanup-failed');
        expect(records.find((record) => record.message === 'csv.release-engine-source'
          && record.annotations.requestId === request?.annotations.requestId
          && record.annotations.outcome === 'cleanup-failed')).toBeDefined();
        expect(capture.logs.join('')).not.toContain('PRIVATE');
      } finally { await fixture.dispose(); }
    });

    it('releases an engine source when CSV loading fails', async () => {
      const capture = diagnosticCapture();
      const fixture = await factory.create(undefined, capture.configuration);
      try {
        const sourceId = await fixture.registerSource('PRIVATE-SOURCE.csv', 'name\nAda\n');
        fixture.failNextCsvLoad();
        const result = await fixture.viewer.call({ operation: 'csv.open-recent', sourceId });
        expect(result.status).toBe('failed');
        const records = capture.completed();
        const request = records.find((record) => record.message === 'csv.open-recent' && record.annotations.outcome === 'failed');
        expect(records.find((record) => record.message === 'csv.release-engine-source'
          && record.annotations.requestId === request?.annotations.requestId
          && record.annotations.outcome === 'succeeded')).toBeDefined();
        expect(records.find((record) => record.message === 'csv.release-staging'
          && record.annotations.requestId === request?.annotations.requestId)).toBeDefined();
      } finally { await fixture.dispose(); }
    });

    it('preserves the load failure when engine source release also fails', async () => {
      const capture = diagnosticCapture();
      const fixture = await factory.create(undefined, capture.configuration);
      try {
        const sourceId = await fixture.registerSource('PRIVATE-SOURCE.csv', 'name\nAda\n');
        fixture.failNextCsvLoad();
        fixture.failNextEngineSourceRelease();
        const result = await fixture.viewer.call({ operation: 'csv.open-recent', sourceId });
        expect(result).toMatchObject({
          status: 'failed',
          message: 'Unable to read CSV: check the delimiter, quote, and header options for this file.',
        });

        const records = capture.completed();
        const request = records.find((record) => record.message === 'csv.open-recent' && record.annotations.outcome === 'failed');
        expect(request?.annotations.cleanup).toBe('cleanup-failed');
        expect(request?.annotations.csvFailureCategory).toBe('engine');
        expect(records.find((record) => record.message === 'csv.release-engine-source'
          && record.annotations.requestId === request?.annotations.requestId
          && record.annotations.outcome === 'cleanup-failed')).toBeDefined();
        expect(records.find((record) => record.message === 'csv.release-staging'
          && record.annotations.requestId === request?.annotations.requestId
          && record.annotations.outcome === 'succeeded')).toBeDefined();
        expect(capture.logs.join('')).not.toContain('PRIVATE');
      } finally { await fixture.dispose(); }
    });

    it('rejects disposal when the database cannot be released, without driver detail', async () => {
      const capture = diagnosticCapture();
      const fixture = await factory.create(undefined, capture.configuration);
      try {
        await fixture.openSource('PRIVATE-SOURCE.csv', 'name\nPRIVATE-CELL\n');
        fixture.failNextDatabaseRelease();
        const rejection = await fixture.disposeWorkspace().then(() => null, (error: Error) => error.message);
        expect(rejection).toBe('The CSV workspace could not complete the request.');
        await expect(fixture.disposeWorkspace()).rejects.toThrow(rejection);
        const records = capture.completed();
        expect(records.find((record) => record.message === 'workspace.release-csvs')?.annotations.outcome).toBe('succeeded');
        expect(records.filter((record) => record.message === 'workspace.release-database').map((record) => record.annotations.outcome))
          .toEqual(['recoverable-failure']);
        for (const [stage, outcome] of [['workspace.close-database-connection', 'recoverable-failure'], ['workspace.close-database-engine', 'succeeded']]) {
          expect(records.filter((record) => record.message === stage).map((record) => record.annotations.outcome)).toEqual([outcome]);
        }
        expect(records.find((record) => record.message === 'workspace.dispose')?.annotations.outcome).toBe('failed');
        expect(capture.logs.join('')).not.toContain('PRIVATE');
      } finally { await fixture.dispose().catch(() => undefined); }
    });

    it.each([false, true])('drains admitted CSV reads after Comparison cleanup fails (CSV cleanup failure: %s)', async (failCsvCleanup) => {
      const releaseStarted = Promise.withResolvers<void>();
      const capture = diagnosticCapture((record) => {
        if (record.annotations.outcome === 'started'
          && (record.message === 'workspace.release-csvs' || record.message === 'workspace.release-database')) {
          releaseStarted.resolve();
        }
      });
      const fixture = await factory.create(undefined, capture.configuration);
      try {
        const { comparisonId, baselineId } = await prepareComparison(fixture);
        const started = await fixture.viewer.call({ operation: 'comparison.begin', comparisonId, kind: 'apply-key', key: ['id'] });
        if (started.status !== 'accepted') throw new Error('Not accepted');
        expect((await fixture.awaitComparisonOutcome(started.operationId)).status).toBe('applied');
        await fixture.failNextSnapshotDrop();
        if (failCsvCleanup) fixture.failNextTableDrop();
        const hold = fixture.holdNextRowRead();
        const reading = fixture.viewer.call({ operation: 'csv.get-rows', workingCsvId: baselineId, offset: 0, limit: 10 });
        await hold.entered;
        const disposal = fixture.disposeWorkspace();
        const rejection = disposal.then(() => null, (error: Error) => error);
        try {
          await releaseStarted.promise;
          expect(capture.records.some((record) => record.message === 'workspace.release-database')).toBe(false);
        } finally {
          hold.release();
          await Promise.allSettled([reading, disposal]);
        }
        await expect(reading).resolves.toMatchObject({ filteredRowCount: 1, rows: [{ id: '1', value: 'PRIVATE-CELL' }] });
        expect(await rejection).toMatchObject({ message: failCsvCleanup
          ? 'The CSV workspace could not complete the request.'
          : 'The data engine could not complete the operation.' });
        await expect(fixture.disposeWorkspace()).rejects.toBe(await rejection);
        const records = capture.completed();
        expect(records.find((record) => record.message === 'comparison.dispose')?.annotations.outcome).toBe('failed');
        expect(records.find((record) => record.message === 'workspace.release-csvs')?.annotations.outcome)
          .toBe(failCsvCleanup ? 'defect' : 'succeeded');
        expect(records.filter((record) => record.message === 'workspace.release-database').map((record) => record.annotations.outcome))
          .toEqual(['succeeded']);
        const outcome = records.find((record) => record.message === 'workspace.dispose');
        expect(outcome?.annotations.cleanup).toBe('cleanup-failed');
        expect(outcome?.annotations.recoverableFailure).toBe(true);
        expect(outcome?.annotations.defect).toBe(failCsvCleanup);
        expect(capture.logs.join('')).not.toContain('PRIVATE');
      } finally { await fixture.dispose().catch(() => undefined); }
    });

    it('reports a database release failure that follows a table release failure', async () => {
      const capture = diagnosticCapture();
      const fixture = await factory.create(undefined, capture.configuration);
      try {
        await fixture.openSource('PRIVATE-SOURCE.csv', 'name\nPRIVATE-CELL\n');
        fixture.failNextTableDrop();
        fixture.failNextDatabaseRelease();
        await expect(fixture.disposeWorkspace()).rejects.toThrow(/^The CSV workspace could not complete the request\.$/);
        const records = capture.completed();
        expect(records.find((record) => record.message === 'workspace.release-csvs')?.annotations.outcome).not.toBe('succeeded');
        expect(records.find((record) => record.message === 'workspace.release-database')?.annotations.outcome).toBe('recoverable-failure');
        const disposal = records.find((record) => record.message === 'workspace.dispose');
        expect(disposal?.annotations.outcome).toBe('failed');
        expect(disposal?.annotations.cleanup).toBe('cleanup-failed');
        expect(capture.logs.join('')).not.toContain('PRIVATE');
      } finally { await fixture.dispose().catch(() => undefined); }
    });
  });
}

async function prepareComparison(fixture: WorkspaceContractFixture, rows = '1,PRIVATE-CELL') {
  const baseline = await fixture.openSource('PRIVATE-SOURCE.csv', `id,value\n${rows}\n`);
  const candidate = await fixture.openSource('PRIVATE-CANDIDATE.csv', 'id,value\n1,other\n');
  const opened = await fixture.viewer.call({ operation: 'comparison.open', baselineId: baseline.workingCsvId, candidateId: candidate.workingCsvId });
  if (opened.status === 'rejected') throw new Error('Comparison rejected');
  return { comparisonId: opened.comparison.comparisonId, baselineId: baseline.workingCsvId, candidateId: candidate.workingCsvId };
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
  const connection = stubConnection({
    readObjectsCancellable: async () => { throw secret; },
    close: async () => {
      if (closeFails) { closeFails = false; throw secret; }
    },
  });
  return new DuckDbComparisonExecutor({
    connectWorker: () => Effect.succeed(connection),
    getOwnerConnection: async () => connection,
    acquireSource: () => Effect.succeed({ tableName: 'PRIVATE-table', columns: [{ name: 'id', type: 'VARCHAR' }] }),
  });
}
