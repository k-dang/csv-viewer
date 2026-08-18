import { link, readFile, rename } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csvInternalRowIdField, type CsvRow, type WorkingCsvId } from '../shared/ipc';
import { CsvWorkspaceFixture } from '../main/testing/csv-workspace-fixture';

let fixture: CsvWorkspaceFixture;

beforeEach(async () => {
  fixture = await CsvWorkspaceFixture.create();
});

afterEach(async () => {
  await fixture.dispose();
});

function workspace() {
  return fixture.workspace;
}

async function editState(workingCsvId: WorkingCsvId) {
  return workspace().getCsvEditState({ workingCsvId });
}

describe('CsvWorkspace editing, history, and Export CSV', () => {
  it('edits a cell by row identifier and returns edited values in later row windows', async () => {
    const workingCsv = await fixture.openSource(
      'edit.csv',
      ['name,code', 'Ada,001', 'Grace,002'].join('\n'),
    );
    const firstWindow = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 2,
    });
    const result = await workspace().editCsvCell({
      workingCsvId: workingCsv.workingCsvId,
      rowId: firstWindow.rows[1][csvInternalRowIdField],
      column: 'code',
      value: '00042',
    });
    const editedWindow = await workspace().getCsvRows({
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
    const sorted = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 3,
      sort: [{ column: 'score', direction: 'desc' }],
    });

    await workspace().editCsvCell({
      workingCsvId: workingCsv.workingCsvId,
      rowId: sorted.rows[0][csvInternalRowIdField],
      column: 'name',
      value: 'Rear Admiral Grace',
    });
    const sourceOrder = await workspace().getCsvRows({
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
    const searched = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 10,
      search: 'navy',
    });

    await workspace().editCsvCell({
      workingCsvId: workingCsv.workingCsvId,
      rowId: searched.rows[0][csvInternalRowIdField],
      column: 'team',
      value: 'compiler',
    });
    const filtered = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 10,
      filters: [{ column: 'team', kind: 'text', operator: 'equals', value: 'compiler' }],
    });
    const searchedAgain = await workspace().getCsvRows({
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

    await expect(editState(workingCsv.workingCsvId)).resolves.toEqual({
      workingCsvId: workingCsv.workingCsvId,
      hasUnexportedChanges: false,
      canUndo: false,
      canRedo: false,
    });

    await workspace().editCsvCell({ ...request, rowId: '1', column: 'code', value: '007' });
    await expect(editState(workingCsv.workingCsvId)).resolves.toEqual({
      workingCsvId: workingCsv.workingCsvId,
      hasUnexportedChanges: true,
      canUndo: true,
      canRedo: false,
    });

    const undone = await workspace().undoCsvEdit(request);
    const afterUndo = await workspace().getCsvRows({ ...request, offset: 0, limit: 1 });

    expect(undone).toEqual({
      workingCsvId: workingCsv.workingCsvId,
      hasUnexportedChanges: false,
      canUndo: false,
      canRedo: true,
    });
    expect(afterUndo.rows[0].code).toBe('001');

    const redone = await workspace().redoCsvEdit(request);
    const afterRedo = await workspace().getCsvRows({ ...request, offset: 0, limit: 1 });

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

    await workspace().editCsvCell({ ...request, rowId: '1', column: 'code', value: '002' });
    await workspace().undoCsvEdit(request);
    await workspace().editCsvCell({ ...request, rowId: '1', column: 'code', value: '003' });

    await expect(editState(workingCsv.workingCsvId)).resolves.toEqual({
      workingCsvId: workingCsv.workingCsvId,
      hasUnexportedChanges: true,
      canUndo: true,
      canRedo: false,
    });
    await expect(workspace().redoCsvEdit(request)).rejects.toThrow(
      'No CSV edit is available to redo',
    );
  });

  it('deletes one selected source row and excludes it from row windows and counts', async () => {
    const workingCsv = await fixture.openSource(
      'delete-one.csv',
      ['name,team', 'Ada,compiler', 'Grace,navy', 'Linus,kernel'].join('\n'),
    );
    const firstWindow = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 3,
    });
    const result = await workspace().deleteCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      rowIds: [firstWindow.rows[1][csvInternalRowIdField]],
    });
    const afterDelete = await workspace().getCsvRows({
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
    const sorted = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 4,
      sort: [{ column: 'score', direction: 'desc' }],
    });

    await workspace().deleteCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      rowIds: [sorted.rows[0][csvInternalRowIdField], sorted.rows[2][csvInternalRowIdField]],
    });
    const sourceOrder = await workspace().getCsvRows({
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
      ['name,team', 'Ada,compiler', 'Grace,navy', 'Linus,kernel', 'Margaret,compiler'].join('\n'),
    );
    const compilerFilter = [
      { column: 'team', kind: 'text', operator: 'equals', value: 'compiler' },
    ] as const;
    const filtered = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 10,
      filters: [...compilerFilter],
    });

    await workspace().deleteCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      rowIds: [filtered.rows[0][csvInternalRowIdField]],
    });
    const filteredAgain = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 10,
      filters: [...compilerFilter],
    });
    const searched = await workspace().getCsvRows({
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
    await workspace().deleteCsvRows({ ...request, rowIds: ['1', '3'] });

    const undone = await workspace().undoCsvEdit(request);
    const afterUndo = await workspace().getCsvRows({ ...request, offset: 0, limit: 3 });
    const redone = await workspace().redoCsvEdit(request);
    const afterRedo = await workspace().getCsvRows({ ...request, offset: 0, limit: 3 });

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
    const workingCsv = await fixture.openSource('delete-invalid.csv', ['name', 'Ada'].join('\n'));

    await expect(
      workspace().deleteCsvRows({ workingCsvId: workingCsv.workingCsvId, rowIds: [] }),
    ).rejects.toThrow('At least one CSV row must be selected for deletion');
    await expect(
      workspace().deleteCsvRows({ workingCsvId: workingCsv.workingCsvId, rowIds: ['missing'] }),
    ).rejects.toThrow('CSV row no longer exists: missing');
  });

  it('inserts empty rows above and below one selected source row', async () => {
    const workingCsv = await fixture.openSource(
      'insert-relative.csv',
      ['name,code', 'Ada,001', 'Grace,002', 'Linus,003'].join('\n'),
    );
    const request = { workingCsvId: workingCsv.workingCsvId, hasActiveQuery: false };

    await workspace().insertCsvRow({ ...request, placement: 'above', rowIds: ['2'] });
    await workspace().insertCsvRow({ ...request, placement: 'below', rowIds: ['2'] });
    const window = await workspace().getCsvRows({
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
    await expect(editState(workingCsv.workingCsvId)).resolves.toEqual({
      workingCsvId: workingCsv.workingCsvId,
      hasUnexportedChanges: true,
      canUndo: true,
      canRedo: false,
    });
  });

  it('appends an empty row when no row is selected', async () => {
    const workingCsv = await fixture.openSource(
      'insert-append.csv',
      ['name,code', 'Ada,001'].join('\n'),
    );
    const result = await workspace().insertCsvRow({
      workingCsvId: workingCsv.workingCsvId,
      placement: 'append',
      rowIds: [],
      hasActiveQuery: false,
    });
    const window = await workspace().getCsvRows({
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
      workspace().insertCsvRow({
        ...request,
        placement: 'above',
        rowIds: ['1'],
        hasActiveQuery: true,
      }),
    ).rejects.toThrow('cannot be inserted while sort, filter, or search is active');
    await expect(
      workspace().insertCsvRow({
        ...request,
        placement: 'below',
        rowIds: ['1', '2'],
        hasActiveQuery: false,
      }),
    ).rejects.toThrow('requires exactly one selected CSV row');
    await expect(
      workspace().insertCsvRow({
        ...request,
        placement: 'append',
        rowIds: ['1'],
        hasActiveQuery: false,
      }),
    ).rejects.toThrow('Append row requires no selected CSV rows');
    await expect(
      workspace().insertCsvRow({
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
    await workspace().insertCsvRow({
      ...request,
      placement: 'below',
      rowIds: ['1'],
      hasActiveQuery: false,
    });

    const afterInsert = await workspace().getCsvRows({ ...request, offset: 0, limit: 3 });
    const undone = await workspace().undoCsvEdit(request);
    const afterUndo = await workspace().getCsvRows({ ...request, offset: 0, limit: 3 });
    const redone = await workspace().redoCsvEdit(request);
    const afterRedo = await workspace().getCsvRows({ ...request, offset: 0, limit: 3 });

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

  it('exports edited, inserted, and non-deleted rows without internal row identifiers', async () => {
    const workingCsv = await fixture.openSource(
      'export-source.csv',
      ['name,code,note', 'Ada,001,first', 'Grace,002,second', 'Linus,003,third'].join('\n'),
    );
    const request = { workingCsvId: workingCsv.workingCsvId };
    const outputPath = fixture.queueExportTo('exported.csv');

    await workspace().editCsvCell({ ...request, rowId: '2', column: 'code', value: '00042' });
    await workspace().insertCsvRow({
      ...request,
      placement: 'below',
      rowIds: ['1'],
      hasActiveQuery: false,
    });
    await workspace().editCsvCell({ ...request, rowId: '4', column: 'name', value: 'New, Person' });
    await workspace().deleteCsvRows({ ...request, rowIds: ['3'] });

    const state = await workspace().exportCsv(request);
    const exported = await readFile(outputPath, 'utf8');

    expect(exported).toBe(
      ['name,code,note', 'Ada,001,first', '"New, Person",,', 'Grace,00042,second', ''].join('\n'),
    );
    expect(exported).not.toContain(csvInternalRowIdField);
    expect(state).toEqual({
      workingCsvId: workingCsv.workingCsvId,
      hasUnexportedChanges: false,
      canUndo: true,
      canRedo: false,
    });
    await expect(workspace().getWorkingCsv(workingCsv.workingCsvId)).resolves.toMatchObject({
      file: workingCsv.file,
    });
    expect(fixture.prompts.defaultExportPaths).toEqual([fixture.file('export-source-edited.csv')]);
  });

  it('exports delimiter and header settings from the active dialect', async () => {
    const workingCsv = await fixture.openSource(
      'export-no-header.txt',
      ['Ada|37', 'Grace|41'].join('\n'),
      { delimiter: '|', header: false },
    );
    const outputPath = fixture.queueExportTo('exported-no-header.txt');

    await workspace().editCsvCell({
      workingCsvId: workingCsv.workingCsvId,
      rowId: '1',
      column: 'column1',
      value: '38',
    });
    await workspace().exportCsv({ workingCsvId: workingCsv.workingCsvId });

    await expect(readFile(outputPath, 'utf8')).resolves.toBe(['Ada|38', 'Grace|41', ''].join('\n'));
  });

  it('defaults a TSV export to tab delimiters', async () => {
    const workingCsv = await fixture.openSource(
      'export-tabs.tsv',
      ['name\tage', 'Ada\t37'].join('\n'),
    );
    const outputPath = fixture.queueExportTo('exported-tabs.tsv');

    await workspace().exportCsv({ workingCsvId: workingCsv.workingCsvId });

    await expect(readFile(outputPath, 'utf8')).resolves.toBe(
      ['name\tage', 'Ada\t37', ''].join('\n'),
    );
  });

  it('keeps Unexported Changes when Export CSV is cancelled', async () => {
    const workingCsv = await fixture.openSource('export-cancelled.csv', ['name', 'Ada'].join('\n'));
    await workspace().editCsvCell({
      workingCsvId: workingCsv.workingCsvId,
      rowId: '1',
      column: 'name',
      value: 'Grace',
    });

    await expect(workspace().exportCsv({ workingCsvId: workingCsv.workingCsvId })).resolves.toEqual({
      status: 'cancelled',
    });
    await expect(editState(workingCsv.workingCsvId)).resolves.toMatchObject({
      hasUnexportedChanges: true,
    });
  });

  it('rejects an export destination that is the CSV Source and re-prompts', async () => {
    const filePath = await fixture.writeSource('protected-source.csv', ['name', 'Ada'].join('\n'));
    const sourceAliasPath = fixture.file('protected-source-alias.csv');
    await link(filePath, sourceAliasPath);
    const workingCsv = await fixture.open(filePath);
    await workspace().editCsvCell({
      workingCsvId: workingCsv.workingCsvId,
      rowId: '1',
      column: 'name',
      value: 'Grace',
    });

    fixture.prompts.exportChoices.push(sourceAliasPath);
    const outputPath = fixture.queueExportTo('protected-output.csv');

    await expect(workspace().exportCsv({ workingCsvId: workingCsv.workingCsvId })).resolves.toMatchObject(
      { hasUnexportedChanges: false },
    );
    expect(fixture.prompts.sourceConflictCount).toBe(1);
    await expect(readFile(filePath, 'utf8')).resolves.toBe(['name', 'Ada'].join('\n'));
    await expect(readFile(outputPath, 'utf8')).resolves.toContain('Grace');
  });

  it('retains CSV Source identity when the source is moved after opening', async () => {
    const filePath = await fixture.writeSource('source-before-move.csv', ['name', 'Ada'].join('\n'));
    const movedSourcePath = fixture.file('source-after-move.csv');
    const workingCsv = await fixture.open(filePath);
    await rename(filePath, movedSourcePath);

    fixture.prompts.exportChoices.push(movedSourcePath);
    fixture.queueExportTo('moved-output.csv');

    await workspace().exportCsv({ workingCsvId: workingCsv.workingCsvId });
    expect(fixture.prompts.sourceConflictCount).toBe(1);
  });

  it('tracks Unexported Changes by revision identity while preserving edit history', async () => {
    const workingCsv = await fixture.openSource(
      'export-revisions.csv',
      ['name,code', 'Ada,001'].join('\n'),
    );
    const request = { workingCsvId: workingCsv.workingCsvId };
    fixture.queueExportTo('exported.csv');

    await workspace().editCsvCell({ ...request, rowId: '1', column: 'code', value: '002' });
    await expect(workspace().exportCsv(request)).resolves.toEqual({
      workingCsvId: workingCsv.workingCsvId,
      hasUnexportedChanges: false,
      canUndo: true,
      canRedo: false,
    });
    await expect(workspace().undoCsvEdit(request)).resolves.toMatchObject({
      hasUnexportedChanges: true,
      canUndo: false,
      canRedo: true,
    });
    await expect(workspace().redoCsvEdit(request)).resolves.toMatchObject({
      hasUnexportedChanges: false,
      canUndo: true,
      canRedo: false,
    });

    await workspace().undoCsvEdit(request);
    await expect(
      workspace().editCsvCell({ ...request, rowId: '1', column: 'code', value: '003' }),
    ).resolves.toMatchObject({
      hasUnexportedChanges: true,
      canUndo: true,
      canRedo: false,
    });
  });

  it('preserves redo history when Export CSV establishes an undone revision as exported', async () => {
    const workingCsv = await fixture.openSource('export-redo.csv', ['name,code', 'Ada,001'].join('\n'));
    const request = { workingCsvId: workingCsv.workingCsvId };
    fixture.queueExportTo('exported-undone-revision.csv');

    await workspace().editCsvCell({ ...request, rowId: '1', column: 'code', value: '002' });
    await workspace().undoCsvEdit(request);

    await expect(workspace().exportCsv(request)).resolves.toMatchObject({
      hasUnexportedChanges: false,
      canUndo: false,
      canRedo: true,
    });
    await expect(workspace().redoCsvEdit(request)).resolves.toMatchObject({
      hasUnexportedChanges: true,
      canUndo: true,
      canRedo: false,
    });
  });

  it('rejects unknown Working CSVs and oversized row windows', async () => {
    const workingCsv = await fixture.openSource('windows.csv', ['value', '1'].join('\n'));

    await expect(
      workspace().getCsvRows({ workingCsvId: 'unknown-workingCsv', offset: 0, limit: 1 }),
    ).rejects.toThrow('Working CSV is no longer active');
    await expect(
      workspace().getCsvRows({ workingCsvId: workingCsv.workingCsvId, offset: 0, limit: 1001 }),
    ).rejects.toThrow('1000 or less');
  });

  it('returns a clear error for missing CSV Sources without keeping a Working CSV', async () => {
    const missingPath = fixture.file('missing.csv');
    const sourceId = await fixture.sourceId(missingPath);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(workspace().openRecentCsv(sourceId)).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('Unable to open CSV'),
    });
    error.mockRestore();
  });

  it('validates large CSV Source access through bounded row windows', async () => {
    const workingCsv = await fixture.openSource('large.csv', buildLargeCsv());
    const firstWindow = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 100,
    });
    const laterWindow = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 4500,
      limit: 75,
    });

    expect(workingCsv.rowCount).toBe(5000);
    expect(firstWindow.rows).toHaveLength(100);
    expect(laterWindow.rows).toHaveLength(75);
    expect(laterWindow.rows[0]).toEqual({
      [csvInternalRowIdField]: '4501',
      id: '4500',
      name: 'Person 4500',
      score: '0',
    });
  });

  it('keeps edited large CSV Source access bounded after edits, inserts, and deletes', async () => {
    const workingCsv = await fixture.openSource('large-edited.csv', buildLargeCsv());
    const request = { workingCsvId: workingCsv.workingCsvId };

    await workspace().editCsvCell({
      ...request,
      rowId: '4901',
      column: 'name',
      value: 'Edited Person',
    });
    await workspace().insertCsvRow({
      ...request,
      placement: 'below',
      rowIds: ['4901'],
      hasActiveQuery: false,
    });
    await workspace().deleteCsvRows({ ...request, rowIds: ['4902', '4903'] });

    const window = await workspace().getCsvRows({ ...request, offset: 4899, limit: 5 });

    expect(window.filteredRowCount).toBe(4999);
    expect(window.rows).toHaveLength(5);
    expect(rowIds(window.rows)).toEqual(['4900', '4901', '5001', '4904', '4905']);
    expect(window.rows[1].name).toBe('Edited Person');
    expect(window.rows[2]).toMatchObject({ id: '', name: '', score: '' });
  });

  it('validates wide CSV Source access without requiring all columns to be manually mapped', async () => {
    const headers = Array.from({ length: 120 }, (_value, index) => `metric_${index}`);
    const row = headers.map((_header, index) => String(index));
    const workingCsv = await fixture.openSource(
      'wide.csv',
      [headers.join(','), row.join(',')].join('\n'),
    );
    const window = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 1,
    });

    expect(workingCsv.columns).toHaveLength(120);
    expect(window.rows).toHaveLength(1);
    expect(window.rows[0].metric_0).toBe('0');
    expect(window.rows[0].metric_119).toBe('119');
  });

  it('returns a distinct error for unsupported CSV Sources', async () => {
    const filePath = await fixture.writeSource('people.json', '{"name":"Ada"}');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      workspace().openRecentCsv(await fixture.sourceId(filePath)),
    ).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('Unsupported file type'),
    });
    error.mockRestore();
  });

  it('records opened CSV Sources as Recent CSV Sources, most recent first', async () => {
    const first = await fixture.openSource('recent-first.csv', ['a', '1'].join('\n'));
    const second = await fixture.openSource('recent-second.csv', ['b', '2'].join('\n'));

    const recents = await workspace().getRecentCsvSources();

    expect(recents.map((recent) => recent.name)).toEqual([
      'recent-second.csv',
      'recent-first.csv',
    ]);
    expect(recents.map((recent) => recent.sourceId)).toEqual([
      second.file.sourceId,
      first.file.sourceId,
    ]);
    expect(recents[0].location).toBe(fixture.file('recent-second.csv'));
    expect(recents[0].sizeBytes).toBeGreaterThan(0);
  });

  it('opens a CSV Source chosen through the runtime picker and cancels cleanly', async () => {
    const filePath = await fixture.writeSource('picked.csv', ['a', '1'].join('\n'));

    await expect(workspace().openCsv()).resolves.toEqual({ status: 'cancelled' });

    fixture.prompts.sourceChoices.push(filePath);
    await expect(workspace().openCsv()).resolves.toMatchObject({
      status: 'opened',
      workingCsv: { file: { name: 'picked.csv' } },
    });
  });

  it('keeps the Working CSV usable and closable while an export is being delivered', async () => {
    const workingCsv = await fixture.openSource(
      'export-during-delivery.csv',
      ['name', 'Ada', 'Grace'].join('\n'),
    );
    fixture.queueExportTo('delivered.csv');
    const prompting = deferred();
    const release = deferred();
    fixture.prompts.holdExportPrompt = () => {
      prompting.resolve();
      return release.promise;
    };

    const exporting = workspace().exportCsv({ workingCsvId: workingCsv.workingCsvId });
    await prompting.promise;

    await expect(
      workspace().getCsvRows({ workingCsvId: workingCsv.workingCsvId, offset: 0, limit: 10 }),
    ).resolves.toMatchObject({ filteredRowCount: 2 });
    await expect(
      workspace().closeCsv({ workingCsvId: workingCsv.workingCsvId }),
    ).resolves.toMatchObject({ status: 'closed' });

    release.resolve();
    await expect(exporting).resolves.toMatchObject({ hasUnexportedChanges: false });
    await expect(readFile(fixture.file('delivered.csv'), 'utf8')).resolves.toContain('Grace');
  });

  it('leaves Unexported Changes set when the Working CSV moves on during delivery', async () => {
    const workingCsv = await fixture.openSource(
      'export-raced.csv',
      ['name,code', 'Ada,001'].join('\n'),
    );
    const request = { workingCsvId: workingCsv.workingCsvId };
    fixture.queueExportTo('raced.csv');
    const prompting = deferred();
    const release = deferred();
    fixture.prompts.holdExportPrompt = () => {
      prompting.resolve();
      return release.promise;
    };

    const exporting = workspace().exportCsv(request);
    await prompting.promise;
    await workspace().editCsvCell({ ...request, rowId: '1', column: 'code', value: '002' });
    release.resolve();

    await expect(exporting).resolves.toMatchObject({ hasUnexportedChanges: true });
    await expect(readFile(fixture.file('raced.csv'), 'utf8')).resolves.toContain('001');
    await expect(workspace().undoCsvEdit(request)).resolves.toMatchObject({
      hasUnexportedChanges: false,
    });
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function buildLargeCsv(): string {
  const rows = ['id,name,score'];
  for (let index = 0; index < 5000; index += 1) {
    rows.push(`${index},Person ${index},${index % 100}`);
  }
  return rows.join('\n');
}

function rowIds(rows: CsvRow[]): string[] {
  return rows.map((row) => row[csvInternalRowIdField]);
}

function expectVisibleRows(rows: CsvRow[]) {
  return expect(rows.map(({ [csvInternalRowIdField]: _rowId, ...visibleRow }) => visibleRow));
}
