import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { csvInternalRowIdField, type CsvRow } from '../shared/ipc';
import { CsvDataService } from './csv-data-service';

let tempDir: string;
let service: CsvDataService;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'csv-viewer-'));
  service = new CsvDataService();
});

afterEach(async () => {
  await service.closeActiveSession();
  await rm(tempDir, { recursive: true, force: true });
});

describe('CsvDataService', () => {
  it('opens a CSV and returns file metadata, inferred columns, and row count', async () => {
    const filePath = await writeFixture(
      'people.csv',
      ['name,age,joined', 'Ada,37,2024-01-10', 'Grace,41,2024-02-12'].join('\n'),
    );

    const session = await service.openCsv(filePath);

    expect(session.file.name).toBe('people.csv');
    expect(session.file.path).toBe(filePath);
    expect(session.file.sizeBytes).toBeGreaterThan(0);
    expect(session.rowCount).toBe(2);
    expect(session.columns.map((column) => column.name)).toEqual(['name', 'age', 'joined']);
    expect(session.columns.map((column) => column.type)).toEqual(['VARCHAR', 'VARCHAR', 'VARCHAR']);
    expect(service.getActiveSession()?.sessionId).toBe(session.sessionId);
  });

  it('handles quoted fields and escaped delimiters through DuckDB CSV parsing', async () => {
    const filePath = await writeFixture(
      'quoted.csv',
      ['name,note', 'Ada,"uses commas, quotes ""well"", and new lines"', 'Grace,"plain"'].join(
        '\n',
      ),
    );

    const session = await service.openCsv(filePath);

    expect(session.rowCount).toBe(2);
    expect(session.columns.map((column) => column.name)).toEqual(['name', 'note']);
  });

  it('opens files with a delimiter override', async () => {
    const filePath = await writeFixture(
      'pipe.csv',
      ['name|age', 'Ada|37', 'Grace|41'].join('\n'),
    );

    const session = await service.openCsv(filePath, { delimiter: '|' });
    const window = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 2 });

    expect(session.dialect).toEqual({ delimiter: '|' });
    expect(session.columns.map((column) => column.name)).toEqual(['name', 'age']);
    expectVisibleRows(window.rows).toEqual([
      { name: 'Ada', age: '37' },
      { name: 'Grace', age: '41' },
    ]);
    expect(rowIds(window.rows)).toEqual(['1', '2']);
  });

  it('opens files with a header override', async () => {
    const filePath = await writeFixture('no-header.csv', ['Ada,37', 'Grace,41'].join('\n'));

    const session = await service.openCsv(filePath, { header: false });
    const window = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 2 });

    expect(session.dialect).toEqual({ header: false });
    expect(session.columns.map((column) => column.name)).toEqual(['column0', 'column1']);
    expectVisibleRows(window.rows).toEqual([
      { column0: 'Ada', column1: '37' },
      { column0: 'Grace', column1: '41' },
    ]);
    expect(rowIds(window.rows)).toEqual(['1', '2']);
  });

  it('reopens the active file with new dialect options', async () => {
    const filePath = await writeFixture('reopen.txt', ['name|age', 'Ada|37'].join('\n'));

    const auto = await service.openCsv(filePath);
    const reopened = await service.reopenActiveCsv({ delimiter: '|' });

    expect(reopened.sessionId).not.toBe(auto.sessionId);
    expect(reopened.file.path).toBe(filePath);
    expect(reopened.dialect).toEqual({ delimiter: '|' });
    expect(reopened.columns.map((column) => column.name)).toEqual(['name', 'age']);
  });

  it('rejects invalid delimiter choices before opening', async () => {
    const filePath = await writeFixture('invalid-delimiter.csv', ['name,age', 'Ada,37'].join('\n'));

    await expect(service.openCsv(filePath, { delimiter: '||' })).rejects.toThrow(
      'Delimiter must be exactly one character',
    );
  });

  it('keeps the active session when a reopen option is invalid', async () => {
    const filePath = await writeFixture('keep-active.csv', ['name,age', 'Ada,37'].join('\n'));
    const session = await service.openCsv(filePath);

    await expect(service.reopenActiveCsv({ delimiter: '||' })).rejects.toThrow(
      'Delimiter must be exactly one character',
    );

    expect(service.getActiveSession()).toEqual(session);
  });

  it('replaces the active session when opening another CSV', async () => {
    const firstPath = await writeFixture('first.csv', ['a', '1'].join('\n'));
    const secondPath = await writeFixture('second.csv', ['b,c', '2,3', '4,5'].join('\n'));

    const first = await service.openCsv(firstPath);
    const second = await service.openCsv(secondPath);

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(service.getActiveSession()).toEqual(second);
    expect(second.file.name).toBe('second.csv');
    expect(second.rowCount).toBe(2);
    expect(second.columns.map((column) => column.name)).toEqual(['b', 'c']);
  });

  it('returns bounded row windows without reading the full CSV', async () => {
    const filePath = await writeFixture(
      'window.csv',
      ['name,age,note', 'Ada,37,first', 'Grace,41,second', 'Linus,54,third'].join('\n'),
    );

    const session = await service.openCsv(filePath);
    const window = await service.getRows({ sessionId: session.sessionId, offset: 1, limit: 1 });

    expect(window).toEqual({
      sessionId: session.sessionId,
      offset: 1,
      filteredRowCount: 3,
      rows: [{ [csvInternalRowIdField]: '2', name: 'Grace', age: '41', note: 'second' }],
    });
  });

  it('preserves text-like values and null values distinctly in row windows', async () => {
    const filePath = await writeFixture(
      'missing.csv',
      ['name,note,score,identifier', 'Ada,,10,00123', 'Grace,NULL,,00042'].join('\n'),
    );

    const session = await service.openCsv(filePath);
    const window = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 2 });

    expectVisibleRows(window.rows).toEqual([
      { name: 'Ada', note: null, score: '10', identifier: '00123' },
      { name: 'Grace', note: 'NULL', score: null, identifier: '00042' },
    ]);
    expect(rowIds(window.rows)).toEqual(['1', '2']);
  });

  it('sorts rows by a structured column descriptor and clears sort by omitting descriptors', async () => {
    const filePath = await writeFixture(
      'sort.csv',
      ['name,age', 'Ada,37', 'Grace,41', 'Linus,54'].join('\n'),
    );

    const session = await service.openCsv(filePath);
    const sorted = await service.getRows({
      sessionId: session.sessionId,
      offset: 0,
      limit: 3,
      sort: [{ column: 'age', direction: 'desc' }],
    });
    const originalOrder = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 3 });

    expect(sorted.rows.map((row) => row.name)).toEqual(['Linus', 'Grace', 'Ada']);
    expect(originalOrder.rows.map((row) => row.name)).toEqual(['Ada', 'Grace', 'Linus']);
  });

  it('keeps hidden row identifiers stable across sorting, filtering, search, and pagination', async () => {
    const filePath = await writeFixture(
      'stable-row-ids.csv',
      [
        'name,age,team',
        'Ada,37,compiler',
        'Grace,41,navy',
        'Linus,54,kernel',
        'Margaret,87,compiler',
      ].join('\n'),
    );

    const session = await service.openCsv(filePath);
    const firstPage = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 2 });
    const sorted = await service.getRows({
      sessionId: session.sessionId,
      offset: 0,
      limit: 4,
      sort: [{ column: 'name', direction: 'desc' }],
    });
    const filtered = await service.getRows({
      sessionId: session.sessionId,
      offset: 0,
      limit: 4,
      filters: [{ column: 'team', kind: 'text', operator: 'contains', value: 'compiler' }],
    });
    const searched = await service.getRows({
      sessionId: session.sessionId,
      offset: 0,
      limit: 4,
      search: 'Grace',
    });

    expect(session.columns.map((column) => column.name)).not.toContain(csvInternalRowIdField);
    expect(rowIds(firstPage.rows)).toEqual(['1', '2']);
    expect(rowIds(sorted.rows)).toEqual(['4', '3', '2', '1']);
    expect(rowIds(filtered.rows)).toEqual(['1', '4']);
    expect(rowIds(searched.rows)).toEqual(['2']);
  });

  it('applies text, numeric, and combined filters with filtered row counts', async () => {
    const filePath = await writeFixture(
      'filters.csv',
      [
        'name,age,team',
        'Ada,37,compiler',
        'Grace,41,navy',
        'Linus,54,kernel',
        'Margaret,87,compiler',
      ].join('\n'),
    );

    const session = await service.openCsv(filePath);
    const window = await service.getRows({
      sessionId: session.sessionId,
      offset: 0,
      limit: 10,
      filters: [
        { column: 'team', kind: 'text', operator: 'contains', value: 'compiler' },
        { column: 'age', kind: 'number', operator: 'greaterThan', value: 40 },
      ],
    });

    expect(window.filteredRowCount).toBe(1);
    expectVisibleRows(window.rows).toEqual([{ name: 'Margaret', age: '87', team: 'compiler' }]);
  });

  it('filters inferred date columns', async () => {
    const filePath = await writeFixture(
      'dates.csv',
      ['name,joined', 'Ada,2024-01-10', 'Grace,2024-02-12', 'Linus,2024-03-20'].join('\n'),
    );

    const session = await service.openCsv(filePath);
    const window = await service.getRows({
      sessionId: session.sessionId,
      offset: 0,
      limit: 10,
      filters: [
        {
          column: 'joined',
          kind: 'date',
          operator: 'greaterThanOrEqual',
          value: '2024-02-01',
        },
      ],
    });

    expect(window.filteredRowCount).toBe(2);
    expect(window.rows.map((row) => row.name)).toEqual(['Grace', 'Linus']);
  });

  it('handles unusual column names and parameterized filter values', async () => {
    const filePath = await writeFixture(
      'unusual.csv',
      ['"full name","select","quote""name"', '"Ada Lovelace","alpha","safe"', '"Grace Hopper","beta","unsafe"'].join('\n'),
    );

    const session = await service.openCsv(filePath);
    const window = await service.getRows({
      sessionId: session.sessionId,
      offset: 0,
      limit: 10,
      sort: [{ column: 'full name', direction: 'desc' }],
      filters: [{ column: 'quote"name', kind: 'text', operator: 'contains', value: `safe' OR 1=1 --` }],
    });

    expect(window.filteredRowCount).toBe(0);
    expect(window.rows).toEqual([]);
  });

  it('searches across columns and returns matching row counts', async () => {
    const filePath = await writeFixture(
      'search.csv',
      [
        'name,age,team',
        'Ada,37,compiler',
        'Grace,41,navy',
        'Linus,54,kernel',
        'Margaret,87,compiler',
      ].join('\n'),
    );

    const session = await service.openCsv(filePath);
    const window = await service.getRows({
      sessionId: session.sessionId,
      offset: 0,
      limit: 10,
      search: 'comp',
    });

    expect(window.filteredRowCount).toBe(2);
    expect(window.rows.map((row) => row.name)).toEqual(['Ada', 'Margaret']);
  });

  it('returns no rows for searches without matches and clears search when omitted', async () => {
    const filePath = await writeFixture('search-clear.csv', ['name,team', 'Ada,compiler', 'Grace,navy'].join('\n'));

    const session = await service.openCsv(filePath);
    const noResults = await service.getRows({
      sessionId: session.sessionId,
      offset: 0,
      limit: 10,
      search: 'missing',
    });
    const cleared = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 10 });

    expect(noResults.filteredRowCount).toBe(0);
    expect(noResults.rows).toEqual([]);
    expect(cleared.filteredRowCount).toBe(2);
    expect(cleared.rows.map((row) => row.name)).toEqual(['Ada', 'Grace']);
  });

  it('composes search with active filters using parameterized search values', async () => {
    const filePath = await writeFixture(
      'search-filter.csv',
      ['"full name",age,team', '"Ada Lovelace",37,compiler', '"Grace Hopper",41,navy', '"Margaret Hamilton",87,compiler'].join('\n'),
    );

    const session = await service.openCsv(filePath);
    const filteredSearch = await service.getRows({
      sessionId: session.sessionId,
      offset: 0,
      limit: 10,
      search: 'compiler',
      filters: [{ column: 'age', kind: 'number', operator: 'greaterThan', value: 40 }],
    });
    const parameterizedSearch = await service.getRows({
      sessionId: session.sessionId,
      offset: 0,
      limit: 10,
      search: `compiler%' OR 1=1 --`,
      filters: [{ column: 'age', kind: 'number', operator: 'greaterThan', value: 40 }],
    });

    expect(filteredSearch.filteredRowCount).toBe(1);
    expect(filteredSearch.rows.map((row) => row['full name'])).toEqual(['Margaret Hamilton']);
    expect(parameterizedSearch.filteredRowCount).toBe(0);
    expect(parameterizedSearch.rows).toEqual([]);
  });

  it('edits a cell by row identifier and returns edited values in later row windows', async () => {
    const filePath = await writeFixture('edit.csv', ['name,code', 'Ada,001', 'Grace,002'].join('\n'));

    const session = await service.openCsv(filePath);
    const firstWindow = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 2 });
    const result = await service.editCell({
      sessionId: session.sessionId,
      rowId: firstWindow.rows[1][csvInternalRowIdField],
      column: 'code',
      value: '00042',
    });
    const editedWindow = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 2 });

    expect(result).toEqual({
      sessionId: session.sessionId,
      rowId: '2',
      column: 'code',
      dirty: true,
      canUndo: true,
      canRedo: false,
    });
    expectVisibleRows(editedWindow.rows).toEqual([
      { name: 'Ada', code: '001' },
      { name: 'Grace', code: '00042' },
    ]);
  });

  it('edits the source row selected from a sorted window', async () => {
    const filePath = await writeFixture(
      'edit-sorted.csv',
      ['name,score', 'Ada,10', 'Grace,30', 'Linus,20'].join('\n'),
    );

    const session = await service.openCsv(filePath);
    const sorted = await service.getRows({
      sessionId: session.sessionId,
      offset: 0,
      limit: 3,
      sort: [{ column: 'score', direction: 'desc' }],
    });

    await service.editCell({
      sessionId: session.sessionId,
      rowId: sorted.rows[0][csvInternalRowIdField],
      column: 'name',
      value: 'Rear Admiral Grace',
    });
    const sourceOrder = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 3 });

    expect(rowIds(sorted.rows)).toEqual(['2', '3', '1']);
    expect(sourceOrder.rows[1].name).toBe('Rear Admiral Grace');
    expect(sourceOrder.rows[0].name).toBe('Ada');
  });

  it('refreshes filtered and searched row windows when an edit changes query membership', async () => {
    const filePath = await writeFixture(
      'edit-query.csv',
      ['name,team', 'Ada,compiler', 'Grace,navy', 'Linus,kernel'].join('\n'),
    );

    const session = await service.openCsv(filePath);
    const searched = await service.getRows({
      sessionId: session.sessionId,
      offset: 0,
      limit: 10,
      search: 'navy',
    });

    await service.editCell({
      sessionId: session.sessionId,
      rowId: searched.rows[0][csvInternalRowIdField],
      column: 'team',
      value: 'compiler',
    });
    const filtered = await service.getRows({
      sessionId: session.sessionId,
      offset: 0,
      limit: 10,
      filters: [{ column: 'team', kind: 'text', operator: 'equals', value: 'compiler' }],
    });
    const searchedAgain = await service.getRows({
      sessionId: session.sessionId,
      offset: 0,
      limit: 10,
      search: 'navy',
    });

    expect(rowIds(filtered.rows)).toEqual(['1', '2']);
    expect(searchedAgain.filteredRowCount).toBe(0);
    expect(searchedAgain.rows).toEqual([]);
  });

  it('undoes and redoes the most recent cell edit while updating dirty state', async () => {
    const filePath = await writeFixture('edit-history.csv', ['name,code', 'Ada,001'].join('\n'));

    const session = await service.openCsv(filePath);
    const firstWindow = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 1 });
    const rowId = firstWindow.rows[0][csvInternalRowIdField];

    expect(service.getEditState({ sessionId: session.sessionId })).toEqual({
      sessionId: session.sessionId,
      dirty: false,
      canUndo: false,
      canRedo: false,
    });

    await service.editCell({ sessionId: session.sessionId, rowId, column: 'code', value: '007' });
    expect(service.getEditState({ sessionId: session.sessionId })).toEqual({
      sessionId: session.sessionId,
      dirty: true,
      canUndo: true,
      canRedo: false,
    });

    const undone = await service.undoEdit({ sessionId: session.sessionId });
    const afterUndo = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 1 });

    expect(undone).toEqual({
      sessionId: session.sessionId,
      dirty: false,
      canUndo: false,
      canRedo: true,
    });
    expect(afterUndo.rows[0].code).toBe('001');

    const redone = await service.redoEdit({ sessionId: session.sessionId });
    const afterRedo = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 1 });

    expect(redone).toEqual({
      sessionId: session.sessionId,
      dirty: true,
      canUndo: true,
      canRedo: false,
    });
    expect(afterRedo.rows[0].code).toBe('007');
  });

  it('clears redo history when a new cell edit is made after undo', async () => {
    const filePath = await writeFixture('edit-redo-clear.csv', ['name,code', 'Ada,001'].join('\n'));

    const session = await service.openCsv(filePath);
    const firstWindow = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 1 });
    const rowId = firstWindow.rows[0][csvInternalRowIdField];

    await service.editCell({ sessionId: session.sessionId, rowId, column: 'code', value: '002' });
    await service.undoEdit({ sessionId: session.sessionId });
    await service.editCell({ sessionId: session.sessionId, rowId, column: 'code', value: '003' });

    expect(service.getEditState({ sessionId: session.sessionId })).toEqual({
      sessionId: session.sessionId,
      dirty: true,
      canUndo: true,
      canRedo: false,
    });
    await expect(service.redoEdit({ sessionId: session.sessionId })).rejects.toThrow('No CSV edit is available to redo');
  });

  it('deletes one selected source row and excludes it from row windows and counts', async () => {
    const filePath = await writeFixture(
      'delete-one.csv',
      ['name,team', 'Ada,compiler', 'Grace,navy', 'Linus,kernel'].join('\n'),
    );

    const session = await service.openCsv(filePath);
    const firstWindow = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 3 });
    const result = await service.deleteRows({
      sessionId: session.sessionId,
      rowIds: [firstWindow.rows[1][csvInternalRowIdField]],
    });
    const afterDelete = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 3 });

    expect(result).toEqual({
      sessionId: session.sessionId,
      dirty: true,
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
    const filePath = await writeFixture(
      'delete-many-sorted.csv',
      ['name,score', 'Ada,10', 'Grace,30', 'Linus,20', 'Margaret,40'].join('\n'),
    );

    const session = await service.openCsv(filePath);
    const sorted = await service.getRows({
      sessionId: session.sessionId,
      offset: 0,
      limit: 4,
      sort: [{ column: 'score', direction: 'desc' }],
    });

    await service.deleteRows({
      sessionId: session.sessionId,
      rowIds: [
        sorted.rows[0][csvInternalRowIdField],
        sorted.rows[2][csvInternalRowIdField],
      ],
    });
    const sourceOrder = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 4 });

    expect(rowIds(sorted.rows)).toEqual(['4', '2', '3', '1']);
    expect(sourceOrder.filteredRowCount).toBe(2);
    expect(rowIds(sourceOrder.rows)).toEqual(['1', '2']);
    expect(sourceOrder.rows.map((row) => row.name)).toEqual(['Ada', 'Grace']);
  });

  it('updates filtered and searched row windows after deleting selected rows', async () => {
    const filePath = await writeFixture(
      'delete-query.csv',
      [
        'name,team',
        'Ada,compiler',
        'Grace,navy',
        'Linus,kernel',
        'Margaret,compiler',
      ].join('\n'),
    );

    const session = await service.openCsv(filePath);
    const filtered = await service.getRows({
      sessionId: session.sessionId,
      offset: 0,
      limit: 10,
      filters: [{ column: 'team', kind: 'text', operator: 'equals', value: 'compiler' }],
    });

    await service.deleteRows({
      sessionId: session.sessionId,
      rowIds: [filtered.rows[0][csvInternalRowIdField]],
    });
    const filteredAgain = await service.getRows({
      sessionId: session.sessionId,
      offset: 0,
      limit: 10,
      filters: [{ column: 'team', kind: 'text', operator: 'equals', value: 'compiler' }],
    });
    const searched = await service.getRows({
      sessionId: session.sessionId,
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
    const filePath = await writeFixture(
      'delete-history.csv',
      ['name,code', 'Ada,001', 'Grace,002', 'Linus,003'].join('\n'),
    );

    const session = await service.openCsv(filePath);
    await service.deleteRows({ sessionId: session.sessionId, rowIds: ['1', '3'] });

    const undone = await service.undoEdit({ sessionId: session.sessionId });
    const afterUndo = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 3 });
    const redone = await service.redoEdit({ sessionId: session.sessionId });
    const afterRedo = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 3 });

    expect(undone).toEqual({
      sessionId: session.sessionId,
      dirty: false,
      canUndo: false,
      canRedo: true,
    });
    expect(rowIds(afterUndo.rows)).toEqual(['1', '2', '3']);
    expect(redone).toEqual({
      sessionId: session.sessionId,
      dirty: true,
      canUndo: true,
      canRedo: false,
    });
    expect(rowIds(afterRedo.rows)).toEqual(['2']);
  });

  it('rejects row deletion when no valid selected row identifiers are provided', async () => {
    const filePath = await writeFixture('delete-invalid.csv', ['name', 'Ada'].join('\n'));

    const session = await service.openCsv(filePath);

    await expect(service.deleteRows({ sessionId: session.sessionId, rowIds: [] })).rejects.toThrow(
      'At least one CSV row must be selected for deletion',
    );
    await expect(service.deleteRows({ sessionId: session.sessionId, rowIds: ['missing'] })).rejects.toThrow(
      'CSV row no longer exists: missing',
    );
  });

  it('inserts empty rows above and below one selected source row', async () => {
    const filePath = await writeFixture(
      'insert-relative.csv',
      ['name,code', 'Ada,001', 'Grace,002', 'Linus,003'].join('\n'),
    );

    const session = await service.openCsv(filePath);

    await service.insertRow({
      sessionId: session.sessionId,
      placement: 'above',
      rowIds: ['2'],
      hasActiveQuery: false,
    });
    await service.insertRow({
      sessionId: session.sessionId,
      placement: 'below',
      rowIds: ['2'],
      hasActiveQuery: false,
    });
    const window = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 5 });

    expect(window.filteredRowCount).toBe(5);
    expect(rowIds(window.rows)).toEqual(['1', '4', '2', '5', '3']);
    expectVisibleRows(window.rows).toEqual([
      { name: 'Ada', code: '001' },
      { name: '', code: '' },
      { name: 'Grace', code: '002' },
      { name: '', code: '' },
      { name: 'Linus', code: '003' },
    ]);
    expect(service.getEditState({ sessionId: session.sessionId })).toEqual({
      sessionId: session.sessionId,
      dirty: true,
      canUndo: true,
      canRedo: false,
    });
  });

  it('appends an empty row when no row is selected', async () => {
    const filePath = await writeFixture('insert-append.csv', ['name,code', 'Ada,001'].join('\n'));

    const session = await service.openCsv(filePath);
    const result = await service.insertRow({
      sessionId: session.sessionId,
      placement: 'append',
      rowIds: [],
      hasActiveQuery: false,
    });
    const window = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 2 });

    expect(result).toEqual({
      sessionId: session.sessionId,
      dirty: true,
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
    const filePath = await writeFixture('insert-invalid.csv', ['name', 'Ada', 'Grace'].join('\n'));

    const session = await service.openCsv(filePath);

    await expect(
      service.insertRow({
        sessionId: session.sessionId,
        placement: 'above',
        rowIds: ['1'],
        hasActiveQuery: true,
      }),
    ).rejects.toThrow('cannot be inserted while sort, filter, or search is active');
    await expect(
      service.insertRow({
        sessionId: session.sessionId,
        placement: 'below',
        rowIds: ['1', '2'],
        hasActiveQuery: false,
      }),
    ).rejects.toThrow('requires exactly one selected CSV row');
    await expect(
      service.insertRow({
        sessionId: session.sessionId,
        placement: 'append',
        rowIds: ['1'],
        hasActiveQuery: false,
      }),
    ).rejects.toThrow('Append row requires no selected CSV rows');
    await expect(
      service.insertRow({
        sessionId: session.sessionId,
        placement: 'above',
        rowIds: ['missing'],
        hasActiveQuery: false,
      }),
    ).rejects.toThrow('CSV row no longer exists: missing');
  });

  it('undoes and redoes row insertion', async () => {
    const filePath = await writeFixture('insert-history.csv', ['name', 'Ada', 'Grace'].join('\n'));

    const session = await service.openCsv(filePath);
    await service.insertRow({
      sessionId: session.sessionId,
      placement: 'below',
      rowIds: ['1'],
      hasActiveQuery: false,
    });

    const afterInsert = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 3 });
    const undone = await service.undoEdit({ sessionId: session.sessionId });
    const afterUndo = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 3 });
    const redone = await service.redoEdit({ sessionId: session.sessionId });
    const afterRedo = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 3 });

    expect(rowIds(afterInsert.rows)).toEqual(['1', '3', '2']);
    expect(undone).toEqual({
      sessionId: session.sessionId,
      dirty: false,
      canUndo: false,
      canRedo: true,
    });
    expect(rowIds(afterUndo.rows)).toEqual(['1', '2']);
    expect(redone).toEqual({
      sessionId: session.sessionId,
      dirty: true,
      canUndo: true,
      canRedo: false,
    });
    expect(rowIds(afterRedo.rows)).toEqual(['1', '3', '2']);
  });

  it('saves edited, inserted, and non-deleted rows without internal row identifiers', async () => {
    const filePath = await writeFixture(
      'save-as.csv',
      ['name,code,note', 'Ada,001,first', 'Grace,002,second', 'Linus,003,third'].join('\n'),
    );
    const outputPath = path.join(tempDir, 'saved.csv');

    const session = await service.openCsv(filePath);
    await service.editCell({ sessionId: session.sessionId, rowId: '2', column: 'code', value: '00042' });
    await service.insertRow({
      sessionId: session.sessionId,
      placement: 'below',
      rowIds: ['1'],
      hasActiveQuery: false,
    });
    await service.editCell({ sessionId: session.sessionId, rowId: '4', column: 'name', value: 'New, Person' });
    await service.deleteRows({ sessionId: session.sessionId, rowIds: ['3'] });

    const state = await service.saveAs({ sessionId: session.sessionId }, outputPath);
    const saved = await readFile(outputPath, 'utf8');

    expect(saved).toBe(['name,code,note', 'Ada,001,first', '"New, Person",,', 'Grace,00042,second', ''].join('\n'));
    expect(saved).not.toContain(csvInternalRowIdField);
    expect(state).toEqual({
      sessionId: session.sessionId,
      dirty: false,
      canUndo: false,
      canRedo: false,
    });
    expect(service.hasUnsavedChanges()).toBe(false);
  });

  it('saves delimiter and header settings from the active dialect', async () => {
    const filePath = await writeFixture('save-no-header.txt', ['Ada|37', 'Grace|41'].join('\n'));
    const outputPath = path.join(tempDir, 'saved-no-header.txt');

    const session = await service.openCsv(filePath, { delimiter: '|', header: false });
    await service.editCell({ sessionId: session.sessionId, rowId: '1', column: 'column1', value: '38' });
    await service.saveAs({ sessionId: session.sessionId }, outputPath);

    await expect(readFile(outputPath, 'utf8')).resolves.toBe(['Ada|38', 'Grace|41', ''].join('\n'));
  });

  it('rejects stale sessions and oversized row windows', async () => {
    const firstPath = await writeFixture('first.csv', ['value', '1'].join('\n'));
    const secondPath = await writeFixture('second.csv', ['value', '2'].join('\n'));

    const first = await service.openCsv(firstPath);
    await service.openCsv(secondPath);

    await expect(service.getRows({ sessionId: first.sessionId, offset: 0, limit: 1 })).rejects.toThrow(
      'CSV session is no longer active',
    );
    await expect(
      service.getRows({ sessionId: service.getActiveSession()?.sessionId ?? '', offset: 0, limit: 1001 }),
    ).rejects.toThrow('1000 or less');
  });

  it('returns a clear error for missing files without keeping an active session', async () => {
    await expect(service.openCsv(path.join(tempDir, 'missing.csv'))).rejects.toThrow(
      'Unable to open CSV',
    );
    expect(service.getActiveSession()).toBeNull();
  });

  it('validates large-file access through bounded row windows', async () => {
    const rows = ['id,name,score'];

    for (let index = 0; index < 5000; index += 1) {
      rows.push(`${index},Person ${index},${index % 100}`);
    }

    const filePath = await writeFixture('large.csv', rows.join('\n'));
    const session = await service.openCsv(filePath);
    const firstWindow = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 100 });
    const laterWindow = await service.getRows({ sessionId: session.sessionId, offset: 4500, limit: 75 });

    expect(session.rowCount).toBe(5000);
    expect(firstWindow.rows).toHaveLength(100);
    expect(laterWindow.rows).toHaveLength(75);
    expect(laterWindow.rows[0]).toEqual({
      [csvInternalRowIdField]: '4501',
      id: '4500',
      name: 'Person 4500',
      score: '0',
    });
  });

  it('keeps edited large-file access bounded after edits, inserts, and deletes', async () => {
    const rows = ['id,name,score'];

    for (let index = 0; index < 5000; index += 1) {
      rows.push(`${index},Person ${index},${index % 100}`);
    }

    const filePath = await writeFixture('large-edited.csv', rows.join('\n'));
    const session = await service.openCsv(filePath);

    await service.editCell({ sessionId: session.sessionId, rowId: '4901', column: 'name', value: 'Edited Person' });
    await service.insertRow({
      sessionId: session.sessionId,
      placement: 'below',
      rowIds: ['4901'],
      hasActiveQuery: false,
    });
    await service.deleteRows({ sessionId: session.sessionId, rowIds: ['4902', '4903'] });

    const window = await service.getRows({ sessionId: session.sessionId, offset: 4899, limit: 5 });

    expect(window.filteredRowCount).toBe(4999);
    expect(window.rows).toHaveLength(5);
    expect(rowIds(window.rows)).toEqual(['4900', '4901', '5001', '4904', '4905']);
    expect(window.rows[1].name).toBe('Edited Person');
    expect(window.rows[2]).toMatchObject({ id: '', name: '', score: '' });
  });

  it('validates wide-file access without requiring all columns to be manually mapped', async () => {
    const headers = Array.from({ length: 120 }, (_value, index) => `metric_${index}`);
    const row = headers.map((_header, index) => String(index));
    const filePath = await writeFixture('wide.csv', [headers.join(','), row.join(',')].join('\n'));

    const session = await service.openCsv(filePath);
    const window = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 1 });

    expect(session.columns).toHaveLength(120);
    expect(window.rows).toHaveLength(1);
    expect(window.rows[0].metric_0).toBe('0');
    expect(window.rows[0].metric_119).toBe('119');
  });

  it('returns a distinct error for unsupported files', async () => {
    const filePath = await writeFixture('people.json', '{"name":"Ada"}');

    await expect(service.openCsv(filePath)).rejects.toThrow('Unsupported file type');
  });
});

async function writeFixture(fileName: string, content: string): Promise<string> {
  const filePath = path.join(tempDir, fileName);
  await writeFile(filePath, content);
  return filePath;
}

function rowIds(rows: CsvRow[]): string[] {
  return rows.map((row) => row[csvInternalRowIdField]);
}

function expectVisibleRows(rows: CsvRow[]) {
  return expect(rows.map(({ [csvInternalRowIdField]: _rowId, ...visibleRow }) => visibleRow));
}
