import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  WorkspaceContractFactory,
  WorkspaceContractFixture,
} from './workspace-contract';

export function defineCsvViewerRequestContract(factory: WorkspaceContractFactory): void {
  describe(`${factory.name} CsvViewer request seam`, () => {
    let fixture: WorkspaceContractFixture;

    beforeEach(async () => {
      fixture = await factory.create();
    });

    afterEach(async () => {
      await fixture.dispose();
    });

    it('does not expose workspace ownership through product requests', async () => {
      // SAFETY: This intentionally sends an operation outside the public union to test rejection.
      await expect(
        fixture.viewer.call({ operation: 'workspace.dispose' } as never),
      ).rejects.toThrow(/^Malformed CSV Viewer request\.$/);
    });

    it('rejects malformed requests before they change the Working CSV', async () => {
      const sourceId = await fixture.registerSource('people.csv', 'name\nAda\n');
      const opened = await fixture.viewer.call({ operation: 'csv.open-recent', sourceId });
      if (opened.status !== 'opened') throw new Error(`Open was ${opened.status}.`);
      const { workingCsvId } = opened.workingCsv;
      const rows = () => fixture.viewer.call({ operation: 'csv.get-rows', workingCsvId, offset: 0, limit: 10 });
      const before = await rows();

      const malformed = [
        null,
        { operation: 'csv.unknown', workingCsvId },
        { operation: 'csv.edit-cell', workingCsvId, rowId: '1', column: 'name' },
        { operation: 'csv.edit-cell', workingCsvId, rowId: '1', column: 'name', value: 42 },
        { operation: 'csv.insert-row', workingCsvId, placement: 'middle', rowIds: ['1'], hasActiveQuery: false },
        { operation: 'csv.get-rows', workingCsvId, offset: -1, limit: 10 },
      ];
      for (const request of malformed) {
        // SAFETY: Each payload is deliberately outside the public request union.
        await expect(fixture.viewer.call(request as never)).rejects.toThrow(/^Malformed CSV Viewer request\.$/);
      }

      await expect(fixture.viewer.call({ operation: 'csv.open-recent', sourceId }))
        .resolves.toEqual({ status: 'already-open', workingCsv: opened.workingCsv });
      await expect(rows()).resolves.toEqual(before);
    });

    it('accepts explicit undefined fields, NaN number filters, and excess keys as the renderer sends them', async () => {
      const sourceId = await fixture.registerSource('people.csv', 'name,age\nAda,36\nGrace,x\n');
      const opened = await fixture.viewer.call({
        operation: 'csv.open-recent', sourceId, options: { delimiter: undefined, header: undefined },
      });
      if (opened.status !== 'opened') throw new Error(`Open was ${opened.status}.`);
      const request = {
        operation: 'csv.get-rows',
        workingCsvId: opened.workingCsv.workingCsvId,
        offset: 0,
        limit: 10,
        sort: undefined,
        filters: [{ column: 'age', kind: 'number', operator: 'equals', value: Number('x'), valueTo: undefined }],
        search: '',
        rendererOnly: true,
      } as const;
      await expect(fixture.viewer.call(request)).resolves.toMatchObject({ offset: 0, filteredRowCount: 0 });
    });

    it('closes after confirming an impact regardless of its key order, and prompts again when it changes', async () => {
      const baseline = await fixture.openSource('baseline.csv', 'id,value\n1,a\n');
      const candidate = await fixture.openSource('candidate.csv', 'id,value\n1,b\n');
      const workingCsvId = baseline.workingCsvId;
      await fixture.viewer.call({ operation: 'csv.edit-cell', workingCsvId, rowId: '1', column: 'value', value: 'changed' });
      const first = await fixture.viewer.call({ operation: 'csv.close', workingCsvId });
      if (first.status !== 'confirmation-required') throw new Error(`Close was ${first.status}.`);

      const comparison = await fixture.viewer.call({ operation: 'comparison.open', baselineId: workingCsvId, candidateId: candidate.workingCsvId });
      if (comparison.status === 'rejected') throw new Error('Comparison was rejected.');
      const { comparisonId } = comparison.comparison;
      const second = await fixture.viewer.call({ operation: 'csv.close', workingCsvId, confirmedImpact: first.impact });
      expect(second).toEqual({
        status: 'confirmation-required',
        impact: {
          hasUnexportedChanges: true,
          dependentComparisons: [{ comparisonId, baselineName: 'baseline.csv', candidateName: 'candidate.csv' }],
        },
      });

      const reordered = {
        dependentComparisons: [{ candidateName: 'candidate.csv', baselineName: 'baseline.csv', comparisonId }],
        hasUnexportedChanges: true,
      };
      await expect(fixture.viewer.call({ operation: 'csv.close', workingCsvId, confirmedImpact: reordered }))
        .resolves.toEqual({ status: 'closed', closedWorkingCsvId: workingCsvId, closedComparisonIds: [comparisonId] });
    });
  });
}
