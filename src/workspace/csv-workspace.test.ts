import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type {
  ComparisonOperationId,
  ComparisonSummary,
  SourceKeyDiagnostics,
} from '../shared/csv-viewer-contract';
import type {
  ComparisonExecutor,
  CreateComparisonSnapshotRequest,
  ReadComparisonSnapshotWindowRequest,
  StoredComparisonWindow,
} from './comparison-executor';
import type { CsvWorkspace } from './csv-workspace';
import { CsvWorkspaceFixture } from '../main/testing/csv-workspace-fixture';

const validDiagnostics: SourceKeyDiagnostics = {
  blankRowCount: 0,
  duplicateGroupCount: 0,
  blankExamples: [],
  duplicateExamples: [],
};

class ControlledExecutor implements ComparisonExecutor {
  private rejectSnapshot: ((error: Error) => void) | null = null;

  async validateKey(): Promise<SourceKeyDiagnostics> {
    return validDiagnostics;
  }

  createSnapshot(_request: CreateComparisonSnapshotRequest): Promise<ComparisonSummary> {
    return new Promise((_resolve, reject) => {
      this.rejectSnapshot = reject;
    });
  }

  activateSnapshot(_artifactId: ComparisonOperationId): void {}

  cancel(): void {}

  async release(): Promise<void> {}

  releaseCancellation(): void {
    this.rejectSnapshot?.(new Error('cancelled'));
    this.rejectSnapshot = null;
  }

  async readWindow(_request: ReadComparisonSnapshotWindowRequest): Promise<StoredComparisonWindow> {
    return { totalRowCount: 0, rows: [] };
  }

  async dropSnapshot(): Promise<void> {}

  async dispose(): Promise<void> {
    this.releaseCancellation();
  }
}

async function waitForComparing(workspace: CsvWorkspace, comparisonId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const comparison = await workspace.getComparisonState(comparisonId);
    if (comparison?.operation?.phase === 'comparing') return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Comparison did not reach comparing.');
}

describe('CsvWorkspace lifecycle', () => {
  it('executes, reads, swaps, and cleans up a real DuckDB comparison', async () => {
    const fixture = await CsvWorkspaceFixture.create();
    const workspace = fixture.workspace;

    try {
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
      const opened = await workspace.openComparison({
        baselineId: baseline.workingCsvId,
        candidateId: candidate.workingCsvId,
      });
      if (opened.status === 'rejected') throw new Error(opened.fault.message);
      const comparisonId = opened.comparison.comparisonId;

      const started = await workspace.beginComparison({
        kind: 'apply-key',
        comparisonId,
        key: ['id'],
      });
      if (started.status !== 'accepted') throw new Error('Comparison was not accepted.');
      const outcome = await fixture.awaitComparisonOutcome(started.operationId);
      expect(outcome.status).toBe('applied');

      const applied = await workspace.getComparisonState(comparisonId);
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
      if (!applied?.applied) throw new Error('Comparison result was not applied.');

      const window = await workspace.getComparisonWindow({
        comparisonId,
        resultToken: applied.applied.resultToken,
        offset: 0,
        limit: 10,
        rows: 'differences',
        columns: 'changed-first',
      });
      expect(window.status).toBe('ready');
      if (window.status !== 'ready') throw new Error('Comparison window was not ready.');
      expect(window.window.rows.map((row) => [row.keyValues[0], row.classification])).toEqual([
        ['1', 'changed'],
        ['3', 'baseline-only'],
        ['4', 'candidate-only'],
        ['5', 'baseline-only'],
      ]);

      await writeFile(fixture.file('baseline.csv'), 'id,replacement\n1,x\n');
      const replacement = await workspace.reopenCsv(baseline.workingCsvId);
      expect(replacement.status).toBe('replaced');
      await expect(workspace.getWorkingCsv(baseline.workingCsvId)).resolves.toMatchObject({
        workingCsvId: baseline.workingCsvId,
      });
      await expect(workspace.getComparisonState(comparisonId)).resolves.toMatchObject({
        applied: { freshness: { kind: 'outdated', changedSides: ['baseline'] } },
      });
      const staleWindow = await workspace.getComparisonWindow({
        comparisonId,
        resultToken: applied.applied.resultToken,
        offset: 0,
        limit: 10,
        rows: 'differences',
        columns: 'csv-order',
      });
      expect(staleWindow.status).toBe('ready');
      if (staleWindow.status !== 'ready') throw new Error('Stale comparison window was not ready.');
      expect(staleWindow.window.valueColumns).toEqual([{ name: 'value', changedRowCount: 1 }]);

      const swapped = await workspace.swapComparison(comparisonId);
      expect(swapped.status).toBe('changed');
      if (swapped.status !== 'changed' || !swapped.comparison.applied) {
        throw new Error('Comparison was not swapped.');
      }
      expect(swapped.comparison.applied.summary.rows).toMatchObject({
        baselineOnly: 1,
        candidateOnly: 2,
      });

      await expect(workspace.closeComparison(comparisonId)).resolves.toEqual({
        status: 'closed',
        comparisonId,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('reserves a confirmed source close and blocks every mutator while it runs', async () => {
    const executor = new ControlledExecutor();
    const fixture = await CsvWorkspaceFixture.create(executor);
    const workspace = fixture.workspace;
    try {
      const baseline = await fixture.openSource('baseline.csv', 'id,value\n1,a\n');
      const candidate = await fixture.openSource('candidate.csv', 'id,value\n1,b\n');
      const opened = await workspace.openComparison({
        baselineId: baseline.workingCsvId,
        candidateId: candidate.workingCsvId,
      });
      if (opened.status === 'rejected') throw new Error('open rejected');
      const comparisonId = opened.comparison.comparisonId;
      const started = await workspace.beginComparison({
        kind: 'apply-key',
        comparisonId,
        key: ['id'],
      });
      if (started.status !== 'accepted') throw new Error('Comparison was not accepted.');
      await waitForComparing(workspace, comparisonId);
      await expect(
        workspace.cancelComparison({ comparisonId, operationId: started.operationId }),
      ).resolves.toEqual({ status: 'requested' });

      const confirmation = await workspace.closeCsv({ workingCsvId: baseline.workingCsvId });
      if (confirmation.status !== 'confirmation-required') {
        throw new Error('confirmation not required');
      }
      const closing = workspace.closeCsv({
        workingCsvId: baseline.workingCsvId,
        confirmedImpact: confirmation.impact,
      });

      await expect(
        workspace.openComparison({
          baselineId: baseline.workingCsvId,
          candidateId: candidate.workingCsvId,
        }),
      ).resolves.toMatchObject({ status: 'rejected', fault: { code: 'source-not-found' } });

      const request = { workingCsvId: baseline.workingCsvId };
      await expect(workspace.reopenCsv(baseline.workingCsvId)).resolves.toMatchObject({
        status: 'failed',
        failure: { message: expect.stringContaining('closing') },
      });
      const mutations = [
        workspace.editCsvCell({ ...request, rowId: '1', column: 'value', value: 'changed' }),
        workspace.deleteCsvRows({ ...request, rowIds: ['1'] }),
        workspace.insertCsvRow({ ...request, placement: 'append', rowIds: [], hasActiveQuery: false }),
        workspace.undoCsvEdit(request),
        workspace.redoCsvEdit(request),
        workspace.exportCsv(request),
        workspace.getCsvRows({ ...request, offset: 0, limit: 10 }),
        workspace.getCsvEditState(request),
      ];
      for (const mutation of mutations) await expect(mutation).rejects.toThrow('closing');

      executor.releaseCancellation();
      await expect(closing).resolves.toEqual({
        status: 'closed',
        closedWorkingCsvId: baseline.workingCsvId,
        closedComparisonIds: [comparisonId],
      });
      await expect(workspace.getWorkingCsv(baseline.workingCsvId)).resolves.toBeNull();
      await expect(workspace.getComparisonState(comparisonId)).resolves.toBeNull();
    } finally {
      await fixture.dispose();
    }
  });

  it('reports a source change as the winning terminal outcome during generation', async () => {
    const executor = new ControlledExecutor();
    const fixture = await CsvWorkspaceFixture.create(executor);
    const workspace = fixture.workspace;
    try {
      const baseline = await fixture.openSource('baseline.csv', 'id,value\n1,a\n');
      const candidate = await fixture.openSource('candidate.csv', 'id,value\n1,b\n');
      const opened = await workspace.openComparison({
        baselineId: baseline.workingCsvId,
        candidateId: candidate.workingCsvId,
      });
      if (opened.status === 'rejected') throw new Error('Comparison open was rejected.');
      const comparisonId = opened.comparison.comparisonId;
      const started = await workspace.beginComparison({
        kind: 'apply-key',
        comparisonId,
        key: ['id'],
      });
      if (started.status !== 'accepted') throw new Error('Comparison was not accepted.');
      await waitForComparing(workspace, comparisonId);

      await workspace.editCsvCell({
        workingCsvId: baseline.workingCsvId,
        rowId: '1',
        column: 'value',
        value: 'changed',
      });
      executor.releaseCancellation();

      await expect(fixture.awaitComparisonOutcome(started.operationId)).resolves.toMatchObject({
        status: 'sources-changed',
        changedSides: ['baseline'],
      });
      await expect(workspace.getComparisonState(comparisonId)).resolves.toMatchObject({
        applied: null,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('projects current row and edit state for an open Working CSV', async () => {
    const fixture = await CsvWorkspaceFixture.create();
    const workspace = fixture.workspace;
    try {
      const filePath = await fixture.writeSource('working.csv', 'id,value\n1,a\n');
      const workingCsv = await fixture.open(filePath);
      await expect(
        workspace.openRecentCsv(await fixture.sourceId(filePath)),
      ).resolves.toMatchObject({
        status: 'already-open',
        workingCsv: { workingCsvId: workingCsv.workingCsvId },
      });
      await expect(workspace.reopenCsv('missing-working-csv')).resolves.toEqual({
        status: 'working-csv-not-found',
      });

      await workspace.deleteCsvRows({ workingCsvId: workingCsv.workingCsvId, rowIds: ['1'] });
      await expect(workspace.getWorkingCsv(workingCsv.workingCsvId)).resolves.toMatchObject({
        rowCount: 0,
        dataRevision: 1,
        editState: { hasUnexportedChanges: true, canUndo: true, canRedo: false },
      });

      await workspace.undoCsvEdit({ workingCsvId: workingCsv.workingCsvId });
      await expect(workspace.getWorkingCsv(workingCsv.workingCsvId)).resolves.toMatchObject({
        rowCount: 1,
        dataRevision: 2,
        editState: { hasUnexportedChanges: false, canUndo: false, canRedo: true },
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('derives close impact from Unexported Changes independently of undo and redo', async () => {
    const fixture = await CsvWorkspaceFixture.create();
    const workspace = fixture.workspace;
    try {
      const workingCsv = await fixture.openSource('working.csv', 'id,value\n1,a\n');
      fixture.queueExportTo('exported.csv');
      await workspace.editCsvCell({
        workingCsvId: workingCsv.workingCsvId,
        rowId: '1',
        column: 'value',
        value: 'exported',
      });
      const exported = await workspace.exportCsv({ workingCsvId: workingCsv.workingCsvId });

      expect(exported).toMatchObject({
        hasUnexportedChanges: false,
        canUndo: true,
        canRedo: false,
      });
      await expect(workspace.confirmWindowClose()).resolves.toEqual({ status: 'ready' });

      const undone = await workspace.undoCsvEdit({ workingCsvId: workingCsv.workingCsvId });
      expect(undone).toMatchObject({
        hasUnexportedChanges: true,
        canUndo: false,
        canRedo: true,
      });
      await expect(workspace.confirmWindowClose()).resolves.toMatchObject({
        status: 'confirmation-required',
        impact: {
          workingCsvsWithUnexportedChanges: [{ workingCsvId: workingCsv.workingCsvId }],
        },
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('revalidates aggregate Unexported Changes and Comparison impact before window close', async () => {
    const fixture = await CsvWorkspaceFixture.create(new ControlledExecutor());
    const workspace = fixture.workspace;
    try {
      const baseline = await fixture.openSource('baseline.csv', 'id,value\n1,a\n');
      const candidate = await fixture.openSource('candidate.csv', 'id,value\n1,b\n');
      await workspace.editCsvCell({
        workingCsvId: baseline.workingCsvId,
        rowId: '1',
        column: 'value',
        value: 'changed',
      });
      const opened = await workspace.openComparison({
        baselineId: baseline.workingCsvId,
        candidateId: candidate.workingCsvId,
      });
      if (opened.status === 'rejected') throw new Error('comparison rejected');

      const first = await workspace.confirmWindowClose();
      expect(first).toMatchObject({
        status: 'confirmation-required',
        impact: {
          workingCsvsWithUnexportedChanges: [{ workingCsvId: baseline.workingCsvId }],
          dependentComparisons: [{ comparisonId: opened.comparison.comparisonId }],
        },
      });
      if (first.status !== 'confirmation-required') throw new Error('confirmation not required');

      await workspace.undoCsvEdit({ workingCsvId: baseline.workingCsvId });
      const rechecked = await workspace.confirmWindowClose(first.impact);
      expect(rechecked).toMatchObject({
        status: 'confirmation-required',
        impact: {
          workingCsvsWithUnexportedChanges: [],
          dependentComparisons: [{ comparisonId: opened.comparison.comparisonId }],
        },
      });
      if (rechecked.status !== 'confirmation-required') throw new Error('impact not refreshed');
      await expect(workspace.confirmWindowClose(rechecked.impact)).resolves.toEqual({
        status: 'ready',
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects new Working CSV work once disposal starts', async () => {
    const fixture = await CsvWorkspaceFixture.create();
    const workspace = fixture.workspace;
    const baseline = await fixture.openSource('baseline.csv', 'id,value\n1,a\n');
    const candidate = await fixture.openSource('candidate.csv', 'id,value\n1,b\n');
    const latePath = await fixture.writeSource('late.csv', 'id,value\n1,c\n');
    const lateSourceId = await fixture.sourceId(latePath);

    const disposal = workspace.dispose();
    await expect(workspace.openRecentCsv(lateSourceId)).resolves.toMatchObject({
      status: 'failed',
      message: 'The CSV workspace is closing.',
    });
    await expect(
      workspace.openComparison({
        baselineId: baseline.workingCsvId,
        candidateId: candidate.workingCsvId,
      }),
    ).resolves.toMatchObject({
      status: 'rejected',
      fault: { message: 'The CSV workspace is closing.' },
    });
    await disposal;
    await expect(workspace.openRecentCsv(lateSourceId)).resolves.toMatchObject({
      status: 'failed',
      message: 'The CSV workspace is closing.',
    });
    await expect(
      workspace.getCsvRows({ workingCsvId: baseline.workingCsvId, offset: 0, limit: 100 }),
    ).rejects.toThrow('CSV workspace is disposing.');

    await fixture.dispose();
  });

  it('waits for a Working CSV open admitted before disposal', async () => {
    const fixture = await CsvWorkspaceFixture.create();
    const workspace = fixture.workspace;
    const filePath = await fixture.writeSource('working.csv', 'id,value\n1,a\n');

    const opening = workspace.openRecentCsv(await fixture.sourceId(filePath));
    const disposal = workspace.dispose();
    const opened = await opening;
    expect(opened.status).toBe('opened');
    await disposal;
    if (opened.status !== 'opened') throw new Error('open was not admitted');
    await expect(workspace.getWorkingCsv(opened.workingCsv.workingCsvId)).resolves.toBeNull();

    await fixture.dispose();
  });

  it('waits for an admitted row read and rejects later reads while closing', async () => {
    const fixture = await CsvWorkspaceFixture.create();
    const workspace = fixture.workspace;
    try {
      const workingCsv = await fixture.openSource('working.csv', 'id,value\n1,a\n2,b\n');

      const admittedRead = workspace.getCsvRows({
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 100,
      });
      const close = workspace.closeCsv({ workingCsvId: workingCsv.workingCsvId });

      await expect(
        workspace.getCsvRows({
          workingCsvId: workingCsv.workingCsvId,
          offset: 0,
          limit: 100,
        }),
      ).rejects.toThrow('Working CSV is closing.');
      await expect(admittedRead).resolves.toMatchObject({ filteredRowCount: 2 });
      await expect(close).resolves.toMatchObject({ status: 'closed' });
    } finally {
      await fixture.dispose();
    }
  });

  it('waits for an admitted edit before calculating close impact', async () => {
    const fixture = await CsvWorkspaceFixture.create();
    const workspace = fixture.workspace;
    try {
      const workingCsv = await fixture.openSource('working.csv', 'id,value\n1,a\n');

      const edit = workspace.editCsvCell({
        workingCsvId: workingCsv.workingCsvId,
        rowId: '1',
        column: 'value',
        value: 'changed',
      });
      const close = workspace.closeCsv({ workingCsvId: workingCsv.workingCsvId });

      await expect(edit).resolves.toMatchObject({ hasUnexportedChanges: true });
      await expect(close).resolves.toMatchObject({
        status: 'confirmation-required',
        impact: { hasUnexportedChanges: true },
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('shares one idempotent disposal operation', async () => {
    const fixture = await CsvWorkspaceFixture.create();
    const first = fixture.workspace.dispose();
    const second = fixture.workspace.dispose();
    expect(second).toBe(first);
    await fixture.dispose();
  });
});
