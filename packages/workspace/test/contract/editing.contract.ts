import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csvInternalRowIdField, type CsvFilterDescriptor, type CsvRow } from '../../src/csv-viewer';
import {
  expectVisibleRows,
  rowIds,
  type WorkspaceContractFactory,
  type WorkspaceContractFixture,
} from './workspace-contract';

export function defineCsvWorkspaceEditingContract(factory: WorkspaceContractFactory): void {
  describe(`${factory.name} CsvWorkspace editing, history, and Export CSV contract`, () => {
    let fixture: WorkspaceContractFixture;

    beforeEach(async () => {
      fixture = await factory.create();
    });

    afterEach(async () => {
      await fixture.dispose();
    });

    function workspace() {
      return fixture.viewer;
    }

    const people = ['name,team', 'Ada,compiler', 'Grace,navy', 'Linus,kernel'].join('\n');

    async function openPeople(fileName: string) {
      return fixture.openSource(fileName, people);
    }

    async function readRows(
      workingCsvId: string,
      query: {
        sort?: { column: string; direction: 'asc' | 'desc' }[];
        filters?: CsvFilterDescriptor[];
        search?: string;
      } = {},
    ) {
      return workspace().call({
        operation: 'csv.get-rows',
        workingCsvId,
        offset: 0,
        limit: 10,
        ...query,
      });
    }

    it('edits a cell by row identifier and returns edited values in later row windows', async () => {
      const workingCsv = await fixture.openSource('edit.csv', ['name,code', 'Ada,001', 'Grace,002'].join('\n'));
      const firstWindow = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 2,
      });
      const result = await workspace().call({
        operation: 'csv.edit-cell',
        workingCsvId: workingCsv.workingCsvId,
        rowId: firstWindow.rows[1][csvInternalRowIdField],
        column: 'code',
        value: '00042',
      });
      const editedWindow = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 2,
      });

      expect(result).toEqual({
        workingCsvId: workingCsv.workingCsvId,
        rowId: '2',
        column: 'code',
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      });
      expectVisibleRows(editedWindow.rows).toEqual([
        { name: 'Ada', code: '001' },
        { name: 'Grace', code: '00042' },
      ]);
    });

    it('edits the source row selected from a sorted window', async () => {
      const workingCsv = await fixture.openSource(
        'edit-sorted.csv',
        ['name,score', 'Ada,10', 'Grace,30', 'Linus,20'].join('\n'),
      );
      const sorted = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 3,
        sort: [{ column: 'score', direction: 'desc' }],
      });

      await workspace().call({
        operation: 'csv.edit-cell',
        workingCsvId: workingCsv.workingCsvId,
        rowId: sorted.rows[0][csvInternalRowIdField],
        column: 'name',
        value: 'Rear Admiral Grace',
      });
      const sourceOrder = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 3,
      });

      expect(rowIds(sorted.rows)).toEqual(['2', '3', '1']);
      expect(sourceOrder.rows[1].name).toBe('Rear Admiral Grace');
      expect(sourceOrder.rows[0].name).toBe('Ada');
    });

    it('refreshes filtered and searched row windows when an edit changes query membership', async () => {
      const workingCsv = await fixture.openSource(
        'edit-query.csv',
        ['name,team', 'Ada,compiler', 'Grace,navy', 'Linus,kernel'].join('\n'),
      );
      const searched = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 10,
        search: 'navy',
      });

      await workspace().call({
        operation: 'csv.edit-cell',
        workingCsvId: workingCsv.workingCsvId,
        rowId: searched.rows[0][csvInternalRowIdField],
        column: 'team',
        value: 'compiler',
      });
      const filtered = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 10,
        filters: [
          {
            column: 'team',
            kind: 'text',
            operator: 'equals',
            value: 'compiler',
          },
        ],
      });
      const searchedAgain = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 10,
        search: 'navy',
      });

      expect(rowIds(filtered.rows)).toEqual(['1', '2']);
      expect(searchedAgain.filteredRowCount).toBe(0);
      expect(searchedAgain.rows).toEqual([]);
    });

    it('undoes and redoes the most recent cell edit while updating Unexported Changes', async () => {
      const workingCsv = await fixture.openSource('edit-history.csv', ['name,code', 'Ada,001'].join('\n'));
      const request = { workingCsvId: workingCsv.workingCsvId };

      await expect(fixture.editState(workingCsv.workingCsvId)).resolves.toEqual(
        {
          workingCsvId: workingCsv.workingCsvId,
          hasUnexportedChanges: false,
          canUndo: false,
          canRedo: false,
        },
      );

      await workspace().call({
        operation: 'csv.edit-cell',
        ...request,
        rowId: '1',
        column: 'code',
        value: '007',
      });
      await expect(fixture.editState(workingCsv.workingCsvId)).resolves.toEqual(
        {
          workingCsvId: workingCsv.workingCsvId,
          hasUnexportedChanges: true,
          canUndo: true,
          canRedo: false,
        },
      );

      const undone = await workspace().call({
        operation: 'csv.undo',
        ...request,
      });
      const afterUndo = await workspace().call({
        operation: 'csv.get-rows',
        ...request,
        offset: 0,
        limit: 1,
      });

      expect(undone).toEqual({
        workingCsvId: workingCsv.workingCsvId,
        columns: workingCsv.columns,
        hasUnexportedChanges: false,
        canUndo: false,
        canRedo: true,
      });
      expect(afterUndo.rows[0].code).toBe('001');

      const redone = await workspace().call({
        operation: 'csv.redo',
        ...request,
      });
      const afterRedo = await workspace().call({
        operation: 'csv.get-rows',
        ...request,
        offset: 0,
        limit: 1,
      });

      expect(redone).toEqual({
        workingCsvId: workingCsv.workingCsvId,
        columns: workingCsv.columns,
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      });
      expect(afterRedo.rows[0].code).toBe('007');
    });

    it('clears redo history when a new cell edit is made after undo', async () => {
      const workingCsv = await fixture.openSource('edit-redo-clear.csv', ['name,code', 'Ada,001'].join('\n'));
      const request = { workingCsvId: workingCsv.workingCsvId };

      await workspace().call({
        operation: 'csv.edit-cell',
        ...request,
        rowId: '1',
        column: 'code',
        value: '002',
      });
      await workspace().call({ operation: 'csv.undo', ...request });
      await workspace().call({
        operation: 'csv.edit-cell',
        ...request,
        rowId: '1',
        column: 'code',
        value: '003',
      });

      await expect(fixture.editState(workingCsv.workingCsvId)).resolves.toEqual(
        {
          workingCsvId: workingCsv.workingCsvId,
          hasUnexportedChanges: true,
          canUndo: true,
          canRedo: false,
        },
      );
      await expect(
        workspace().call({ operation: 'csv.redo', ...request }),
      ).rejects.toThrow('No CSV edit is available to redo');
    });

    it('deletes one selected source row and excludes it from row windows and counts', async () => {
      const workingCsv = await fixture.openSource(
        'delete-one.csv',
        ['name,team', 'Ada,compiler', 'Grace,navy', 'Linus,kernel'].join('\n'),
      );
      const firstWindow = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 3,
      });
      const result = await workspace().call({
        operation: 'csv.delete-rows',
        workingCsvId: workingCsv.workingCsvId,
        rowIds: [firstWindow.rows[1][csvInternalRowIdField]],
      });
      const afterDelete = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 3,
      });

      expect(result).toEqual({
        workingCsvId: workingCsv.workingCsvId,
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      });
      expect(afterDelete.filteredRowCount).toBe(2);
      expect(rowIds(afterDelete.rows)).toEqual(['1', '3']);
      expectVisibleRows(afterDelete.rows).toEqual([
        { name: 'Ada', team: 'compiler' },
        { name: 'Linus', team: 'kernel' },
      ]);
    });

    it('deletes multiple selected source rows from a sorted window', async () => {
      const workingCsv = await fixture.openSource(
        'delete-many-sorted.csv',
        ['name,score', 'Ada,10', 'Grace,30', 'Linus,20', 'Margaret,40'].join('\n'),
      );
      const sorted = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 4,
        sort: [{ column: 'score', direction: 'desc' }],
      });

      await workspace().call({
        operation: 'csv.delete-rows',
        workingCsvId: workingCsv.workingCsvId,
        rowIds: [
          sorted.rows[0][csvInternalRowIdField],
          sorted.rows[2][csvInternalRowIdField],
        ],
      });
      const sourceOrder = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 4,
      });

      expect(rowIds(sorted.rows)).toEqual(['4', '2', '3', '1']);
      expect(sourceOrder.filteredRowCount).toBe(2);
      expect(rowIds(sourceOrder.rows)).toEqual(['1', '2']);
      expect(sourceOrder.rows.map((row) => row.name)).toEqual(['Ada', 'Grace']);
    });

    it('updates filtered and searched row windows after deleting selected rows', async () => {
      const workingCsv = await fixture.openSource(
        'delete-query.csv',
        [
          'name,team',
          'Ada,compiler',
          'Grace,navy',
          'Linus,kernel',
          'Margaret,compiler',
        ].join('\n'),
      );
      const compilerFilter = [
        { column: 'team', kind: 'text', operator: 'equals', value: 'compiler' },
      ] as const;
      const filtered = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 10,
        filters: [...compilerFilter],
      });

      await workspace().call({
        operation: 'csv.delete-rows',
        workingCsvId: workingCsv.workingCsvId,
        rowIds: [filtered.rows[0][csvInternalRowIdField]],
      });
      const filteredAgain = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 10,
        filters: [...compilerFilter],
      });
      const searched = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 10,
        search: 'Ada',
      });

      expect(rowIds(filtered.rows)).toEqual(['1', '4']);
      expect(filteredAgain.filteredRowCount).toBe(1);
      expect(rowIds(filteredAgain.rows)).toEqual(['4']);
      expect(searched.filteredRowCount).toBe(0);
      expect(searched.rows).toEqual([]);
    });

    it('undoes and redoes row deletion', async () => {
      const workingCsv = await fixture.openSource(
        'delete-history.csv',
        ['name,code', 'Ada,001', 'Grace,002', 'Linus,003'].join('\n'),
      );
      const request = { workingCsvId: workingCsv.workingCsvId };
      await workspace().call({
        operation: 'csv.delete-rows',
        ...request,
        rowIds: ['1', '3'],
      });

      const undone = await workspace().call({
        operation: 'csv.undo',
        ...request,
      });
      const afterUndo = await workspace().call({
        operation: 'csv.get-rows',
        ...request,
        offset: 0,
        limit: 3,
      });
      const redone = await workspace().call({
        operation: 'csv.redo',
        ...request,
      });
      const afterRedo = await workspace().call({
        operation: 'csv.get-rows',
        ...request,
        offset: 0,
        limit: 3,
      });

      expect(undone).toEqual({
        workingCsvId: workingCsv.workingCsvId,
        columns: workingCsv.columns,
        hasUnexportedChanges: false,
        canUndo: false,
        canRedo: true,
      });
      expect(rowIds(afterUndo.rows)).toEqual(['1', '2', '3']);
      expect(redone).toEqual({
        workingCsvId: workingCsv.workingCsvId,
        columns: workingCsv.columns,
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      });
      expect(rowIds(afterRedo.rows)).toEqual(['2']);
    });

    it('rejects row deletion when no valid selected row identifiers are provided', async () => {
      const workingCsv = await fixture.openSource('delete-invalid.csv', ['name', 'Ada'].join('\n'));

      await expect(
        workspace().call({
          operation: 'csv.delete-rows',
          workingCsvId: workingCsv.workingCsvId,
          rowIds: [],
        }),
      ).rejects.toThrow('At least one CSV row must be selected for deletion');
      await expect(
        workspace().call({
          operation: 'csv.delete-rows',
          workingCsvId: workingCsv.workingCsvId,
          rowIds: ['missing'],
        }),
      ).rejects.toThrow('CSV row no longer exists: missing');
    });

    it('inserts empty rows above and below one selected source row', async () => {
      const workingCsv = await fixture.openSource(
        'insert-relative.csv',
        ['name,code', 'Ada,001', 'Grace,002', 'Linus,003'].join('\n'),
      );
      const request = {
        workingCsvId: workingCsv.workingCsvId,
        hasActiveQuery: false,
      };

      await workspace().call({
        operation: 'csv.insert-row',
        ...request,
        placement: 'above',
        rowIds: ['2'],
      });
      await workspace().call({
        operation: 'csv.insert-row',
        ...request,
        placement: 'below',
        rowIds: ['2'],
      });
      const window = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 5,
      });

      expect(window.filteredRowCount).toBe(5);
      expect(rowIds(window.rows)).toEqual(['1', '4', '2', '5', '3']);
      expectVisibleRows(window.rows).toEqual([
        { name: 'Ada', code: '001' },
        { name: '', code: '' },
        { name: 'Grace', code: '002' },
        { name: '', code: '' },
        { name: 'Linus', code: '003' },
      ]);
      await expect(fixture.editState(workingCsv.workingCsvId)).resolves.toEqual(
        {
          workingCsvId: workingCsv.workingCsvId,
          hasUnexportedChanges: true,
          canUndo: true,
          canRedo: false,
        },
      );
    });

    it('inserts relative to the selected source row from a sorted window', async () => {
      const workingCsv = await fixture.openSource(
        'insert-sorted.csv',
        ['name,score', 'Ada,10', 'Grace,30', 'Linus,20'].join('\n'),
      );
      const sorted = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 3,
        sort: [{ column: 'score', direction: 'desc' }],
      });

      await workspace().call({
        operation: 'csv.insert-row',
        workingCsvId: workingCsv.workingCsvId,
        placement: 'below',
        rowIds: [sorted.rows[0][csvInternalRowIdField]],
        hasActiveQuery: true,
      });
      const sourceOrder = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 4,
      });

      expect(rowIds(sorted.rows)).toEqual(['2', '3', '1']);
      expect(rowIds(sourceOrder.rows)).toEqual(['1', '2', '4', '3']);
      expectVisibleRows(sourceOrder.rows).toEqual([
        { name: 'Ada', score: '10' },
        { name: 'Grace', score: '30' },
        { name: '', score: '' },
        { name: 'Linus', score: '20' },
      ]);
    });

    it('inserts relative to the selected source row from a filtered window', async () => {
      const workingCsv = await fixture.openSource(
        'insert-filtered.csv',
        ['name,team', 'Ada,compiler', 'Grace,navy', 'Linus,compiler'].join('\n'),
      );
      const filters: CsvFilterDescriptor[] = [
        { column: 'team', kind: 'text', operator: 'equals', value: 'compiler' },
      ];
      const filtered = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 3,
        filters,
      });

      await workspace().call({
        operation: 'csv.insert-row',
        workingCsvId: workingCsv.workingCsvId,
        placement: 'above',
        rowIds: [filtered.rows[1][csvInternalRowIdField]],
        hasActiveQuery: true,
      });
      const sourceOrder = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 4,
      });
      const filteredAgain = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 4,
        filters,
      });

      expect(rowIds(filtered.rows)).toEqual(['1', '3']);
      expect(rowIds(sourceOrder.rows)).toEqual(['1', '2', '4', '3']);
      expect(rowIds(filteredAgain.rows)).toEqual(['1', '3']);
    });

    it('inserts relative to the selected source row from a searched window', async () => {
      const workingCsv = await fixture.openSource(
        'insert-searched.csv',
        ['name,team', 'Ada,compiler', 'Grace,navy', 'Linus,kernel'].join('\n'),
      );
      const searched = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 3,
        search: 'navy',
      });

      await workspace().call({
        operation: 'csv.insert-row',
        workingCsvId: workingCsv.workingCsvId,
        placement: 'below',
        rowIds: [searched.rows[0][csvInternalRowIdField]],
        hasActiveQuery: true,
      });
      const sourceOrder = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 4,
      });
      const searchedAgain = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 4,
        search: 'navy',
      });

      expect(rowIds(searched.rows)).toEqual(['2']);
      expect(rowIds(sourceOrder.rows)).toEqual(['1', '2', '4', '3']);
      expect(rowIds(searchedAgain.rows)).toEqual(['2']);
    });

    it('appends an empty row when no row is selected', async () => {
      const workingCsv = await fixture.openSource('insert-append.csv', ['name,code', 'Ada,001'].join('\n'));
      const result = await workspace().call({
        operation: 'csv.insert-row',
        workingCsvId: workingCsv.workingCsvId,
        placement: 'append',
        rowIds: [],
        hasActiveQuery: false,
      });
      const window = await workspace().call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 2,
      });

      expect(result).toEqual({
        workingCsvId: workingCsv.workingCsvId,
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      });
      expect(rowIds(window.rows)).toEqual(['1', '2']);
      expectVisibleRows(window.rows).toEqual([
        { name: 'Ada', code: '001' },
        { name: '', code: '' },
      ]);
    });

    it('rejects ambiguous insert requests below the UI boundary', async () => {
      const workingCsv = await fixture.openSource('insert-invalid.csv', ['name', 'Ada', 'Grace'].join('\n'));
      const request = { workingCsvId: workingCsv.workingCsvId };

      await expect(
        workspace().call({
          operation: 'csv.insert-row',
          ...request,
          placement: 'append',
          rowIds: [],
          hasActiveQuery: true,
        }),
      ).rejects.toThrow('cannot be inserted while sort, filter, or search is active');
      await expect(
        workspace().call({
          operation: 'csv.insert-row',
          ...request,
          placement: 'below',
          rowIds: ['1', '2'],
          hasActiveQuery: false,
        }),
      ).rejects.toThrow('requires exactly one selected CSV row');
      await expect(
        workspace().call({
          operation: 'csv.insert-row',
          ...request,
          placement: 'append',
          rowIds: ['1'],
          hasActiveQuery: false,
        }),
      ).rejects.toThrow('Append row requires no selected CSV rows');
      await expect(
        workspace().call({
          operation: 'csv.insert-row',
          ...request,
          placement: 'above',
          rowIds: ['missing'],
          hasActiveQuery: false,
        }),
      ).rejects.toThrow('CSV row no longer exists: missing');
    });

    it('undoes and redoes row insertion', async () => {
      const workingCsv = await fixture.openSource('insert-history.csv', ['name', 'Ada', 'Grace'].join('\n'));
      const request = { workingCsvId: workingCsv.workingCsvId };
      await workspace().call({
        operation: 'csv.insert-row',
        ...request,
        placement: 'below',
        rowIds: ['1'],
        hasActiveQuery: false,
      });

      const afterInsert = await workspace().call({
        operation: 'csv.get-rows',
        ...request,
        offset: 0,
        limit: 3,
      });
      const undone = await workspace().call({
        operation: 'csv.undo',
        ...request,
      });
      const afterUndo = await workspace().call({
        operation: 'csv.get-rows',
        ...request,
        offset: 0,
        limit: 3,
      });
      const redone = await workspace().call({
        operation: 'csv.redo',
        ...request,
      });
      const afterRedo = await workspace().call({
        operation: 'csv.get-rows',
        ...request,
        offset: 0,
        limit: 3,
      });

      expect(rowIds(afterInsert.rows)).toEqual(['1', '3', '2']);
      expect(undone).toEqual({
        workingCsvId: workingCsv.workingCsvId,
        columns: workingCsv.columns,
        hasUnexportedChanges: false,
        canUndo: false,
        canRedo: true,
      });
      expect(rowIds(afterUndo.rows)).toEqual(['1', '2']);
      expect(redone).toEqual({
        workingCsvId: workingCsv.workingCsvId,
        columns: workingCsv.columns,
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      });
      expect(rowIds(afterRedo.rows)).toEqual(['1', '3', '2']);
    });

    it('renames a column header, rejects blank and duplicate names, and restores the name on undo', async () => {
      const workingCsv = await fixture.openSource('rename.csv', ['name,code', 'Ada,001'].join('\n'));
      const request = { workingCsvId: workingCsv.workingCsvId };
      const renamedColumns = [
        { name: 'name', type: workingCsv.columns[0].type },
        { name: 'sku', type: workingCsv.columns[1].type },
      ];

      const sameClean = await workspace().call({
        operation: 'csv.rename-column',
        ...request,
        column: 'code',
        name: 'code',
      });
      expect(sameClean).toEqual({
        workingCsvId: workingCsv.workingCsvId,
        columns: workingCsv.columns,
        hasUnexportedChanges: false,
        canUndo: false,
        canRedo: false,
      });

      const renamed = await workspace().call({
        operation: 'csv.rename-column',
        ...request,
        column: 'code',
        name: 'sku',
      });
      const renamedWindow = await workspace().call({
        operation: 'csv.get-rows',
        ...request,
        offset: 0,
        limit: 1,
      });

      expect(renamed).toEqual({
        workingCsvId: workingCsv.workingCsvId,
        columns: renamedColumns,
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      });
      expect(renamedWindow.rows[0]).toMatchObject({ name: 'Ada', sku: '001' });
      expect(renamedWindow.rows[0]).not.toHaveProperty('code');

      const undone = await workspace().call({ operation: 'csv.undo', ...request });
      const undoneWindow = await workspace().call({
        operation: 'csv.get-rows',
        ...request,
        offset: 0,
        limit: 1,
      });
      expect(undone).toEqual({
        workingCsvId: workingCsv.workingCsvId,
        columns: workingCsv.columns,
        hasUnexportedChanges: false,
        canUndo: false,
        canRedo: true,
      });
      expect(undoneWindow.rows[0]).toMatchObject({ name: 'Ada', code: '001' });

      const redone = await workspace().call({ operation: 'csv.redo', ...request });
      const redoneWindow = await workspace().call({
        operation: 'csv.get-rows',
        ...request,
        offset: 0,
        limit: 1,
      });
      expect(redone).toEqual({
        workingCsvId: workingCsv.workingCsvId,
        columns: renamedColumns,
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      });
      expect(redoneWindow.rows[0]).toMatchObject({ name: 'Ada', sku: '001' });
      expect(redoneWindow.rows[0]).not.toHaveProperty('code');

      await expect(
        workspace().call({
          operation: 'csv.rename-column',
          ...request,
          column: 'sku',
          name: '',
        }),
      ).rejects.toThrow('CSV column name cannot be blank.');
      await expect(
        workspace().call({
          operation: 'csv.rename-column',
          ...request,
          column: 'sku',
          name: '   ',
        }),
      ).rejects.toThrow('CSV column name cannot be blank.');
      await expect(
        workspace().call({
          operation: 'csv.rename-column',
          ...request,
          column: 'sku',
          name: 'name',
        }),
      ).rejects.toThrow('CSV column name already exists.');
      await expect(
        workspace().call({
          operation: 'csv.rename-column',
          ...request,
          column: 'sku',
          name: 'Name',
        }),
      ).rejects.toThrow('CSV column name already exists.');
      await expect(
        workspace().call({
          operation: 'csv.rename-column',
          ...request,
          column: 'sku',
          name: '__csvViewerRowId',
        }),
      ).rejects.toThrow('CSV column name is reserved.');
      await expect(
        workspace().call({
          operation: 'csv.rename-column',
          ...request,
          column: 'sku',
          name: '__CSVVIEWERROWID',
        }),
      ).rejects.toThrow('CSV column name is reserved.');
      await expect(
        workspace().call({
          operation: 'csv.rename-column',
          ...request,
          column: 'sku',
          name: '__csvViewerSourceOrder',
        }),
      ).rejects.toThrow('CSV column name is reserved.');
      await expect(
        workspace().call({
          operation: 'csv.rename-column',
          ...request,
          column: 'sku',
          name: '__csvViewerHidden_1',
        }),
      ).rejects.toThrow('CSV column name is reserved.');
      await expect(
        workspace().call({
          operation: 'csv.rename-column',
          ...request,
          column: 'missing',
          name: 'other',
        }),
      ).rejects.toThrow('Unknown CSV column: missing');

      const sameName = await workspace().call({
        operation: 'csv.rename-column',
        ...request,
        column: 'sku',
        name: 'sku',
      });
      expect(sameName).toEqual(redone);
    });

    it('keeps column order when renaming a middle header', async () => {
      const workingCsv = await fixture.openSource(
        'rename-order.csv',
        ['id,email,status', '1,ada@example.com,active'].join('\n'),
      );
      const request = { workingCsvId: workingCsv.workingCsvId };
      const names = (columns: { name: string }[]) => columns.map((column) => column.name);
      const visibleKeys = (row: CsvRow) => Object.keys(row).filter((key) => key !== csvInternalRowIdField);
      const middleRenamed = [
        { name: 'id', type: workingCsv.columns[0].type },
        { name: 'work_email', type: workingCsv.columns[1].type },
        { name: 'status', type: workingCsv.columns[2].type },
      ];

      expect(names(workingCsv.columns)).toEqual(['id', 'email', 'status']);

      const renamed = await workspace().call({
        operation: 'csv.rename-column',
        ...request,
        column: 'email',
        name: 'work_email',
      });
      const renamedWindow = await workspace().call({
        operation: 'csv.get-rows',
        ...request,
        offset: 0,
        limit: 1,
      });
      expect(names(renamed.columns)).toEqual(['id', 'work_email', 'status']);
      expect(renamed.columns).toEqual(middleRenamed);
      expect(visibleKeys(renamedWindow.rows[0])).toEqual(['id', 'work_email', 'status']);

      const undone = await workspace().call({ operation: 'csv.undo', ...request });
      const undoneWindow = await workspace().call({
        operation: 'csv.get-rows',
        ...request,
        offset: 0,
        limit: 1,
      });
      expect(names(undone.columns)).toEqual(['id', 'email', 'status']);
      expect(visibleKeys(undoneWindow.rows[0])).toEqual(['id', 'email', 'status']);

      const redone = await workspace().call({ operation: 'csv.redo', ...request });
      const redoneWindow = await workspace().call({
        operation: 'csv.get-rows',
        ...request,
        offset: 0,
        limit: 1,
      });
      expect(names(redone.columns)).toEqual(['id', 'work_email', 'status']);
      expect(visibleKeys(redoneWindow.rows[0])).toEqual(['id', 'work_email', 'status']);

      const readExported = fixture.captureNextExport('renamed-order-export.csv');
      await workspace().call({ operation: 'csv.export', ...request });
      expect(await readExported()).toBe(['id,work_email,status', '1,ada@example.com,active', ''].join('\n'));
    });

    it('exports renamed column headers', async () => {
      const workingCsv = await fixture.openSource('rename-export.csv', ['name,code', 'Ada,001'].join('\n'));
      const request = { workingCsvId: workingCsv.workingCsvId };
      const readExported = fixture.captureNextExport('renamed-export.csv');

      await workspace().call({
        operation: 'csv.rename-column',
        ...request,
        column: 'code',
        name: 'sku',
      });
      await workspace().call({ operation: 'csv.export', ...request });
      expect(await readExported()).toBe(['name,sku', 'Ada,001', ''].join('\n'));
    });

    it('exports literal bytes for headers, quoting, null and empty cells, edits, row order, and deletions', async () => {
      const workingCsv = await fixture.openSource(
        'export-source.csv',
        [
          'name,code,note',
          'Ada,001,',
          'Grace,002,second',
          'Linus,003,third',
        ].join('\n'),
      );
      const request = { workingCsvId: workingCsv.workingCsvId };
      const readExported = fixture.captureNextExport('exported.csv');

      await workspace().call({
        operation: 'csv.edit-cell',
        ...request,
        rowId: '2',
        column: 'code',
        value: '00042',
      });
      await workspace().call({
        operation: 'csv.insert-row',
        ...request,
        placement: 'below',
        rowIds: ['1'],
        hasActiveQuery: false,
      });
      await workspace().call({
        operation: 'csv.edit-cell',
        ...request,
        rowId: '4',
        column: 'name',
        value: 'New, "Person"',
      });
      await workspace().call({
        operation: 'csv.delete-rows',
        ...request,
        rowIds: ['3'],
      });

      const state = await workspace().call({
        operation: 'csv.export',
        ...request,
      });
      const exported = await readExported();

      expect(exported).toBe(
        [
          'name,code,note',
          'Ada,001,',
          '"New, ""Person""",,',
          'Grace,00042,second',
          '',
        ].join('\n'),
      );
      expect(exported).not.toContain(csvInternalRowIdField);
      expect(state).toEqual({
        status: 'exported',
        editState: {
          workingCsvId: workingCsv.workingCsvId,
          hasUnexportedChanges: false,
          canUndo: true,
          canRedo: false,
        },
      });
    });

    it('exports delimiter and header settings from the active dialect', async () => {
      const workingCsv = await fixture.openSource(
        'export-no-header.txt',
        ['Ada|37', 'Grace|41'].join('\n'),
        {
          delimiter: '|',
          header: false,
        },
      );
      const readExported = fixture.captureNextExport('exported-no-header.txt');

      await workspace().call({
        operation: 'csv.edit-cell',
        workingCsvId: workingCsv.workingCsvId,
        rowId: '1',
        column: 'column1',
        value: '38',
      });
      await workspace().call({
        operation: 'csv.export',
        workingCsvId: workingCsv.workingCsvId,
      });

      await expect(readExported()).resolves.toBe(['Ada|38', 'Grace|41', ''].join('\n'));
    });

    it('defaults a TSV export to tab delimiters', async () => {
      const workingCsv = await fixture.openSource('export-tabs.tsv', ['name\tage', 'Ada\t37'].join('\n'));
      const readExported = fixture.captureNextExport('exported-tabs.tsv');

      await workspace().call({
        operation: 'csv.export',
        workingCsvId: workingCsv.workingCsvId,
      });

      await expect(readExported()).resolves.toBe(['name\tage', 'Ada\t37', ''].join('\n'));
    });

    it('keeps Unexported Changes when Export CSV is cancelled', async () => {
      const workingCsv = await fixture.openSource('export-cancelled.csv', ['name', 'Ada'].join('\n'));
      await workspace().call({
        operation: 'csv.edit-cell',
        workingCsvId: workingCsv.workingCsvId,
        rowId: '1',
        column: 'name',
        value: 'Grace',
      });

      await expect(
        workspace().call({
          operation: 'csv.export',
          workingCsvId: workingCsv.workingCsvId,
        }),
      ).resolves.toEqual({
        status: 'cancelled',
      });
      await expect(fixture.editState(workingCsv.workingCsvId)).resolves.toMatchObject({
        hasUnexportedChanges: true,
      });
    });

    it('tracks Unexported Changes by revision identity while preserving edit history', async () => {
      const workingCsv = await fixture.openSource('export-revisions.csv', ['name,code', 'Ada,001'].join('\n'));
      const request = { workingCsvId: workingCsv.workingCsvId };
      fixture.captureNextExport('exported.csv');

      await workspace().call({
        operation: 'csv.edit-cell',
        ...request,
        rowId: '1',
        column: 'code',
        value: '002',
      });
      await expect(workspace().call({ operation: 'csv.export', ...request })).resolves.toEqual({
        status: 'exported',
        editState: {
          workingCsvId: workingCsv.workingCsvId,
          hasUnexportedChanges: false,
          canUndo: true,
          canRedo: false,
        },
      });
      await expect(workspace().call({ operation: 'csv.undo', ...request })).resolves.toMatchObject({
        hasUnexportedChanges: true,
        canUndo: false,
        canRedo: true,
      });
      await expect(workspace().call({ operation: 'csv.redo', ...request })).resolves.toMatchObject({
        hasUnexportedChanges: false,
        canUndo: true,
        canRedo: false,
      });

      await workspace().call({ operation: 'csv.undo', ...request });
      await expect(
        workspace().call({
          operation: 'csv.edit-cell',
          ...request,
          rowId: '1',
          column: 'code',
          value: '003',
        }),
      ).resolves.toMatchObject({
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      });
    });

    it('preserves redo history when Export CSV establishes an undone revision as exported', async () => {
      const workingCsv = await fixture.openSource('export-redo.csv', ['name,code', 'Ada,001'].join('\n'));
      const request = { workingCsvId: workingCsv.workingCsvId };
      fixture.captureNextExport('exported-undone-revision.csv');

      await workspace().call({
        operation: 'csv.edit-cell',
        ...request,
        rowId: '1',
        column: 'code',
        value: '002',
      });
      await workspace().call({ operation: 'csv.undo', ...request });

      await expect(workspace().call({ operation: 'csv.export', ...request })).resolves.toMatchObject({
        status: 'exported',
        editState: {
          hasUnexportedChanges: false,
          canUndo: false,
          canRedo: true,
        },
      });
      await expect(workspace().call({ operation: 'csv.redo', ...request })).resolves.toMatchObject({
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      });
    });

    it('rejects unknown Working CSVs and oversized row windows', async () => {
      const workingCsv = await fixture.openSource('windows.csv', ['value', '1'].join('\n'));

      await expect(
        workspace().call({
          operation: 'csv.get-rows',
          workingCsvId: 'unknown-workingCsv',
          offset: 0,
          limit: 1,
        }),
      ).rejects.toThrow('Working CSV is no longer active');
      await expect(
        workspace().call({
          operation: 'csv.get-rows',
          workingCsvId: workingCsv.workingCsvId,
          offset: 0,
          limit: 1001,
        }),
      ).rejects.toThrow('1000 or less');
    });

    it('returns a clear error for missing CSV Sources without keeping a Working CSV', async () => {
      const sourceId = await fixture.registerSource('missing.csv', 'value\n1\n');
      await fixture.removeSource('missing.csv');
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      await expect(workspace().call({ operation: 'csv.open-recent', sourceId: sourceId })).resolves.toMatchObject({
        status: 'failed',
        message: expect.stringContaining('Unable to open CSV'),
      });
      error.mockRestore();
    });

    it('keeps large CSV Source access bounded after edits, inserts, and deletes', async () => {
      const workingCsv = await fixture.openSource('large-edited.csv', buildLargeCsv());
      const request = { workingCsvId: workingCsv.workingCsvId };

      await workspace().call({
        operation: 'csv.edit-cell',
        ...request,
        rowId: '4901',
        column: 'name',
        value: 'Edited Person',
      });
      await workspace().call({
        operation: 'csv.insert-row',
        ...request,
        placement: 'below',
        rowIds: ['4901'],
        hasActiveQuery: false,
      });
      await workspace().call({
        operation: 'csv.delete-rows',
        ...request,
        rowIds: ['4902', '4903'],
      });

      const window = await workspace().call({
        operation: 'csv.get-rows',
        ...request,
        offset: 4899,
        limit: 5,
      });

      expect(workingCsv.rowCount).toBe(5000);
      expect(window.filteredRowCount).toBe(4999);
      expect(window.rows).toHaveLength(5);
      expect(rowIds(window.rows)).toEqual([
        '4900',
        '4901',
        '5001',
        '4904',
        '4905',
      ]);
      expect(window.rows[0]).toEqual({
        [csvInternalRowIdField]: '4900',
        id: '4899',
        name: 'Person 4899',
        score: '99',
      });
      expect(window.rows[1].name).toBe('Edited Person');
      expect(window.rows[2]).toMatchObject({ id: '', name: '', score: '' });
    });

    it('returns a distinct error for unsupported CSV Sources', async () => {
      const sourceId = await fixture.registerSource('people.json', '{"name":"Ada"}');
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      await expect(workspace().call({ operation: 'csv.open-recent', sourceId: sourceId })).resolves.toMatchObject({
        status: 'failed',
        message: expect.stringContaining('Unsupported file type'),
      });
      error.mockRestore();
    });

    describe('concurrent CSV mutations', () => {
      it('gives every concurrently inserted row its own identifier and position', async () => {
        const workingCsv = await fixture.openSource('insert-concurrent.csv', ['name', 'Ada'].join('\n'));
        const request = {
          workingCsvId: workingCsv.workingCsvId,
          hasActiveQuery: false,
        };

        await Promise.all([
          workspace().call({
            operation: 'csv.insert-row',
            ...request,
            placement: 'append',
            rowIds: [],
          }),
          workspace().call({
            operation: 'csv.insert-row',
            ...request,
            placement: 'append',
            rowIds: [],
          }),
          workspace().call({
            operation: 'csv.insert-row',
            ...request,
            placement: 'append',
            rowIds: [],
          }),
        ]);

        const window = await workspace().call({
          operation: 'csv.get-rows',
          workingCsvId: workingCsv.workingCsvId,
          offset: 0,
          limit: 10,
        });
        const insertedRowIds = rowIds(window.rows);
        expect(insertedRowIds).toHaveLength(4);
        expect(new Set(insertedRowIds).size).toBe(4);
        expectVisibleRows(window.rows).toEqual([
          { name: 'Ada' },
          { name: '' },
          { name: '' },
          { name: '' },
        ]);
      });

      it('steps back one edit per concurrent undo', async () => {
        const workingCsv = await fixture.openSource('undo-concurrent.csv', ['name,code', 'Ada,001'].join('\n'));
        const request = { workingCsvId: workingCsv.workingCsvId };
        await workspace().call({
          operation: 'csv.edit-cell',
          ...request,
          rowId: '1',
          column: 'code',
          value: '002',
        });
        await workspace().call({
          operation: 'csv.edit-cell',
          ...request,
          rowId: '1',
          column: 'code',
          value: '003',
        });

        await Promise.all([
          workspace().call({ operation: 'csv.undo', ...request }),
          workspace().call({ operation: 'csv.undo', ...request }),
        ]);

        await expect(fixture.editState(workingCsv.workingCsvId)).resolves.toMatchObject({
          canUndo: false,
          canRedo: true,
        });
        const window = await workspace().call({
          operation: 'csv.get-rows',
          ...request,
          offset: 0,
          limit: 10,
        });
        expectVisibleRows(window.rows).toEqual([{ name: 'Ada', code: '001' }]);

        await workspace().call({ operation: 'csv.redo', ...request });
        await workspace().call({ operation: 'csv.redo', ...request });
        const redone = await workspace().call({
          operation: 'csv.get-rows',
          ...request,
          offset: 0,
          limit: 10,
        });
        expectVisibleRows(redone.rows).toEqual([{ name: 'Ada', code: '003' }]);
      });
    });

    it('inserts a column after an anchor with empty cells, then removes and restores it', async () => {
      const workingCsv = await openPeople('insert-after.csv');
      const request = { workingCsvId: workingCsv.workingCsvId };
      const insertedColumns = [
        workingCsv.columns[0],
        { name: 'New column', type: 'VARCHAR' },
        workingCsv.columns[1],
      ];

      const inserted = await workspace().call({
        operation: 'csv.insert-column',
        ...request,
        column: 'name',
        placement: 'after',
      });
      const insertedWindow = await readRows(workingCsv.workingCsvId);

      expect(inserted).toEqual({
        workingCsvId: workingCsv.workingCsvId,
        columns: insertedColumns,
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      });
      expectVisibleRows(insertedWindow.rows).toEqual([
        { name: 'Ada', 'New column': '', team: 'compiler' },
        { name: 'Grace', 'New column': '', team: 'navy' },
        { name: 'Linus', 'New column': '', team: 'kernel' },
      ]);
      expect(rowIds(insertedWindow.rows)).toEqual(['1', '2', '3']);

      const undone = await workspace().call({ operation: 'csv.undo', ...request });
      const undoneWindow = await readRows(workingCsv.workingCsvId);
      expect(undone.columns).toEqual(workingCsv.columns);
      expect(undone).toMatchObject({ hasUnexportedChanges: false, canUndo: false, canRedo: true });
      expectVisibleRows(undoneWindow.rows).toEqual([
        { name: 'Ada', team: 'compiler' },
        { name: 'Grace', team: 'navy' },
        { name: 'Linus', team: 'kernel' },
      ]);

      const redone = await workspace().call({ operation: 'csv.redo', ...request });
      const redoneWindow = await readRows(workingCsv.workingCsvId);
      expect(redone.columns).toEqual(insertedColumns);
      expectVisibleRows(redoneWindow.rows).toEqual([
        { name: 'Ada', 'New column': '', team: 'compiler' },
        { name: 'Grace', 'New column': '', team: 'navy' },
        { name: 'Linus', 'New column': '', team: 'kernel' },
      ]);

      const readExported = fixture.captureNextExport('insert-after-export.csv');
      await workspace().call({ operation: 'csv.export', ...request });
      expect(await readExported()).toBe(
        ['name,New column,team', 'Ada,,compiler', 'Grace,,navy', 'Linus,,kernel', ''].join('\n'),
      );
    });

    it('inserts before the first header and skips a taken default name', async () => {
      const workingCsv = await openPeople('insert-before.csv');
      const request = { workingCsvId: workingCsv.workingCsvId };

      const first = await workspace().call({
        operation: 'csv.insert-column',
        ...request,
        column: 'name',
        placement: 'before',
      });
      expect(first.columns.map((column) => column.name)).toEqual(['New column', 'name', 'team']);
      expect(first.columns[0]).toEqual({ name: 'New column', type: 'VARCHAR' });

      const second = await workspace().call({
        operation: 'csv.insert-column',
        ...request,
        column: 'name',
        placement: 'before',
      });
      expect(second.columns.map((column) => column.name)).toEqual(['New column', 'New column 2', 'name', 'team']);
      expect(second.columns[1]).toEqual({ name: 'New column 2', type: 'VARCHAR' });

      const taken = await fixture.openSource(
        'insert-taken-name.csv',
        ['new column,team', 'Ada,compiler'].join('\n'),
      );
      const takenInsert = await workspace().call({
        operation: 'csv.insert-column',
        workingCsvId: taken.workingCsvId,
        column: 'new column',
        placement: 'before',
      });
      expect(takenInsert.columns.map((column) => column.name)).toEqual(['New column 2', 'new column', 'team']);
      expect(takenInsert.columns[0].type).toBe('VARCHAR');
    });

    it('writes an empty cell in a new column when a row is inserted afterwards', async () => {
      const workingCsv = await openPeople('insert-column-then-row.csv');
      const request = { workingCsvId: workingCsv.workingCsvId };

      await workspace().call({
        operation: 'csv.insert-column',
        ...request,
        column: 'team',
        placement: 'after',
      });
      await workspace().call({
        operation: 'csv.insert-row',
        ...request,
        placement: 'append',
        rowIds: [],
        hasActiveQuery: false,
      });
      const window = await readRows(workingCsv.workingCsvId);

      expectVisibleRows(window.rows).toEqual([
        { name: 'Ada', team: 'compiler', 'New column': '' },
        { name: 'Grace', team: 'navy', 'New column': '' },
        { name: 'Linus', team: 'kernel', 'New column': '' },
        { name: '', team: '', 'New column': '' },
      ]);
    });

    it('returns fewer rows when a search matched only the deleted column', async () => {
      const workingCsv = await openPeople('delete-search.csv');
      const request = { workingCsvId: workingCsv.workingCsvId };

      const before = await readRows(workingCsv.workingCsvId, { search: 'navy' });
      await workspace().call({ operation: 'csv.delete-column', ...request, column: 'team' });
      const after = await readRows(workingCsv.workingCsvId, { search: 'navy' });

      expect(rowIds(before.rows)).toEqual(['2']);
      expect(before.filteredRowCount).toBe(1);
      expect(after.filteredRowCount).toBe(0);
      expect(after.rows).toEqual([]);
    });

    it('restores an edited cell when the column delete is undone, then walks the pair', async () => {
      const workingCsv = await openPeople('delete-edited.csv');
      const request = { workingCsvId: workingCsv.workingCsvId };

      await workspace().call({
        operation: 'csv.edit-cell',
        ...request,
        rowId: '1',
        column: 'team',
        value: 'compilers',
      });
      await workspace().call({ operation: 'csv.delete-column', ...request, column: 'team' });

      await workspace().call({ operation: 'csv.undo', ...request });
      const restored = await readRows(workingCsv.workingCsvId);
      expectVisibleRows(restored.rows).toEqual([
        { name: 'Ada', team: 'compilers' },
        { name: 'Grace', team: 'navy' },
        { name: 'Linus', team: 'kernel' },
      ]);

      await workspace().call({ operation: 'csv.undo', ...request });
      const original = await readRows(workingCsv.workingCsvId);
      expectVisibleRows(original.rows).toEqual([
        { name: 'Ada', team: 'compiler' },
        { name: 'Grace', team: 'navy' },
        { name: 'Linus', team: 'kernel' },
      ]);

      await workspace().call({ operation: 'csv.redo', ...request });
      const reedited = await readRows(workingCsv.workingCsvId);
      expectVisibleRows(reedited.rows).toEqual([
        { name: 'Ada', team: 'compilers' },
        { name: 'Grace', team: 'navy' },
        { name: 'Linus', team: 'kernel' },
      ]);

      const removed = await workspace().call({ operation: 'csv.redo', ...request });
      const removedWindow = await readRows(workingCsv.workingCsvId);
      expect(removed.columns.map((column) => column.name)).toEqual(['name']);
      expectVisibleRows(removedWindow.rows).toEqual([{ name: 'Ada' }, { name: 'Grace' }, { name: 'Linus' }]);
    });

    it('restores a source null when a deleted column is undone', async () => {
      const workingCsv = await fixture.openSource(
        'delete-null.csv',
        ['name,note,team', 'Ada,,compiler', 'Grace,kept,navy'].join('\n'),
      );
      const request = { workingCsvId: workingCsv.workingCsvId };

      const before = await readRows(workingCsv.workingCsvId);
      expect(before.rows[0].note).toBeNull();

      await workspace().call({ operation: 'csv.delete-column', ...request, column: 'note' });
      await workspace().call({ operation: 'csv.undo', ...request });
      const restored = await readRows(workingCsv.workingCsvId);

      expectVisibleRows(restored.rows).toEqual([
        { name: 'Ada', note: null, team: 'compiler' },
        { name: 'Grace', note: 'kept', team: 'navy' },
      ]);
    });

    it('replays a column insert and a cell edit so the column returns blank before the edit', async () => {
      const workingCsv = await openPeople('insert-edit-replay.csv');
      const request = { workingCsvId: workingCsv.workingCsvId };

      await workspace().call({
        operation: 'csv.insert-column',
        ...request,
        column: 'name',
        placement: 'after',
      });
      await workspace().call({
        operation: 'csv.edit-cell',
        ...request,
        rowId: '1',
        column: 'New column',
        value: 'x',
      });

      await workspace().call({ operation: 'csv.undo', ...request });
      const blank = await readRows(workingCsv.workingCsvId);
      expect(blank.rows[0]['New column']).toBe('');

      await workspace().call({ operation: 'csv.undo', ...request });
      const absent = await readRows(workingCsv.workingCsvId);
      expectVisibleRows(absent.rows).toEqual([
        { name: 'Ada', team: 'compiler' },
        { name: 'Grace', team: 'navy' },
        { name: 'Linus', team: 'kernel' },
      ]);

      await workspace().call({ operation: 'csv.redo', ...request });
      const returned = await readRows(workingCsv.workingCsvId);
      expectVisibleRows(returned.rows).toEqual([
        { name: 'Ada', 'New column': '', team: 'compiler' },
        { name: 'Grace', 'New column': '', team: 'navy' },
        { name: 'Linus', 'New column': '', team: 'kernel' },
      ]);

      await workspace().call({ operation: 'csv.redo', ...request });
      const edited = await readRows(workingCsv.workingCsvId);
      expectVisibleRows(edited.rows).toEqual([
        { name: 'Ada', 'New column': 'x', team: 'compiler' },
        { name: 'Grace', 'New column': '', team: 'navy' },
        { name: 'Linus', 'New column': '', team: 'kernel' },
      ]);
    });

    it('restores a deleted column after a rename reused its name', async () => {
      const workingCsv = await openPeople('delete-then-rename.csv');
      const request = { workingCsvId: workingCsv.workingCsvId };

      await workspace().call({ operation: 'csv.delete-column', ...request, column: 'team' });
      const renamed = await workspace().call({
        operation: 'csv.rename-column',
        ...request,
        column: 'name',
        name: 'team',
      });
      expect(renamed.columns.map((column) => column.name)).toEqual(['team']);

      const undoneRename = await workspace().call({ operation: 'csv.undo', ...request });
      expect(undoneRename.columns.map((column) => column.name)).toEqual(['name']);

      await workspace().call({ operation: 'csv.undo', ...request });
      const restored = await readRows(workingCsv.workingCsvId);
      expectVisibleRows(restored.rows).toEqual([
        { name: 'Ada', team: 'compiler' },
        { name: 'Grace', team: 'navy' },
        { name: 'Linus', team: 'kernel' },
      ]);
    });

    it('restores two deleted middle columns to their original indexes', async () => {
      const workingCsv = await fixture.openSource(
        'delete-middle.csv',
        ['name,left,right,team', 'Ada,L1,R1,compiler', 'Grace,L2,R2,navy'].join('\n'),
      );
      const request = { workingCsvId: workingCsv.workingCsvId };

      await workspace().call({ operation: 'csv.delete-column', ...request, column: 'left' });
      await workspace().call({ operation: 'csv.delete-column', ...request, column: 'right' });
      const removed = await readRows(workingCsv.workingCsvId);
      expectVisibleRows(removed.rows).toEqual([
        { name: 'Ada', team: 'compiler' },
        { name: 'Grace', team: 'navy' },
      ]);

      const firstUndo = await workspace().call({ operation: 'csv.undo', ...request });
      const rightBack = await readRows(workingCsv.workingCsvId);
      expect(firstUndo.columns.map((column) => column.name)).toEqual(['name', 'right', 'team']);
      expectVisibleRows(rightBack.rows).toEqual([
        { name: 'Ada', right: 'R1', team: 'compiler' },
        { name: 'Grace', right: 'R2', team: 'navy' },
      ]);

      const secondUndo = await workspace().call({ operation: 'csv.undo', ...request });
      const bothBack = await readRows(workingCsv.workingCsvId);
      expect(secondUndo.columns.map((column) => column.name)).toEqual(['name', 'left', 'right', 'team']);
      expectVisibleRows(bothBack.rows).toEqual([
        { name: 'Ada', left: 'L1', right: 'R1', team: 'compiler' },
        { name: 'Grace', left: 'L2', right: 'R2', team: 'navy' },
      ]);
    });

    it('rejects deleting the last column and leaves history unchanged', async () => {
      const workingCsv = await fixture.openSource('delete-last.csv', ['name', 'Ada', 'Grace'].join('\n'));
      const request = { workingCsvId: workingCsv.workingCsvId };
      const before = await fixture.editState(workingCsv.workingCsvId);

      await expect(
        workspace().call({ operation: 'csv.delete-column', ...request, column: 'name' }),
      ).rejects.toThrow('The last CSV column cannot be deleted.');

      await expect(fixture.editState(workingCsv.workingCsvId)).resolves.toEqual(before);
      const searched = await readRows(workingCsv.workingCsvId, { search: 'Ada' });
      expectVisibleRows(searched.rows).toEqual([{ name: 'Ada' }]);
      expect(searched.filteredRowCount).toBe(1);
    });

    it('rejects unknown insert and delete targets and leaves history unchanged', async () => {
      const workingCsv = await openPeople('unknown-column.csv');
      const request = { workingCsvId: workingCsv.workingCsvId };
      const before = await fixture.editState(workingCsv.workingCsvId);

      await expect(
        workspace().call({
          operation: 'csv.insert-column',
          ...request,
          column: 'missing',
          placement: 'after',
        }),
      ).rejects.toThrow('Unknown CSV column: missing');
      await expect(
        workspace().call({ operation: 'csv.delete-column', ...request, column: 'missing' }),
      ).rejects.toThrow('Unknown CSV column: missing');

      await expect(fixture.editState(workingCsv.workingCsvId)).resolves.toEqual(before);
      const window = await readRows(workingCsv.workingCsvId);
      expectVisibleRows(window.rows).toEqual([
        { name: 'Ada', team: 'compiler' },
        { name: 'Grace', team: 'navy' },
        { name: 'Linus', team: 'kernel' },
      ]);
    });

    it('restores pre-delete cells after an inserted row is undone', async () => {
      const workingCsv = await openPeople('delete-then-insert-row.csv');
      const request = { workingCsvId: workingCsv.workingCsvId };

      await workspace().call({ operation: 'csv.delete-column', ...request, column: 'team' });
      await workspace().call({
        operation: 'csv.insert-row',
        ...request,
        placement: 'append',
        rowIds: [],
        hasActiveQuery: false,
      });
      await workspace().call({ operation: 'csv.undo', ...request });
      await workspace().call({ operation: 'csv.undo', ...request });
      const restored = await readRows(workingCsv.workingCsvId);

      expect(rowIds(restored.rows)).toEqual(['1', '2', '3']);
      expectVisibleRows(restored.rows).toEqual([
        { name: 'Ada', team: 'compiler' },
        { name: 'Grace', team: 'navy' },
        { name: 'Linus', team: 'kernel' },
      ]);
    });

    it('restores an inserted column as empty after a row inserted while it was hidden is undone', async () => {
      const workingCsv = await openPeople('insert-delete-insert-row.csv');
      const request = { workingCsvId: workingCsv.workingCsvId };

      await workspace().call({
        operation: 'csv.insert-column',
        ...request,
        column: 'name',
        placement: 'after',
      });
      await workspace().call({ operation: 'csv.delete-column', ...request, column: 'New column' });
      await workspace().call({
        operation: 'csv.insert-row',
        ...request,
        placement: 'append',
        rowIds: [],
        hasActiveQuery: false,
      });
      await workspace().call({ operation: 'csv.undo', ...request });
      await workspace().call({ operation: 'csv.undo', ...request });
      const restored = await readRows(workingCsv.workingCsvId);

      expect(rowIds(restored.rows)).toEqual(['1', '2', '3']);
      expectVisibleRows(restored.rows).toEqual([
        { name: 'Ada', 'New column': '', team: 'compiler' },
        { name: 'Grace', 'New column': '', team: 'navy' },
        { name: 'Linus', 'New column': '', team: 'kernel' },
      ]);
    });

    it('omits a deleted column from export and writes its original cells after undo', async () => {
      const workingCsv = await openPeople('delete-export.csv');
      const request = { workingCsvId: workingCsv.workingCsvId };

      await workspace().call({ operation: 'csv.delete-column', ...request, column: 'team' });
      const readDeleted = fixture.captureNextExport('deleted-columns.csv');
      await workspace().call({ operation: 'csv.export', ...request });
      expect(await readDeleted()).toBe(['name', 'Ada', 'Grace', 'Linus', ''].join('\n'));

      await workspace().call({ operation: 'csv.undo', ...request });
      const readRestored = fixture.captureNextExport('restored-columns.csv');
      await workspace().call({ operation: 'csv.export', ...request });
      expect(await readRestored()).toBe(
        ['name,team', 'Ada,compiler', 'Grace,navy', 'Linus,kernel', ''].join('\n'),
      );
    });
  });

  function buildLargeCsv(): string {
    const rows = ['id,name,score'];
    for (let index = 0; index < 5000; index += 1) {
      rows.push(`${index},Person ${index},${index % 100}`);
    }
    return rows.join('\n');
  }
}
