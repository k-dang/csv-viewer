import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
