import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ComparisonSummary, SourceKeyDiagnostics } from '../shared/ipc';
import type {
  ComparisonExecutor,
  CreateComparisonSnapshotRequest,
  ReadComparisonSnapshotWindowRequest,
  StoredComparisonWindow,
} from './comparison-executor';
import { CsvDataService } from './csv-data-service';
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

  cancel(): void {}

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
      const baseline = await workspace.csvs.openCsv(baselinePath);
      const candidate = await workspace.csvs.openCsv(candidatePath);
      const opened = workspace.comparisons.open({
        baselineId: baseline.sessionId,
        candidateId: candidate.sessionId,
      });
      if (opened.status === 'rejected') throw new Error(opened.fault.message);

      const started = workspace.comparisons.begin({
        kind: 'apply-key',
        comparisonId: opened.comparison.comparisonId,
        key: ['id'],
      });
      expect(started.status).toBe('accepted');
      const applied = await waitForApplied(workspace, opened.comparison.comparisonId);
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
      await workspace.csvs.reopenSession(baseline.sessionId);
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
      });
    } finally {
      await workspace.dispose();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reserves a confirmed source close before awaiting dependent cleanup', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'csv-workspace-'));
    const baselinePath = path.join(tempDir, 'baseline.csv');
    const candidatePath = path.join(tempDir, 'candidate.csv');
    await writeFile(baselinePath, 'id,value\n1,a\n');
    await writeFile(candidatePath, 'id,value\n1,b\n');
    const csvs = new CsvDataService();
    const executor = new ControlledExecutor();
    const workspace = new CsvWorkspace(csvs, executor);
    const baseline = await csvs.openCsv(baselinePath);
    const candidate = await csvs.openCsv(candidatePath);
    const opened = workspace.comparisons.open({
      baselineId: baseline.sessionId,
      candidateId: candidate.sessionId,
    });
    if (opened.status === 'rejected') throw new Error('open rejected');
    workspace.comparisons.begin({
      kind: 'apply-key',
      comparisonId: opened.comparison.comparisonId,
      key: ['id'],
    });
    await waitForComparing(workspace, opened.comparison.comparisonId);

    const confirmation = await workspace.closeCsv(baseline.sessionId);
    if (confirmation.status !== 'confirmation-required')
      throw new Error('confirmation not required');
    const closing = workspace.closeCsv(baseline.sessionId, confirmation.impact);

    expect(
      workspace.comparisons.open({
        baselineId: baseline.sessionId,
        candidateId: candidate.sessionId,
      }),
    ).toMatchObject({ status: 'rejected', fault: { code: 'source-not-found' } });
    await expect(
      csvs.editCell({
        sessionId: baseline.sessionId,
        rowId: '1',
        column: 'value',
        value: 'changed while closing',
      }),
    ).rejects.toThrow('closing');

    executor.releaseCancellation();
    await expect(closing).resolves.toEqual({ status: 'closed' });
    expect(csvs.getSession(baseline.sessionId)).toBeNull();
    expect(workspace.comparisons.getState(opened.comparison.comparisonId)).toBeNull();

    await workspace.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('shares one idempotent disposal operation', async () => {
    const workspace = new CsvWorkspace();
    const first = workspace.dispose();
    const second = workspace.dispose();
    expect(second).toBe(first);
    await first;
  });
});
