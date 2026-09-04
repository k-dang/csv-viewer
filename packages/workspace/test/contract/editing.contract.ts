import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csvInternalRowIdField } from '../../src/contracts/csv-viewer';
import {
  expectVisibleRows,
  rowIds,
  type WorkspaceContractFactory,
  type WorkspaceContractFixture,
} from './workspace-contract';

export function defineCsvWorkspaceEditingContract(
  factory: WorkspaceContractFactory,
): void {
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

    it('edits a cell by row identifier and returns edited values in later row windows', async () => {
      const workingCsv = await fixture.openSource(
        'edit.csv',
        ['name,code', 'Ada,001', 'Grace,002'].join('\n'),
      );
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
      const workingCsv = await fixture.openSource(
        'edit-history.csv',
        ['name,code', 'Ada,001'].join('\n'),
      );
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
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      });
      expect(afterRedo.rows[0].code).toBe('007');
    });

    it('clears redo history when a new cell edit is made after undo', async () => {
      const workingCsv = await fixture.openSource(
        'edit-redo-clear.csv',
        ['name,code', 'Ada,001'].join('\n'),
      );
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
        ['name,score', 'Ada,10', 'Grace,30', 'Linus,20', 'Margaret,40'].join(
          '\n',
        ),
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
        hasUnexportedChanges: false,
        canUndo: false,
        canRedo: true,
      });
      expect(rowIds(afterUndo.rows)).toEqual(['1', '2', '3']);
      expect(redone).toEqual({
        workingCsvId: workingCsv.workingCsvId,
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      });
      expect(rowIds(afterRedo.rows)).toEqual(['2']);
    });

    it('rejects row deletion when no valid selected row identifiers are provided', async () => {
      const workingCsv = await fixture.openSource(
        'delete-invalid.csv',
        ['name', 'Ada'].join('\n'),
      );

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

    it('appends an empty row when no row is selected', async () => {
      const workingCsv = await fixture.openSource(
        'insert-append.csv',
        ['name,code', 'Ada,001'].join('\n'),
      );
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
      const workingCsv = await fixture.openSource(
        'insert-invalid.csv',
        ['name', 'Ada', 'Grace'].join('\n'),
      );
      const request = { workingCsvId: workingCsv.workingCsvId };

      await expect(
        workspace().call({
          operation: 'csv.insert-row',
          ...request,
          placement: 'above',
          rowIds: ['1'],
          hasActiveQuery: true,
        }),
      ).rejects.toThrow(
        'cannot be inserted while sort, filter, or search is active',
      );
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
      const workingCsv = await fixture.openSource(
        'insert-history.csv',
        ['name', 'Ada', 'Grace'].join('\n'),
      );
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
        hasUnexportedChanges: false,
        canUndo: false,
        canRedo: true,
      });
      expect(rowIds(afterUndo.rows)).toEqual(['1', '2']);
      expect(redone).toEqual({
        workingCsvId: workingCsv.workingCsvId,
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      });
      expect(rowIds(afterRedo.rows)).toEqual(['1', '3', '2']);
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

      await expect(readExported()).resolves.toBe(
        ['Ada|38', 'Grace|41', ''].join('\n'),
      );
    });

    it('defaults a TSV export to tab delimiters', async () => {
      const workingCsv = await fixture.openSource(
        'export-tabs.tsv',
        ['name\tage', 'Ada\t37'].join('\n'),
      );
      const readExported = fixture.captureNextExport('exported-tabs.tsv');

      await workspace().call({
        operation: 'csv.export',
        workingCsvId: workingCsv.workingCsvId,
      });

      await expect(readExported()).resolves.toBe(
        ['name\tage', 'Ada\t37', ''].join('\n'),
      );
    });

    it('keeps Unexported Changes when Export CSV is cancelled', async () => {
      const workingCsv = await fixture.openSource(
        'export-cancelled.csv',
        ['name', 'Ada'].join('\n'),
      );
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
      await expect(
        fixture.editState(workingCsv.workingCsvId),
      ).resolves.toMatchObject({
        hasUnexportedChanges: true,
      });
    });

    it('tracks Unexported Changes by revision identity while preserving edit history', async () => {
      const workingCsv = await fixture.openSource(
        'export-revisions.csv',
        ['name,code', 'Ada,001'].join('\n'),
      );
      const request = { workingCsvId: workingCsv.workingCsvId };
      fixture.captureNextExport('exported.csv');

      await workspace().call({
        operation: 'csv.edit-cell',
        ...request,
        rowId: '1',
        column: 'code',
        value: '002',
      });
      await expect(
        workspace().call({ operation: 'csv.export', ...request }),
      ).resolves.toEqual({
        status: 'exported',
        editState: {
          workingCsvId: workingCsv.workingCsvId,
          hasUnexportedChanges: false,
          canUndo: true,
          canRedo: false,
        },
      });
      await expect(
        workspace().call({ operation: 'csv.undo', ...request }),
      ).resolves.toMatchObject({
        hasUnexportedChanges: true,
        canUndo: false,
        canRedo: true,
      });
      await expect(
        workspace().call({ operation: 'csv.redo', ...request }),
      ).resolves.toMatchObject({
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
      const workingCsv = await fixture.openSource(
        'export-redo.csv',
        ['name,code', 'Ada,001'].join('\n'),
      );
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

      await expect(
        workspace().call({ operation: 'csv.export', ...request }),
      ).resolves.toMatchObject({
        status: 'exported',
        editState: {
          hasUnexportedChanges: false,
          canUndo: false,
          canRedo: true,
        },
      });
      await expect(
        workspace().call({ operation: 'csv.redo', ...request }),
      ).resolves.toMatchObject({
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      });
    });

    it('rejects unknown Working CSVs and oversized row windows', async () => {
      const workingCsv = await fixture.openSource(
        'windows.csv',
        ['value', '1'].join('\n'),
      );

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
      const sourceId = await fixture.registerSource(
        'missing.csv',
        'value\n1\n',
      );
      await fixture.removeSource('missing.csv');
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      await expect(
        workspace().call({ operation: 'csv.open-recent', sourceId: sourceId }),
      ).resolves.toMatchObject({
        status: 'failed',
        message: expect.stringContaining('Unable to open CSV'),
      });
      error.mockRestore();
    });

    it('keeps large CSV Source access bounded after edits, inserts, and deletes', async () => {
      const workingCsv = await fixture.openSource(
        'large-edited.csv',
        buildLargeCsv(),
      );
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
      const sourceId = await fixture.registerSource(
        'people.json',
        '{"name":"Ada"}',
      );
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      await expect(
        workspace().call({ operation: 'csv.open-recent', sourceId: sourceId }),
      ).resolves.toMatchObject({
        status: 'failed',
        message: expect.stringContaining('Unsupported file type'),
      });
      error.mockRestore();
    });

    describe('concurrent CSV mutations', () => {
      it('gives every concurrently inserted row its own identifier and position', async () => {
        const workingCsv = await fixture.openSource(
          'insert-concurrent.csv',
          ['name', 'Ada'].join('\n'),
        );
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
        const workingCsv = await fixture.openSource(
          'undo-concurrent.csv',
          ['name,code', 'Ada,001'].join('\n'),
        );
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

        await expect(
          fixture.editState(workingCsv.workingCsvId),
        ).resolves.toMatchObject({
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
  });

  function buildLargeCsv(): string {
    const rows = ['id,name,score'];
    for (let index = 0; index < 5000; index += 1) {
      rows.push(`${index},Person ${index},${index % 100}`);
    }
    return rows.join('\n');
  }
}
