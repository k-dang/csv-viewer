import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  workspaceContractFactories,
  type WorkspaceContractFixture,
} from '../main/testing/workspace-contract-fixture';

describe.each(workspaceContractFactories)('$name CsvViewer request seam', ({ create }) => {
  let fixture: WorkspaceContractFixture;

  beforeEach(async () => {
    fixture = await create();
  });

  afterEach(async () => {
    await fixture.dispose();
  });

  it('opens a CSV Source and reads its Working CSV through typed requests', async () => {
    const sourceId = await fixture.registerSource('people.csv', 'name,age\nAda,37\n');
    const opened = await fixture.viewer.call({ operation: 'csv.open-recent', sourceId });
    if (opened.status !== 'opened') throw new Error(`Open was ${opened.status}.`);

    const rows = await fixture.viewer.call({
      operation: 'csv.get-rows',
      workingCsvId: opened.workingCsv.workingCsvId,
      offset: 0,
      limit: 10,
    });

    expect(rows).toMatchObject({
      filteredRowCount: 1,
      rows: [{ name: 'Ada', age: '37' }],
    });
  });

  it('publishes Aligned Comparison changes through one event subscription', async () => {
    const baselineSourceId = await fixture.registerSource('baseline.csv', 'id,value\n1,old\n');
    const candidateSourceId = await fixture.registerSource('candidate.csv', 'id,value\n1,new\n');
    const baseline = await fixture.viewer.call({ operation: 'csv.open-recent', sourceId: baselineSourceId });
    const candidate = await fixture.viewer.call({ operation: 'csv.open-recent', sourceId: candidateSourceId });
    if (baseline.status !== 'opened' || candidate.status !== 'opened') throw new Error('CSV Sources did not open.');

    const events: unknown[] = [];
    const unsubscribe = fixture.viewer.onEvent((event) => events.push(event));
    const opened = await fixture.viewer.call({
      operation: 'comparison.open',
      baselineId: baseline.workingCsv.workingCsvId,
      candidateId: candidate.workingCsv.workingCsvId,
    });
    if (opened.status === 'rejected') throw new Error(opened.fault.message);
    const started = await fixture.viewer.call({
      operation: 'comparison.begin',
      kind: 'apply-key',
      comparisonId: opened.comparison.comparisonId,
      key: ['id'],
    });
    if (started.status !== 'accepted') throw new Error('Comparison was not accepted.');

    await fixture.awaitComparisonOutcome(started.operationId);
    unsubscribe();

    expect(events).toContainEqual({
      type: 'comparison',
      event: expect.objectContaining({ kind: 'changed' }),
    });
  });

  it('does not expose workspace ownership through product requests', async () => {
    // SAFETY: This intentionally sends an operation outside the public union to test rejection.
    await expect(fixture.viewer.call({ operation: 'workspace.dispose' } as never)).rejects.toThrow(
      'Unsupported CSV Viewer operation: workspace.dispose',
    );
  });
});
