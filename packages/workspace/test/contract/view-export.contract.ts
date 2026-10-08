import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceContractFactory, WorkspaceContractFixture } from './workspace-contract';

export function defineViewExportContract(factory: WorkspaceContractFactory): void {
  describe(`${factory.name} Export Current View`, () => {
    let fixture: WorkspaceContractFixture;
    beforeEach(async () => { fixture = await factory.create(); });
    afterEach(async () => { await fixture.dispose(); });

    it('exports the whole matching view in stable sort order and preserves edit history', async () => {
      const csv = await fixture.openSource('view.csv', 'id,team,rank,note\n1,keep,2,first\n2,drop,1,second\n3,keep,1,third\n4,keep,1,fourth\n');
      const workingCsvId = csv.workingCsvId;
      await fixture.viewer.call({ operation: 'csv.rename-column', workingCsvId, column: 'note', name: 'comment' });
      await fixture.viewer.call({ operation: 'csv.insert-column', workingCsvId, column: 'rank', placement: 'after' });
      await fixture.viewer.call({ operation: 'csv.edit-cell', workingCsvId, rowId: '3', column: 'New column', value: '00042' });
      await fixture.viewer.call({ operation: 'csv.edit-cell', workingCsvId, rowId: '3', column: 'comment', value: 'quoted, "note"\nnext' });
      const before = await fixture.editState(workingCsvId);
      const readExported = fixture.captureNextExport('view-output.csv');
      const request = {
        operation: 'csv.export-view', workingCsvId,
        search: 'keep', filters: [{ column: 'rank', kind: 'number', operator: 'lessThan', value: 3 }],
        sort: [{ column: 'rank', direction: 'asc' }],
      } as const;
      await expect(fixture.viewer.call(request)).resolves.toEqual({ status: 'exported', rowCount: 3 });
      await expect(readExported()).resolves.toBe('id,team,rank,New column,comment\n3,keep,1,00042,"quoted, ""note""\nnext"\n4,keep,1,,fourth\n1,keep,2,,first\n');
      await expect(fixture.editState(workingCsvId)).resolves.toEqual(before);
      await expect(fixture.viewer.call({ operation: 'csv.undo', workingCsvId })).resolves.toMatchObject({ hasUnexportedChanges: true, canRedo: true });
      await fixture.viewer.call({ operation: 'csv.redo', workingCsvId });
      await expect(fixture.editState(workingCsvId)).resolves.toEqual(before);
    });

    it('captures prior edits and a stable snapshot before subsequent mutations', async () => {
      const csv = await fixture.openSource('snapshot.csv', 'id,value\n1,before\n');
      const workingCsvId = csv.workingCsvId;
      const prior = fixture.viewer.call({ operation: 'csv.edit-cell', workingCsvId, rowId: '1', column: 'value', value: 'captured' });
      const held = fixture.holdNextExportRead();
      const readExported = fixture.captureNextExport('snapshot-output.csv');
      const exported = fixture.viewer.call({ operation: 'csv.export-view', workingCsvId });
      await held.entered;
      const next = fixture.viewer.call({ operation: 'csv.rename-column', workingCsvId, column: 'value', name: 'renamed' });
      held.release();
      await prior;
      await next;
      await expect(exported).resolves.toEqual({ status: 'exported', rowCount: 1 });
      await expect(readExported()).resolves.toBe('id,value\n1,captured\n');
    });

    it.each(['close', 'reopen'] as const)('cancels preparation when the source will %s', async (action) => {
      const csv = await fixture.openSource('lifecycle.csv', 'id,value\n1,before\n');
      const held = fixture.holdNextExportRead();
      const exported = fixture.viewer.call({ operation: 'csv.export-view', workingCsvId: csv.workingCsvId });
      try {
        await held.entered;
        const result = await fixture.viewer.call({ operation: action === 'close' ? 'csv.close' : 'csv.reopen', workingCsvId: csv.workingCsvId });
        expect(result.status).toBe(action === 'close' ? 'closed' : 'opened');
        await expect(exported).resolves.toEqual({ status: 'cancelled' });
      } finally { held.release(); await exported; }
    });

    it('rejects duplicate exports while a view export prepares', async () => {
      const csv = await fixture.openSource('busy.csv', 'id\n1\n');
      const workingCsvId = csv.workingCsvId;
      const held = fixture.holdNextExportRead();
      const readExported = fixture.captureNextExport('busy-view.csv');
      const exported = fixture.viewer.call({ operation: 'csv.export-view', workingCsvId });
      try {
        await held.entered;
        await expect(fixture.viewer.call({ operation: 'csv.export', workingCsvId })).rejects.toThrow('An export is already in progress');
        await expect(fixture.viewer.call({ operation: 'csv.export-view', workingCsvId })).rejects.toThrow('An export is already in progress');
      } finally { held.release(); }
      await expect(exported).resolves.toEqual({ status: 'exported', rowCount: 1 });
      await expect(readExported()).resolves.toBe('id\n1\n');
    });

    it('does not deliver an empty result and preserves headerless dialect on an unfiltered clean view', async () => {
      const csv = await fixture.openSource('dialect.txt', 'Ada|001\nGrace|002\n', { delimiter: '|', header: false });
      const workingCsvId = csv.workingCsvId;
      const readExported = fixture.captureNextExport('dialect-view.txt');
      await expect(fixture.viewer.call({ operation: 'csv.export-view', workingCsvId, search: 'missing' })).resolves.toEqual({ status: 'empty' });
      await expect(fixture.viewer.call({ operation: 'csv.export-view', workingCsvId })).resolves.toEqual({ status: 'exported', rowCount: 2 });
      await expect(readExported()).resolves.toBe('Ada|001\nGrace|002\n');
      await expect(fixture.editState(workingCsvId)).resolves.toEqual(csv.editState);
    });

    it('settles failed preparation and permits retry using the current view', async () => {
      const csv = await fixture.openSource('failure.tsv', 'id\tvalue\n1\tbefore\n2\tother\n');
      const workingCsvId = csv.workingCsvId;
      const released = fixture.failNextExportPreparation('read');
      await expect(fixture.viewer.call({ operation: 'csv.export-view', workingCsvId })).rejects.toThrow();
      expect(released()).toBe(true);
      await fixture.viewer.call({ operation: 'csv.edit-cell', workingCsvId, rowId: '1', column: 'value', value: 'after' });
      const readExported = fixture.captureNextExport('failure-view.tsv');
      await expect(fixture.viewer.call({ operation: 'csv.export-view', workingCsvId, search: 'after' })).resolves.toEqual({ status: 'exported', rowCount: 1 });
      await expect(readExported()).resolves.toBe('id\tvalue\n1\tafter\n');
    });

    it('reports failed worker cleanup when close cancels preparation and retains ownership until disposal', async () => {
      const csv = await fixture.openSource('cleanup.csv', 'id\n1\n');
      const held = fixture.holdNextExportRead();
      const closed = fixture.failNextExportWorkerRelease(1);
      const readExported = fixture.captureNextExport('not-delivered.csv');
      const exported = fixture.viewer.call({ operation: 'csv.export-view', workingCsvId: csv.workingCsvId });
      try {
        await held.entered;
        // Close waits for the export to settle, so its rejection must already be observed.
        const rejected = expect(exported).rejects.toThrow('The data engine could not complete the operation.');
        await fixture.viewer.call({ operation: 'csv.close', workingCsvId: csv.workingCsvId });
        await rejected;
        await expect(readExported()).rejects.toThrow();
        expect(closed()).toBe(false);
        await fixture.disposeWorkspace();
        expect(closed()).toBe(true);
      } finally { held.release(); await exported.catch(() => undefined); }
    });
  });
}
