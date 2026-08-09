import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ComparisonOperationId,
  ComparisonSummary,
  SourceKeyDiagnostics,
} from '../shared/ipc';
import type {
  ComparisonExecutor,
  CreateComparisonSnapshotRequest,
  ReadComparisonSnapshotWindowRequest,
  StoredComparisonWindow,
} from './comparison-executor';
import { WorkingCsvStore } from './working-csv-store';
import { CsvWorkspace } from './csv-workspace';

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
    if (workspace.comparisons.getState(comparisonId)?.operation?.phase === 'comparing') return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Comparison did not reach comparing.');
}

async function waitForApplied(workspace: CsvWorkspace, comparisonId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const comparison = workspace.comparisons.getState(comparisonId);
    if (comparison?.lastAttempt?.status === 'applied' && comparison.applied) return comparison;
    if (comparison?.lastAttempt?.status === 'failed') {
      throw new Error(comparison.lastAttempt.failure.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Comparison did not publish a result.');
}

async function openWorkingCsv(workspace: CsvWorkspace, filePath: string) {
  const outcome = await workspace.csvs.open(filePath);
  if (outcome.status === 'failed') throw new Error(outcome.failure.message);
  return outcome.workingCsv;
}

describe('CsvWorkspace lifecycle', () => {
  it('executes, reads, swaps, and cleans up a real DuckDB comparison', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'csv-workspace-integration-'));
    const baselinePath = path.join(tempDir, 'baseline.csv');
    const candidatePath = path.join(tempDir, 'candidate.csv');
    await writeFile(
      baselinePath,
      'id,value\n1,old\n2,same\n3,baseline-only\n5,also-baseline-only\n',
    );
    await writeFile(candidatePath, 'id,value\n1,new\n2,same\n4,candidate-only\n');
    const workspace = new CsvWorkspace();

    try {
      const baseline = await openWorkingCsv(workspace, baselinePath);
      const candidate = await openWorkingCsv(workspace, candidatePath);
      expect(baseline.editState).toEqual({
        workingCsvId: baseline.workingCsvId,
        dirty: false,
        canUndo: false,
        canRedo: false,
      });
      const opened = workspace.comparisons.open({
        baselineId: baseline.workingCsvId,
        candidateId: candidate.workingCsvId,
      });
      if (opened.status === 'rejected') throw new Error(opened.fault.message);

      const started = workspace.comparisons.begin({
        kind: 'apply-key',
        comparisonId: opened.comparison.comparisonId,
        key: ['id'],
      });
      if (started.status !== 'accepted') throw new Error('Comparison was not accepted.');
      const completed = await started.completion;
      expect(completed.status).toBe('applied');
      if (completed.status !== 'applied') throw new Error('Comparison result was not applied.');
      const applied = completed.comparison;
      expect(applied.applied?.summary).toEqual({
        rows: {
          changed: 1,
          baselineOnly: 2,
          candidateOnly: 1,
          unchanged: 1,
          total: 5,
        },
        changedColumns: [{ name: 'value', changedRowCount: 1 }],
      });
      if (!applied.applied) throw new Error('Comparison result was not applied.');

      const window = await workspace.comparisons.getWindow({
        comparisonId: opened.comparison.comparisonId,
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

      await writeFile(baselinePath, 'id,replacement\n1,x\n');
      const replacement = await workspace.csvs.replace(baseline.workingCsvId);
      expect(replacement.status).toBe('replaced');
      expect(workspace.csvs.getState(baseline.workingCsvId)?.workingCsvId).toBe(
        baseline.workingCsvId,
      );
      expect(
        workspace.comparisons.getState(opened.comparison.comparisonId)?.applied?.freshness,
      ).toEqual({ kind: 'outdated', changedSides: ['baseline'] });
      const staleWindow = await workspace.comparisons.getWindow({
        comparisonId: opened.comparison.comparisonId,
        resultToken: applied.applied.resultToken,
        offset: 0,
        limit: 10,
        rows: 'differences',
        columns: 'csv-order',
      });
      expect(staleWindow.status).toBe('ready');
      if (staleWindow.status !== 'ready') throw new Error('Stale comparison window was not ready.');
      expect(staleWindow.window.valueColumns).toEqual([{ name: 'value', changedRowCount: 1 }]);

      const swapped = workspace.comparisons.swap(opened.comparison.comparisonId);
      expect(swapped.status).toBe('changed');
      if (swapped.status !== 'changed' || !swapped.comparison.applied) {
        throw new Error('Comparison was not swapped.');
      }
      expect(swapped.comparison.applied.summary.rows).toMatchObject({
        baselineOnly: 1,
        candidateOnly: 2,
      });

      await expect(workspace.comparisons.close(opened.comparison.comparisonId)).resolves.toEqual({
        status: 'closed',
        comparisonId: opened.comparison.comparisonId,
      });
    } finally {
      try {
        await workspace.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('reserves a confirmed source close before awaiting dependent cleanup', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'csv-workspace-'));
    const baselinePath = path.join(tempDir, 'baseline.csv');
    const candidatePath = path.join(tempDir, 'candidate.csv');
    const csvs = new WorkingCsvStore();
    const executor = new ControlledExecutor();
    const workspace = new CsvWorkspace(csvs, executor);
    try {
      await writeFile(baselinePath, 'id,value\n1,a\n');
      await writeFile(candidatePath, 'id,value\n1,b\n');
      const baseline = await csvs.openOrThrow(baselinePath);
      const candidate = await csvs.openOrThrow(candidatePath);
      const opened = workspace.comparisons.open({
        baselineId: baseline.workingCsvId,
        candidateId: candidate.workingCsvId,
      });
      if (opened.status === 'rejected') throw new Error('open rejected');
      const started = workspace.comparisons.begin({
        kind: 'apply-key',
        comparisonId: opened.comparison.comparisonId,
        key: ['id'],
      });
      if (started.status !== 'accepted') throw new Error('Comparison was not accepted.');
      await waitForComparing(workspace, opened.comparison.comparisonId);
      await expect(
        workspace.comparisons.cancel({
          comparisonId: opened.comparison.comparisonId,
          operationId: started.operationId,
        }),
      ).resolves.toEqual({ status: 'requested' });

      const confirmation = await workspace.closeWorkingCsv({ workingCsvId: baseline.workingCsvId });
      if (confirmation.status !== 'confirmation-required')
        throw new Error('confirmation not required');
      const closing = workspace.closeWorkingCsv({
        workingCsvId: baseline.workingCsvId,
        confirmedImpact: confirmation.impact,
      });

      expect(
        workspace.comparisons.open({
          baselineId: baseline.workingCsvId,
          candidateId: candidate.workingCsvId,
        }),
      ).toMatchObject({ status: 'rejected', fault: { code: 'source-not-found' } });
      await expect(
        csvs.editCell({
          workingCsvId: baseline.workingCsvId,
          rowId: '1',
          column: 'value',
          value: 'changed while closing',
        }),
      ).rejects.toThrow('closing');

      executor.releaseCancellation();
      await expect(closing).resolves.toEqual({
        status: 'closed',
        closedWorkingCsvId: baseline.workingCsvId,
        closedComparisonIds: [opened.comparison.comparisonId],
      });
      expect(csvs.getState(baseline.workingCsvId)).toBeNull();
      expect(workspace.comparisons.getState(opened.comparison.comparisonId)).toBeNull();
    } finally {
      try {
        await workspace.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('reports a source change as the winning terminal outcome during generation', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'csv-workspace-source-change-'));
    const baselinePath = path.join(tempDir, 'baseline.csv');
    const candidatePath = path.join(tempDir, 'candidate.csv');
    const executor = new ControlledExecutor();
    const workspace = new CsvWorkspace(new WorkingCsvStore(), executor);
    try {
      await writeFile(baselinePath, 'id,value\n1,a\n');
      await writeFile(candidatePath, 'id,value\n1,b\n');
      const baseline = await openWorkingCsv(workspace, baselinePath);
      const candidate = await openWorkingCsv(workspace, candidatePath);
      const opened = workspace.comparisons.open({
        baselineId: baseline.workingCsvId,
        candidateId: candidate.workingCsvId,
      });
      if (opened.status === 'rejected') throw new Error('Comparison open was rejected.');
      const started = workspace.comparisons.begin({
        kind: 'apply-key',
        comparisonId: opened.comparison.comparisonId,
        key: ['id'],
      });
      if (started.status !== 'accepted') throw new Error('Comparison was not accepted.');
      await waitForComparing(workspace, opened.comparison.comparisonId);

      await workspace.csvs.editCell({
        workingCsvId: baseline.workingCsvId,
        rowId: '1',
        column: 'value',
        value: 'changed',
      });
      executor.releaseCancellation();

      await expect(started.completion).resolves.toMatchObject({
        status: 'sources-changed',
        changedSides: ['baseline'],
      });
      expect(workspace.comparisons.getState(opened.comparison.comparisonId)?.applied).toBeNull();
    } finally {
      try {
        await workspace.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('projects current row and edit state through the Working CSV facet', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'csv-workspace-working-state-'));
    const filePath = path.join(tempDir, 'working.csv');
    const workspace = new CsvWorkspace();
    try {
      await writeFile(filePath, 'id,value\n1,a\n');
      const workingCsv = await openWorkingCsv(workspace, filePath);
      await expect(workspace.csvs.open(filePath)).resolves.toMatchObject({
        status: 'existing',
        workingCsv: { workingCsvId: workingCsv.workingCsvId },
      });
      await expect(workspace.csvs.replace('missing-working-csv')).resolves.toEqual({
        status: 'working-csv-not-found',
      });

      await workspace.csvs.deleteRows({
        workingCsvId: workingCsv.workingCsvId,
        rowIds: ['1'],
      });
      expect(workspace.csvs.getState(workingCsv.workingCsvId)).toMatchObject({
        rowCount: 0,
        dataRevision: 1,
        editState: { dirty: true, canUndo: true, canRedo: false },
      });

      await workspace.csvs.undo(workingCsv.workingCsvId);
      expect(workspace.csvs.getState(workingCsv.workingCsvId)).toMatchObject({
        rowCount: 1,
        dataRevision: 2,
        editState: { dirty: false, canUndo: false, canRedo: true },
      });
    } finally {
      try {
        await workspace.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('revalidates aggregate dirty and Comparison impact before window close', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'csv-workspace-window-close-'));
    const workspace = new CsvWorkspace(new WorkingCsvStore(), new ControlledExecutor());
    try {
      const baselinePath = path.join(tempDir, 'baseline.csv');
      const candidatePath = path.join(tempDir, 'candidate.csv');
      await writeFile(baselinePath, 'id,value\n1,a\n');
      await writeFile(candidatePath, 'id,value\n1,b\n');
      const baseline = await openWorkingCsv(workspace, baselinePath);
      const candidate = await openWorkingCsv(workspace, candidatePath);
      await workspace.csvs.editCell({
        workingCsvId: baseline.workingCsvId,
        rowId: '1',
        column: 'value',
        value: 'changed',
      });
      const opened = workspace.comparisons.open({
        baselineId: baseline.workingCsvId,
        candidateId: candidate.workingCsvId,
      });
      if (opened.status === 'rejected') throw new Error('comparison rejected');

      const first = workspace.confirmWindowClose();
      expect(first).toMatchObject({
        status: 'confirmation-required',
        impact: {
          dirtyWorkingCsvs: [{ workingCsvId: baseline.workingCsvId }],
          dependentComparisons: [{ comparisonId: opened.comparison.comparisonId }],
        },
      });
      if (first.status !== 'confirmation-required') throw new Error('confirmation not required');

      await workspace.csvs.undo(baseline.workingCsvId);
      const rechecked = workspace.confirmWindowClose(first.impact);
      expect(rechecked).toMatchObject({
        status: 'confirmation-required',
        impact: { dirtyWorkingCsvs: [], dependentComparisons: [{ comparisonId: opened.comparison.comparisonId }] },
      });
      if (rechecked.status !== 'confirmation-required') throw new Error('impact not refreshed');
      expect(workspace.confirmWindowClose(rechecked.impact)).toEqual({ status: 'ready' });
    } finally {
      try {
        await workspace.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('rejects new Working CSV work once disposal starts', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'csv-workspace-disposal-gate-'));
    const baselinePath = path.join(tempDir, 'baseline.csv');
    const candidatePath = path.join(tempDir, 'candidate.csv');
    const latePath = path.join(tempDir, 'late.csv');
    const workspace = new CsvWorkspace();
    try {
      await writeFile(baselinePath, 'id,value\n1,a\n');
      await writeFile(candidatePath, 'id,value\n1,b\n');
      await writeFile(latePath, 'id,value\n1,c\n');
      const baseline = await openWorkingCsv(workspace, baselinePath);
      const candidate = await openWorkingCsv(workspace, candidatePath);

      const disposal = workspace.dispose();
      await expect(workspace.csvs.open(latePath)).resolves.toMatchObject({
        status: 'failed',
        failure: { retryable: false },
      });
      expect(
        workspace.comparisons.open({
          baselineId: baseline.workingCsvId,
          candidateId: candidate.workingCsvId,
        }),
      ).toMatchObject({
        status: 'rejected',
        fault: { message: 'The CSV workspace is closing.' },
      });
      await disposal;
      await expect(workspace.csvs.open(latePath)).resolves.toMatchObject({
        status: 'failed',
        failure: { retryable: false },
      });
      await expect(
        workspace.csvs.getRows({
          workingCsvId: baseline.workingCsvId,
          offset: 0,
          limit: 100,
        }),
      ).rejects.toThrow('CSV workspace is disposing.');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('waits for a Working CSV open admitted before disposal', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'csv-workspace-open-disposal-'));
    const filePath = path.join(tempDir, 'working.csv');
    const workspace = new CsvWorkspace();
    try {
      await writeFile(filePath, 'id,value\n1,a\n');

      const opening = workspace.csvs.open(filePath);
      const disposal = workspace.dispose();
      const opened = await opening;
      expect(opened.status).toBe('opened');
      await disposal;
      if (opened.status !== 'opened') throw new Error('open was not admitted');
      expect(workspace.csvs.getState(opened.workingCsv.workingCsvId)).toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('waits for an admitted row read and rejects later reads while closing', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'csv-workspace-read-close-'));
    const filePath = path.join(tempDir, 'working.csv');
    const workspace = new CsvWorkspace();
    try {
      await writeFile(filePath, 'id,value\n1,a\n2,b\n');
      const workingCsv = await openWorkingCsv(workspace, filePath);

      const admittedRead = workspace.csvs.getRows({
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 100,
      });
      const close = workspace.closeWorkingCsv({ workingCsvId: workingCsv.workingCsvId });

      await expect(
        workspace.csvs.getRows({
          workingCsvId: workingCsv.workingCsvId,
          offset: 0,
          limit: 100,
        }),
      ).rejects.toThrow('Working CSV is closing.');
      await expect(admittedRead).resolves.toMatchObject({ filteredRowCount: 2 });
      await expect(close).resolves.toMatchObject({ status: 'closed' });
    } finally {
      try {
        await workspace.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('waits for an admitted edit before calculating close impact', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'csv-workspace-edit-close-'));
    const filePath = path.join(tempDir, 'working.csv');
    const workspace = new CsvWorkspace();
    try {
      await writeFile(filePath, 'id,value\n1,a\n');
      const workingCsv = await openWorkingCsv(workspace, filePath);

      const edit = workspace.csvs.editCell({
        workingCsvId: workingCsv.workingCsvId,
        rowId: '1',
        column: 'value',
        value: 'changed',
      });
      const close = workspace.closeWorkingCsv({ workingCsvId: workingCsv.workingCsvId });

      await expect(edit).resolves.toMatchObject({ dirty: true });
      await expect(close).resolves.toMatchObject({
        status: 'confirmation-required',
        impact: { dirty: true },
      });
    } finally {
      try {
        await workspace.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('shares one idempotent disposal operation', async () => {
    const workspace = new CsvWorkspace();
    const first = workspace.dispose();
    const second = workspace.dispose();
    expect(second).toBe(first);
    await first;
  });
});
