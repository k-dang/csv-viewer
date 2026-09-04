import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ComparisonOperationId,
  ComparisonSummary,
  SourceKeyDiagnostics,
} from '../../src/contracts/csv-viewer';
import type {
  ComparisonExecutor,
  CreateComparisonSnapshotRequest,
  ReadComparisonSnapshotWindowRequest,
  StoredComparisonWindow,
} from '../../src/comparison-executor';
import type {
  WorkspaceContractFactory,
  WorkspaceContractFixture,
} from './workspace-contract';

const validDiagnostics: SourceKeyDiagnostics = {
  blankRowCount: 0,
  duplicateGroupCount: 0,
  blankExamples: [],
  duplicateExamples: [],
};

class ControlledExecutor implements ComparisonExecutor {
  private rejectSnapshot: ((error: Error) => void) | null = null;
  private readonly snapshotStarted = Promise.withResolvers<void>();

  async validateKey(): Promise<SourceKeyDiagnostics> {
    return validDiagnostics;
  }

  createSnapshot(
    _request: CreateComparisonSnapshotRequest,
  ): Promise<ComparisonSummary> {
    return new Promise((_resolve, reject) => {
      this.rejectSnapshot = reject;
      this.snapshotStarted.resolve();
    });
  }

  activateSnapshot(_artifactId: ComparisonOperationId): void {}

  cancel(): void {}

  async release(): Promise<void> {}

  releaseCancellation(): void {
    if (this.rejectSnapshot === null) {
      throw new Error('The controlled snapshot has not started.');
    }
    this.rejectSnapshot(new Error('cancelled'));
    this.rejectSnapshot = null;
  }

  waitForSnapshotStart(): Promise<void> {
    return this.snapshotStarted.promise;
  }

  async readWindow(
    _request: ReadComparisonSnapshotWindowRequest,
  ): Promise<StoredComparisonWindow> {
    return { totalRowCount: 0, rows: [] };
  }

  async dropSnapshot(): Promise<void> {}

  async dispose(): Promise<void> {
    this.rejectSnapshot?.(new Error('cancelled'));
    this.rejectSnapshot = null;
  }
}

function waitForComparing(
  fixture: WorkspaceContractFixture,
  comparisonId: string,
): Promise<boolean> {
  return vi.waitUntil(
    () =>
      fixture.latestComparison(comparisonId)?.operation?.phase === 'comparing',
    { interval: 1 },
  );
}

export function defineCsvWorkspaceLifecycleContract(
  factory: WorkspaceContractFactory,
): void {
  describe(`${factory.name} CsvWorkspace lifecycle`, () => {
    let fixture: WorkspaceContractFixture;
    let controlledFixture: WorkspaceContractFixture | undefined;
    let executor: ControlledExecutor;

    beforeEach(async () => {
      fixture = await factory.create();
      controlledFixture = undefined;
    });

    afterEach(async () => {
      await Promise.all([fixture.dispose(), controlledFixture?.dispose()]);
    });

    async function createControlledFixture(): Promise<WorkspaceContractFixture> {
      executor = new ControlledExecutor();
      controlledFixture = await factory.create(executor);
      return controlledFixture;
    }

    it('executes, reads, swaps, and cleans up a real comparison', async () => {
      const workspace = fixture.viewer;

      const baseline = await fixture.openSource(
        'baseline.csv',
        'id,value\n1,old\n2,same\n3,baseline-only\n5,also-baseline-only\n',
      );
      const candidate = await fixture.openSource(
        'candidate.csv',
        'id,value\n1,new\n2,same\n4,candidate-only\n',
      );
      expect(baseline.editState).toEqual({
        workingCsvId: baseline.workingCsvId,
        hasUnexportedChanges: false,
        canUndo: false,
        canRedo: false,
      });
      const opened = await workspace.call({
        operation: 'comparison.open',
        baselineId: baseline.workingCsvId,
        candidateId: candidate.workingCsvId,
      });
      if (opened.status === 'rejected') throw new Error(opened.fault.message);
      const comparisonId = opened.comparison.comparisonId;

      const started = await workspace.call({
        operation: 'comparison.begin',
        kind: 'apply-key',
        comparisonId,
        key: ['id'],
      });
      if (started.status !== 'accepted')
        throw new Error('Comparison was not accepted.');
      const outcome = await fixture.awaitComparisonOutcome(started.operationId);
      expect(outcome.status).toBe('applied');

      const applied = fixture.latestComparison(comparisonId);
      expect(applied?.applied?.summary).toEqual({
        rows: {
          changed: 1,
          baselineOnly: 2,
          candidateOnly: 1,
          unchanged: 1,
          total: 5,
        },
        changedColumns: [{ name: 'value', changedRowCount: 1 }],
      });
      if (!applied?.applied)
        throw new Error('Comparison result was not applied.');

      const window = await workspace.call({
        operation: 'comparison.get-window',
        comparisonId,
        resultToken: applied.applied.resultToken,
        offset: 0,
        limit: 10,
        rows: 'differences',
        columns: 'changed-first',
      });
      expect(window.status).toBe('ready');
      if (window.status !== 'ready')
        throw new Error('Comparison window was not ready.');
      expect(
        window.window.rows.map((row) => [row.keyValues[0], row.classification]),
      ).toEqual([
        ['1', 'changed'],
        ['3', 'baseline-only'],
        ['4', 'candidate-only'],
        ['5', 'baseline-only'],
      ]);

      await fixture.writeSource('baseline.csv', 'id,replacement\n1,x\n');
      const replacement = await workspace.call({
        operation: 'csv.reopen',
        workingCsvId: baseline.workingCsvId,
      });
      expect(replacement.status).toBe('opened');
      if (replacement.status !== 'opened')
        throw new Error(`Reopen was ${replacement.status}.`);
      expect(replacement.workingCsv.workingCsvId).toBe(baseline.workingCsvId);
      expect(fixture.latestComparison(comparisonId)).toMatchObject({
        applied: {
          freshness: { kind: 'outdated', changedSides: ['baseline'] },
        },
      });
      const staleWindow = await workspace.call({
        operation: 'comparison.get-window',
        comparisonId,
        resultToken: applied.applied.resultToken,
        offset: 0,
        limit: 10,
        rows: 'differences',
        columns: 'csv-order',
      });
      expect(staleWindow.status).toBe('ready');
      if (staleWindow.status !== 'ready')
        throw new Error('Stale comparison window was not ready.');
      expect(staleWindow.window.valueColumns).toEqual([
        { name: 'value', changedRowCount: 1 },
      ]);

      const swapped = await workspace.call({
        operation: 'comparison.swap',
        comparisonId: comparisonId,
      });
      expect(swapped.status).toBe('changed');
      if (swapped.status !== 'changed' || !swapped.comparison.applied) {
        throw new Error('Comparison was not swapped.');
      }
      expect(swapped.comparison.applied.summary.rows).toMatchObject({
        baselineOnly: 1,
        candidateOnly: 2,
      });

      await expect(
        workspace.call({
          operation: 'comparison.close',
          comparisonId: comparisonId,
        }),
      ).resolves.toEqual({
        status: 'closed',
        comparisonId,
      });
    });

    it('reserves a confirmed source close and blocks every mutator while it runs', async () => {
      const fixture = await createControlledFixture();
      const workspace = fixture.viewer;
      const [baseline, candidate] = await Promise.all([
        fixture.openSource('baseline.csv', 'id,value\n1,a\n'),
        fixture.openSource('candidate.csv', 'id,value\n1,b\n'),
      ]);
      const opened = await workspace.call({
        operation: 'comparison.open',
        baselineId: baseline.workingCsvId,
        candidateId: candidate.workingCsvId,
      });
      if (opened.status === 'rejected') throw new Error('open rejected');
      const comparisonId = opened.comparison.comparisonId;
      const started = await workspace.call({
        operation: 'comparison.begin',
        kind: 'apply-key',
        comparisonId,
        key: ['id'],
      });
      if (started.status !== 'accepted')
        throw new Error('Comparison was not accepted.');
      await waitForComparing(fixture, comparisonId);
      await executor.waitForSnapshotStart();
      await expect(
        workspace.call({
          operation: 'comparison.cancel',
          comparisonId,
          operationId: started.operationId,
        }),
      ).resolves.toEqual({ status: 'requested' });

      const confirmation = await workspace.call({
        operation: 'csv.close',
        workingCsvId: baseline.workingCsvId,
      });
      if (confirmation.status !== 'confirmation-required') {
        throw new Error('confirmation not required');
      }
      const closing = workspace.call({
        operation: 'csv.close',
        workingCsvId: baseline.workingCsvId,
        confirmedImpact: confirmation.impact,
      });

      await expect(
        workspace.call({
          operation: 'comparison.open',
          baselineId: baseline.workingCsvId,
          candidateId: candidate.workingCsvId,
        }),
      ).resolves.toMatchObject({
        status: 'rejected',
        fault: { code: 'source-not-found' },
      });

      const request = { workingCsvId: baseline.workingCsvId };
      const errorLog = vi.spyOn(console, 'error');
      await expect(
        workspace.call({
          operation: 'csv.reopen',
          workingCsvId: baseline.workingCsvId,
        }),
      ).resolves.toMatchObject({
        status: 'failed',
        message: expect.stringContaining('closing'),
      });
      expect(errorLog).not.toHaveBeenCalled();
      errorLog.mockRestore();
      const mutations = [
        workspace.call({
          operation: 'csv.edit-cell',
          ...request,
          rowId: '1',
          column: 'value',
          value: 'changed',
        }),
        workspace.call({
          operation: 'csv.delete-rows',
          ...request,
          rowIds: ['1'],
        }),
        workspace.call({
          operation: 'csv.insert-row',
          ...request,
          placement: 'append',
          rowIds: [],
          hasActiveQuery: false,
        }),
        workspace.call({ operation: 'csv.undo', ...request }),
        workspace.call({ operation: 'csv.redo', ...request }),
        workspace.call({ operation: 'csv.export', ...request }),
        workspace.call({
          operation: 'csv.get-rows',
          ...request,
          offset: 0,
          limit: 10,
        }),
        workspace.call({ operation: 'csv.get-edit-state', ...request }),
      ];
      for (const mutation of mutations)
        await expect(mutation).rejects.toThrow('closing');

      executor.releaseCancellation();
      await expect(closing).resolves.toEqual({
        status: 'closed',
        closedWorkingCsvId: baseline.workingCsvId,
        closedComparisonIds: [comparisonId],
      });
      expect(fixture.latestComparison(comparisonId)).toBeNull();
    });

    it('reports a source change as the winning terminal outcome during generation', async () => {
      const fixture = await createControlledFixture();
      const workspace = fixture.viewer;
      const [baseline, candidate] = await Promise.all([
        fixture.openSource('baseline.csv', 'id,value\n1,a\n'),
        fixture.openSource('candidate.csv', 'id,value\n1,b\n'),
      ]);
      const opened = await workspace.call({
        operation: 'comparison.open',
        baselineId: baseline.workingCsvId,
        candidateId: candidate.workingCsvId,
      });
      if (opened.status === 'rejected')
        throw new Error('Comparison open was rejected.');
      const comparisonId = opened.comparison.comparisonId;
      const started = await workspace.call({
        operation: 'comparison.begin',
        kind: 'apply-key',
        comparisonId,
        key: ['id'],
      });
      if (started.status !== 'accepted')
        throw new Error('Comparison was not accepted.');
      await waitForComparing(fixture, comparisonId);
      await executor.waitForSnapshotStart();

      await workspace.call({
        operation: 'csv.edit-cell',
        workingCsvId: baseline.workingCsvId,
        rowId: '1',
        column: 'value',
        value: 'changed',
      });
      executor.releaseCancellation();

      await expect(
        fixture.awaitComparisonOutcome(started.operationId),
      ).resolves.toMatchObject({
        status: 'sources-changed',
        changedSides: ['baseline'],
      });
      expect(fixture.latestComparison(comparisonId)).toMatchObject({
        applied: null,
      });
    });

    it('projects current row and edit state for an open Working CSV', async () => {
      const workspace = fixture.viewer;
      const workingCsv = await fixture.openSource(
        'working.csv',
        'id,value\n1,a\n',
      );
      await expect(
        workspace.call({
          operation: 'csv.open-recent',
          sourceId: workingCsv.source.sourceId,
        }),
      ).resolves.toEqual({ status: 'already-open', workingCsv });
      await expect(
        workspace.call({
          operation: 'csv.reopen',
          workingCsvId: 'missing-working-csv',
        }),
      ).resolves.toEqual({
        status: 'failed',
        message: 'The Working CSV is no longer open.',
      });

      const deleted = await workspace.call({
        operation: 'csv.delete-rows',
        workingCsvId: workingCsv.workingCsvId,
        rowIds: ['1'],
      });
      expect(deleted).toMatchObject({
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      });
      const emptyRows = await workspace.call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 10,
      });
      expect(emptyRows).toMatchObject({ filteredRowCount: 0, rows: [] });

      const undone = await workspace.call({
        operation: 'csv.undo',
        workingCsvId: workingCsv.workingCsvId,
      });
      expect(undone).toMatchObject({
        hasUnexportedChanges: false,
        canUndo: false,
        canRedo: true,
      });
      const restoredRows = await workspace.call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 10,
      });
      expect(restoredRows).toMatchObject({
        filteredRowCount: 1,
        rows: [expect.objectContaining({ id: '1' })],
      });
    });

    it('derives close impact from Unexported Changes independently of undo and redo', async () => {
      const workspace = fixture.viewer;
      const workingCsv = await fixture.openSource(
        'working.csv',
        'id,value\n1,a\n',
      );
      fixture.captureNextExport('exported.csv');
      await workspace.call({
        operation: 'csv.edit-cell',
        workingCsvId: workingCsv.workingCsvId,
        rowId: '1',
        column: 'value',
        value: 'exported',
      });
      const exported = await workspace.call({
        operation: 'csv.export',
        workingCsvId: workingCsv.workingCsvId,
      });

      expect(exported).toMatchObject({
        status: 'exported',
        editState: {
          hasUnexportedChanges: false,
          canUndo: true,
          canRedo: false,
        },
      });
      await expect(fixture.confirmClose()).resolves.toEqual({
        status: 'ready',
      });

      const undone = await workspace.call({
        operation: 'csv.undo',
        workingCsvId: workingCsv.workingCsvId,
      });
      expect(undone).toMatchObject({
        hasUnexportedChanges: true,
        canUndo: false,
        canRedo: true,
      });
      await expect(fixture.confirmClose()).resolves.toMatchObject({
        status: 'confirmation-required',
        impact: {
          workingCsvsWithUnexportedChanges: [
            { workingCsvId: workingCsv.workingCsvId },
          ],
        },
      });
    });

    it('revalidates aggregate Unexported Changes and Comparison impact before window close', async () => {
      const fixture = await createControlledFixture();
      const workspace = fixture.viewer;
      const [baseline, candidate] = await Promise.all([
        fixture.openSource('baseline.csv', 'id,value\n1,a\n'),
        fixture.openSource('candidate.csv', 'id,value\n1,b\n'),
      ]);
      await workspace.call({
        operation: 'csv.edit-cell',
        workingCsvId: baseline.workingCsvId,
        rowId: '1',
        column: 'value',
        value: 'changed',
      });
      const opened = await workspace.call({
        operation: 'comparison.open',
        baselineId: baseline.workingCsvId,
        candidateId: candidate.workingCsvId,
      });
      if (opened.status === 'rejected') throw new Error('comparison rejected');

      const first = await fixture.confirmClose();
      expect(first).toMatchObject({
        status: 'confirmation-required',
        impact: {
          workingCsvsWithUnexportedChanges: [
            { workingCsvId: baseline.workingCsvId },
          ],
          dependentComparisons: [
            { comparisonId: opened.comparison.comparisonId },
          ],
        },
      });
      if (first.status !== 'confirmation-required')
        throw new Error('confirmation not required');

      await workspace.call({
        operation: 'csv.undo',
        workingCsvId: baseline.workingCsvId,
      });
      const rechecked = await fixture.confirmClose(first.impact);
      expect(rechecked).toMatchObject({
        status: 'confirmation-required',
        impact: {
          workingCsvsWithUnexportedChanges: [],
          dependentComparisons: [
            { comparisonId: opened.comparison.comparisonId },
          ],
        },
      });
      if (rechecked.status !== 'confirmation-required')
        throw new Error('impact not refreshed');
      await expect(fixture.confirmClose(rechecked.impact)).resolves.toEqual({
        status: 'ready',
      });
    });

    it('rejects new Working CSV work once disposal starts', async () => {
      const workspace = fixture.viewer;
      const [baseline, candidate] = await Promise.all([
        fixture.openSource('baseline.csv', 'id,value\n1,a\n'),
        fixture.openSource('candidate.csv', 'id,value\n1,b\n'),
      ]);
      const lateSourceId = await fixture.registerSource(
        'late.csv',
        'id,value\n1,c\n',
      );

      const disposal = fixture.disposeWorkspace();
      await expect(
        workspace.call({
          operation: 'csv.open-recent',
          sourceId: lateSourceId,
        }),
      ).resolves.toMatchObject({
        status: 'failed',
        message: 'The CSV workspace is closing.',
      });
      await expect(
        workspace.call({
          operation: 'comparison.open',
          baselineId: baseline.workingCsvId,
          candidateId: candidate.workingCsvId,
        }),
      ).resolves.toMatchObject({
        status: 'rejected',
        fault: { message: 'The CSV workspace is closing.' },
      });
      await disposal;
      await expect(
        workspace.call({
          operation: 'csv.open-recent',
          sourceId: lateSourceId,
        }),
      ).resolves.toMatchObject({
        status: 'failed',
        message: 'The CSV workspace is closing.',
      });
      await expect(
        workspace.call({
          operation: 'csv.get-rows',
          workingCsvId: baseline.workingCsvId,
          offset: 0,
          limit: 100,
        }),
      ).rejects.toThrow('CSV workspace is disposing.');
    });

    it('waits for a Working CSV open admitted before disposal', async () => {
      const workspace = fixture.viewer;
      const sourceId = await fixture.registerSource(
        'working.csv',
        'id,value\n1,a\n',
      );

      const opening = workspace.call({
        operation: 'csv.open-recent',
        sourceId: sourceId,
      });
      const disposal = fixture.disposeWorkspace();
      const opened = await opening;
      expect(opened.status).toBe('opened');
      await disposal;
      if (opened.status !== 'opened') throw new Error('open was not admitted');
    });

    it('waits for an admitted row read and rejects later reads while closing', async () => {
      const workspace = fixture.viewer;
      const workingCsv = await fixture.openSource(
        'working.csv',
        'id,value\n1,a\n2,b\n',
      );

      const admittedRead = workspace.call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 100,
      });
      const close = workspace.call({
        operation: 'csv.close',
        workingCsvId: workingCsv.workingCsvId,
      });

      await expect(
        workspace.call({
          operation: 'csv.get-rows',
          workingCsvId: workingCsv.workingCsvId,
          offset: 0,
          limit: 100,
        }),
      ).rejects.toThrow('Working CSV is closing.');
      await expect(admittedRead).resolves.toMatchObject({
        filteredRowCount: 2,
      });
      await expect(close).resolves.toMatchObject({ status: 'closed' });
    });

    it('waits for an admitted edit before calculating close impact', async () => {
      const workspace = fixture.viewer;
      const workingCsv = await fixture.openSource(
        'working.csv',
        'id,value\n1,a\n',
      );

      const edit = workspace.call({
        operation: 'csv.edit-cell',
        workingCsvId: workingCsv.workingCsvId,
        rowId: '1',
        column: 'value',
        value: 'changed',
      });
      const close = workspace.call({
        operation: 'csv.close',
        workingCsvId: workingCsv.workingCsvId,
      });

      await expect(edit).resolves.toMatchObject({
        hasUnexportedChanges: true,
      });
      await expect(close).resolves.toMatchObject({
        status: 'confirmation-required',
        impact: { hasUnexportedChanges: true },
      });
    });

    it('handles concurrent disposal requests idempotently', async () => {
      const first = fixture.disposeWorkspace();
      const second = fixture.disposeWorkspace();
      await expect(Promise.all([first, second])).resolves.toEqual([
        undefined,
        undefined,
      ]);
    });
  });
}
