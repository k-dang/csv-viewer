import { link } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csvInternalRowIdField, type CsvRow, type WorkingCsvId } from '../shared/csv-viewer-contract';
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

describe('CsvWorkspace Working CSV querying', () => {
  it('opens a CSV Source and returns its description, inferred columns, and row count', async () => {
    const workingCsv = await fixture.openSource(
      'people.csv',
      ['name,age,joined', 'Ada,37,2024-01-10', 'Grace,41,2024-02-12'].join('\n'),
    );

    expect(workingCsv.file.name).toBe('people.csv');
    expect(workingCsv.file.location).toBe(fixture.file('people.csv'));
    expect(workingCsv.file.sourceId).toBeTruthy();
    expect(workingCsv.file.sizeBytes).toBeGreaterThan(0);
    expect(workingCsv.rowCount).toBe(2);
    expect(workingCsv.columns.map((column) => column.name)).toEqual(['name', 'age', 'joined']);
    expect(workingCsv.columns.map((column) => column.type)).toEqual(['VARCHAR', 'VARCHAR', 'VARCHAR']);
    await expect(workspace().getWorkingCsv(workingCsv.workingCsvId)).resolves.toEqual(workingCsv);
  });

  it('handles quoted fields and escaped delimiters through DuckDB CSV parsing', async () => {
    const workingCsv = await fixture.openSource(
      'quoted.csv',
      ['name,note', 'Ada,"uses commas, quotes ""well"", and new lines"', 'Grace,"plain"'].join('\n'),
    );

    expect(workingCsv.rowCount).toBe(2);
    expect(workingCsv.columns.map((column) => column.name)).toEqual(['name', 'note']);
  });

  it('opens CSV Sources with a delimiter override', async () => {
    const workingCsv = await fixture.openSource(
      'pipe.csv',
      ['name|age', 'Ada|37', 'Grace|41'].join('\n'),
      { delimiter: '|' },
    );
    const window = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 2,
    });

    expect(workingCsv.dialect).toEqual({ delimiter: '|' });
    expect(workingCsv.columns.map((column) => column.name)).toEqual(['name', 'age']);
    expectVisibleRows(window.rows).toEqual([
      { name: 'Ada', age: '37' },
      { name: 'Grace', age: '41' },
    ]);
    expect(rowIds(window.rows)).toEqual(['1', '2']);
  });

  it('opens CSV Sources with a header override', async () => {
    const workingCsv = await fixture.openSource(
      'no-header.csv',
      ['Ada,37', 'Grace,41'].join('\n'),
      { header: false },
    );
    const window = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 2,
    });

    expect(workingCsv.dialect).toEqual({ header: false });
    expect(workingCsv.columns.map((column) => column.name)).toEqual(['column0', 'column1']);
    expectVisibleRows(window.rows).toEqual([
      { column0: 'Ada', column1: '37' },
      { column0: 'Grace', column1: '41' },
    ]);
    expect(rowIds(window.rows)).toEqual(['1', '2']);
  });

  it('reopens a Working CSV behind its stable identity with a new revision', async () => {
    const auto = await fixture.openSource('reopen.txt', ['name|age', 'Ada|37'].join('\n'));
    const outcome = await workspace().reopenCsv(auto.workingCsvId, { delimiter: '|' });
    if (outcome.status !== 'replaced') throw new Error(`Reopen was ${outcome.status}.`);
    const reopened = outcome.workingCsv;

    expect(reopened.workingCsvId).toBe(auto.workingCsvId);
    expect(reopened.dataRevision).toBe(auto.dataRevision + 1);
    expect(reopened.file.sourceId).toBe(auto.file.sourceId);
    expect(reopened.dialect).toEqual({ delimiter: '|' });
    expect(reopened.columns.map((column) => column.name)).toEqual(['name', 'age']);
    await expect(workspace().getWorkingCsv(reopened.workingCsvId)).resolves.toEqual(reopened);
  });

  it('increments revisions and notifies dependents for every committed data change', async () => {
    const workingCsv = await fixture.openSource('revisions.csv', ['name', 'Ada', 'Grace'].join('\n'));
    const request = { workingCsvId: workingCsv.workingCsvId };

    await workspace().editCsvCell({ ...request, rowId: '1', column: 'name', value: 'Augusta Ada' });
    await workspace().insertCsvRow({ ...request, placement: 'append', rowIds: [], hasActiveQuery: false });
    const rows = await workspace().getCsvRows({ ...request, offset: 0, limit: 10 });
    await workspace().deleteCsvRows({
      ...request,
      rowIds: [rows.rows.at(-1)?.[csvInternalRowIdField] ?? ''],
    });
    await workspace().undoCsvEdit(request);
    await workspace().redoCsvEdit(request);
    await workspace().reopenCsv(workingCsv.workingCsvId);

    const current = await workspace().getWorkingCsv(workingCsv.workingCsvId);
    expect(current?.dataRevision).toBe(6);
  });

  it('reports why a CSV Source could not be opened', async () => {
    const filePath = await fixture.writeSource(
      'invalid-delimiter.csv',
      ['name,age', 'Ada,37'].join('\n'),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      workspace().openRecentCsv(await fixture.sourceId(filePath), { delimiter: '||' }),
    ).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('Delimiter must be exactly one character'),
    });
    error.mockRestore();
  });

  it('keeps the existing Working CSV when a reopen option is invalid', async () => {
    const workingCsv = await fixture.openSource('keep-active.csv', ['name,age', 'Ada,37'].join('\n'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      workspace().reopenCsv(workingCsv.workingCsvId, { delimiter: '||' }),
    ).resolves.toMatchObject({
      status: 'failed',
      failure: { message: expect.stringContaining('Delimiter must be exactly one character') },
    });
    await expect(workspace().getWorkingCsv(workingCsv.workingCsvId)).resolves.toEqual(workingCsv);
    error.mockRestore();
  });

  it('keeps multiple Working CSVs open with independent data', async () => {
    const first = await fixture.openSource('first.csv', ['a', '1'].join('\n'));
    const second = await fixture.openSource('second.csv', ['b,c', '2,3', '4,5'].join('\n'));

    expect(second.workingCsvId).not.toBe(first.workingCsvId);
    await expect(workspace().getWorkingCsv(first.workingCsvId)).resolves.toEqual(first);
    await expect(workspace().getWorkingCsv(second.workingCsvId)).resolves.toEqual(second);

    const firstRows = await workspace().getCsvRows({
      workingCsvId: first.workingCsvId,
      offset: 0,
      limit: 10,
    });
    const secondRows = await workspace().getCsvRows({
      workingCsvId: second.workingCsvId,
      offset: 0,
      limit: 10,
    });

    expect(firstRows.filteredRowCount).toBe(1);
    expect(secondRows.filteredRowCount).toBe(2);
    expect(second.columns.map((column) => column.name)).toEqual(['b', 'c']);
  });

  it('gives a known CSV Source at most one Working CSV', async () => {
    const filePath = await fixture.writeSource('dedupe.csv', ['a', '1'].join('\n'));
    const aliasPath = fixture.file('dedupe-alias.csv');
    await link(filePath, aliasPath);
    const workingCsv = await fixture.open(filePath);

    await expect(
      workspace().openRecentCsv(await fixture.sourceId(filePath)),
    ).resolves.toEqual({ status: 'already-open', workingCsv });
    await expect(
      workspace().openRecentCsv(await fixture.sourceId(aliasPath)),
    ).resolves.toEqual({ status: 'already-open', workingCsv });
  });

  it('keeps edit journals independent per Working CSV', async () => {
    const first = await fixture.openSource('journal-first.csv', ['name', 'Ada'].join('\n'));
    const second = await fixture.openSource('journal-second.csv', ['name', 'Grace'].join('\n'));

    await workspace().editCsvCell({
      workingCsvId: first.workingCsvId,
      rowId: '1',
      column: 'name',
      value: 'Edited',
    });

    await expect(editState(first.workingCsvId)).resolves.toMatchObject({
      hasUnexportedChanges: true,
    });
    await expect(editState(second.workingCsvId)).resolves.toMatchObject({
      hasUnexportedChanges: false,
      canUndo: false,
    });
    await expect(workspace().confirmWindowClose()).resolves.toMatchObject({
      status: 'confirmation-required',
      impact: { workingCsvsWithUnexportedChanges: [{ workingCsvId: first.workingCsvId }] },
    });

    await expect(
      workspace().undoCsvEdit({ workingCsvId: second.workingCsvId }),
    ).rejects.toThrow('No CSV edit is available to undo');

    await workspace().undoCsvEdit({ workingCsvId: first.workingCsvId });
    await expect(workspace().confirmWindowClose()).resolves.toEqual({ status: 'ready' });
  });

  it('closes a Working CSV and leaves other Working CSVs untouched', async () => {
    const firstPath = await fixture.writeSource('close-first.csv', ['a', '1'].join('\n'));
    const first = await fixture.open(firstPath);
    const second = await fixture.openSource('close-second.csv', ['b', '2'].join('\n'));

    await expect(
      workspace().closeCsv({ workingCsvId: first.workingCsvId }),
    ).resolves.toMatchObject({ status: 'closed' });

    await expect(workspace().getWorkingCsv(first.workingCsvId)).resolves.toBeNull();
    await expect(
      workspace().getCsvRows({ workingCsvId: first.workingCsvId, offset: 0, limit: 1 }),
    ).rejects.toThrow('Working CSV is no longer active');
    await expect(workspace().openRecentCsv(await fixture.sourceId(firstPath))).resolves.toMatchObject(
      { status: 'opened' },
    );

    const secondRows = await workspace().getCsvRows({
      workingCsvId: second.workingCsvId,
      offset: 0,
      limit: 10,
    });
    expect(secondRows.filteredRowCount).toBe(1);
  });

  it('reopens one Working CSV without disturbing another', async () => {
    const first = await fixture.openSource(
      'reopen-isolated-first.txt',
      ['name|score', 'Ada|10'].join('\n'),
    );
    const second = await fixture.openSource(
      'reopen-isolated-second.csv',
      ['name,score', 'Grace,20'].join('\n'),
    );
    const outcome = await workspace().reopenCsv(first.workingCsvId, { delimiter: '|' });
    if (outcome.status !== 'replaced') throw new Error(`Reopen was ${outcome.status}.`);

    expect(outcome.workingCsv.workingCsvId).toBe(first.workingCsvId);
    expect(outcome.workingCsv.dataRevision).toBe(first.dataRevision + 1);
    await expect(workspace().getWorkingCsv(second.workingCsvId)).resolves.toEqual(second);

    const reopenedRows = await workspace().getCsvRows({
      workingCsvId: first.workingCsvId,
      offset: 0,
      limit: 10,
    });
    const secondRows = await workspace().getCsvRows({
      workingCsvId: second.workingCsvId,
      offset: 0,
      limit: 10,
    });

    expectVisibleRows(reopenedRows.rows).toEqual([{ name: 'Ada', score: '10' }]);
    expectVisibleRows(secondRows.rows).toEqual([{ name: 'Grace', score: '20' }]);
  });

  it('returns bounded row windows without reading the full CSV', async () => {
    const workingCsv = await fixture.openSource(
      'window.csv',
      ['name,age,note', 'Ada,37,first', 'Grace,41,second', 'Linus,54,third'].join('\n'),
    );
    const window = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 1,
      limit: 1,
    });

    expect(window).toEqual({
      workingCsvId: workingCsv.workingCsvId,
      offset: 1,
      filteredRowCount: 3,
      rows: [{ [csvInternalRowIdField]: '2', name: 'Grace', age: '41', note: 'second' }],
    });
  });

  it('preserves text-like values and null values distinctly in row windows', async () => {
    const workingCsv = await fixture.openSource(
      'missing.csv',
      ['name,note,score,identifier', 'Ada,,10,00123', 'Grace,NULL,,00042'].join('\n'),
    );
    const window = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 2,
    });

    expectVisibleRows(window.rows).toEqual([
      { name: 'Ada', note: null, score: '10', identifier: '00123' },
      { name: 'Grace', note: 'NULL', score: null, identifier: '00042' },
    ]);
    expect(rowIds(window.rows)).toEqual(['1', '2']);
  });

  it('sorts rows by a structured column descriptor and clears sort by omitting descriptors', async () => {
    const workingCsv = await fixture.openSource(
      'sort.csv',
      ['name,age', 'Ada,37', 'Grace,41', 'Linus,54'].join('\n'),
    );
    const sorted = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 3,
      sort: [{ column: 'age', direction: 'desc' }],
    });
    const originalOrder = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 3,
    });

    expect(sorted.rows.map((row) => row.name)).toEqual(['Linus', 'Grace', 'Ada']);
    expect(originalOrder.rows.map((row) => row.name)).toEqual(['Ada', 'Grace', 'Linus']);
  });

  it('keeps hidden row identifiers stable across sorting, filtering, search, and pagination', async () => {
    const workingCsv = await fixture.openSource(
      'stable-row-ids.csv',
      [
        'name,age,team',
        'Ada,37,compiler',
        'Grace,41,navy',
        'Linus,54,kernel',
        'Margaret,87,compiler',
      ].join('\n'),
    );
    const request = { workingCsvId: workingCsv.workingCsvId, offset: 0 };

    const firstPage = await workspace().getCsvRows({ ...request, limit: 2 });
    const sorted = await workspace().getCsvRows({
      ...request,
      limit: 4,
      sort: [{ column: 'name', direction: 'desc' }],
    });
    const filtered = await workspace().getCsvRows({
      ...request,
      limit: 4,
      filters: [{ column: 'team', kind: 'text', operator: 'contains', value: 'compiler' }],
    });
    const searched = await workspace().getCsvRows({ ...request, limit: 4, search: 'Grace' });

    expect(workingCsv.columns.map((column) => column.name)).not.toContain(csvInternalRowIdField);
    expect(rowIds(firstPage.rows)).toEqual(['1', '2']);
    expect(rowIds(sorted.rows)).toEqual(['4', '3', '2', '1']);
    expect(rowIds(filtered.rows)).toEqual(['1', '4']);
    expect(rowIds(searched.rows)).toEqual(['2']);
  });

  it('applies text, numeric, and combined filters with filtered row counts', async () => {
    const workingCsv = await fixture.openSource(
      'filters.csv',
      [
        'name,age,team',
        'Ada,37,compiler',
        'Grace,41,navy',
        'Linus,54,kernel',
        'Margaret,87,compiler',
      ].join('\n'),
    );
    const window = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
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
    const workingCsv = await fixture.openSource(
      'dates.csv',
      ['name,joined', 'Ada,2024-01-10', 'Grace,2024-02-12', 'Linus,2024-03-20'].join('\n'),
    );
    const window = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 10,
      filters: [
        { column: 'joined', kind: 'date', operator: 'greaterThanOrEqual', value: '2024-02-01' },
      ],
    });

    expect(window.filteredRowCount).toBe(2);
    expect(window.rows.map((row) => row.name)).toEqual(['Grace', 'Linus']);
  });

  it('handles unusual column names and parameterized filter values', async () => {
    const workingCsv = await fixture.openSource(
      'unusual.csv',
      [
        '"full name","select","quote""name"',
        '"Ada Lovelace","alpha","safe"',
        '"Grace Hopper","beta","unsafe"',
      ].join('\n'),
    );
    const window = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 10,
      sort: [{ column: 'full name', direction: 'desc' }],
      filters: [
        { column: 'quote"name', kind: 'text', operator: 'contains', value: `safe' OR 1=1 --` },
      ],
    });

    expect(window.filteredRowCount).toBe(0);
    expect(window.rows).toEqual([]);
  });

  it('searches across columns and returns matching row counts', async () => {
    const workingCsv = await fixture.openSource(
      'search.csv',
      [
        'name,age,team',
        'Ada,37,compiler',
        'Grace,41,navy',
        'Linus,54,kernel',
        'Margaret,87,compiler',
      ].join('\n'),
    );
    const window = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 10,
      search: 'comp',
    });

    expect(window.filteredRowCount).toBe(2);
    expect(window.rows.map((row) => row.name)).toEqual(['Ada', 'Margaret']);
  });

  it('returns top Column Value Counts with percentages and deterministic ordering', async () => {
    const workingCsv = await fixture.openSource(
      'value-counts.csv',
      [
        'status,note',
        'Open,one',
        'open,two',
        'Open,three',
        'Closed,four',
        'Closed,five',
        'Pending,six',
      ].join('\n'),
    );
    const counts = await workspace().getCsvColumnValueCounts({
      workingCsvId: workingCsv.workingCsvId,
      column: 'status',
    });

    expect(counts).toEqual({
      workingCsvId: workingCsv.workingCsvId,
      column: 'status',
      scopeRowCount: 6,
      values: [
        { value: 'Closed', count: 2, percentOfScope: expect.closeTo(33.333, 3) },
        { value: 'Open', count: 2, percentOfScope: expect.closeTo(33.333, 3) },
        { value: 'Pending', count: 1, percentOfScope: expect.closeTo(16.667, 3) },
        { value: 'open', count: 1, percentOfScope: expect.closeTo(16.667, 3) },
      ],
    });
  });

  it('keeps blank strings and null cells as separate counted values', async () => {
    const workingCsv = await fixture.openSource(
      'value-counts-blanks.csv',
      ['status,note', 'Open,one', ',edited empty', 'NULL,literal null', ',parsed null'].join('\n'),
    );
    await workspace().editCsvCell({
      workingCsvId: workingCsv.workingCsvId,
      rowId: '2',
      column: 'status',
      value: '',
    });
    const counts = await workspace().getCsvColumnValueCounts({
      workingCsvId: workingCsv.workingCsvId,
      column: 'status',
    });

    expect(counts.scopeRowCount).toBe(4);
    expect(counts.values).toEqual([
      { value: null, count: 1, percentOfScope: 25 },
      { value: '', count: 1, percentOfScope: 25 },
      { value: 'NULL', count: 1, percentOfScope: 25 },
      { value: 'Open', count: 1, percentOfScope: 25 },
    ]);
  });

  it('limits Column Value Counts to the top 50 values', async () => {
    const rows = ['code'];
    for (let index = 0; index < 55; index += 1) {
      rows.push(`value-${String(index).padStart(2, '0')}`);
    }

    const workingCsv = await fixture.openSource('value-counts-top-50.csv', rows.join('\n'));
    const counts = await workspace().getCsvColumnValueCounts({
      workingCsvId: workingCsv.workingCsvId,
      column: 'code',
    });

    expect(counts.scopeRowCount).toBe(55);
    expect(counts.values).toHaveLength(50);
    expect(counts.values[0].value).toBe('value-00');
    expect(counts.values.at(-1)?.value).toBe('value-49');
  });

  it('applies Count Scope from filters and search while ignoring sort order', async () => {
    const workingCsv = await fixture.openSource(
      'value-counts-scope.csv',
      [
        'name,status,team,score',
        'Ada,Open,compiler,10',
        'Grace,Closed,navy,30',
        'Linus,Open,kernel,20',
        'Margaret,Open,compiler,40',
        'Barbara,Closed,compiler,50',
      ].join('\n'),
    );
    const scope = {
      filters: [
        { column: 'team', kind: 'text', operator: 'equals', value: 'compiler' },
      ] as const,
      search: 'a',
    };
    const counts = await workspace().getCsvColumnValueCounts({
      workingCsvId: workingCsv.workingCsvId,
      column: 'status',
      filters: [...scope.filters],
      search: scope.search,
    });
    const sortedRows = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 10,
      sort: [{ column: 'score', direction: 'desc' }],
      filters: [...scope.filters],
      search: scope.search,
    });

    expect(sortedRows.rows.map((row) => row.name)).toEqual(['Barbara', 'Margaret', 'Ada']);
    expect(counts.scopeRowCount).toBe(3);
    expect(counts.values).toEqual([
      { value: 'Open', count: 2, percentOfScope: expect.closeTo(66.667, 3) },
      { value: 'Closed', count: 1, percentOfScope: expect.closeTo(33.333, 3) },
    ]);
  });

  it('returns an empty count list when Count Scope has no rows', async () => {
    const workingCsv = await fixture.openSource(
      'value-counts-empty-scope.csv',
      ['status', 'Open'].join('\n'),
    );
    const counts = await workspace().getCsvColumnValueCounts({
      workingCsvId: workingCsv.workingCsvId,
      column: 'status',
      search: 'missing',
    });

    expect(counts).toEqual({
      workingCsvId: workingCsv.workingCsvId,
      column: 'status',
      scopeRowCount: 0,
      values: [],
    });
  });

  it('counts values from the Working CSV after edits, inserts, deletes, undo, and redo', async () => {
    const workingCsv = await fixture.openSource(
      'value-counts-working.csv',
      ['status,team', 'Open,compiler', 'Closed,compiler', 'Open,kernel'].join('\n'),
    );
    const request = { workingCsvId: workingCsv.workingCsvId };
    const countsRequest = {
      ...request,
      column: 'status',
      filters: [{ column: 'team', kind: 'text', operator: 'equals', value: 'compiler' }] as const,
    };

    await workspace().editCsvCell({ ...request, rowId: '2', column: 'status', value: 'Open' });
    await workspace().insertCsvRow({ ...request, placement: 'append', rowIds: [], hasActiveQuery: false });
    await workspace().editCsvCell({ ...request, rowId: '4', column: 'status', value: 'Pending' });
    await workspace().editCsvCell({ ...request, rowId: '4', column: 'team', value: 'compiler' });
    await workspace().deleteCsvRows({ ...request, rowIds: ['1'] });

    const afterChanges = await workspace().getCsvColumnValueCounts({
      ...countsRequest,
      filters: [...countsRequest.filters],
    });
    await workspace().undoCsvEdit(request);
    const afterUndo = await workspace().getCsvColumnValueCounts({
      ...countsRequest,
      filters: [...countsRequest.filters],
    });
    await workspace().redoCsvEdit(request);
    const afterRedo = await workspace().getCsvColumnValueCounts({
      ...countsRequest,
      filters: [...countsRequest.filters],
    });

    expect(afterChanges.values).toEqual([
      { value: 'Open', count: 1, percentOfScope: 50 },
      { value: 'Pending', count: 1, percentOfScope: 50 },
    ]);
    expect(afterUndo.values).toEqual([
      { value: 'Open', count: 2, percentOfScope: expect.closeTo(66.667, 3) },
      { value: 'Pending', count: 1, percentOfScope: expect.closeTo(33.333, 3) },
    ]);
    expect(afterRedo.values).toEqual(afterChanges.values);
  });

  it('returns no rows for searches without matches and clears search when omitted', async () => {
    const workingCsv = await fixture.openSource(
      'search-clear.csv',
      ['name,team', 'Ada,compiler', 'Grace,navy'].join('\n'),
    );
    const noResults = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 10,
      search: 'missing',
    });
    const cleared = await workspace().getCsvRows({
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 10,
    });

    expect(noResults.filteredRowCount).toBe(0);
    expect(noResults.rows).toEqual([]);
    expect(cleared.filteredRowCount).toBe(2);
    expect(cleared.rows.map((row) => row.name)).toEqual(['Ada', 'Grace']);
  });

  it('composes search with active filters using parameterized search values', async () => {
    const workingCsv = await fixture.openSource(
      'search-filter.csv',
      [
        '"full name",age,team',
        '"Ada Lovelace",37,compiler',
        '"Grace Hopper",41,navy',
        '"Margaret Hamilton",87,compiler',
      ].join('\n'),
    );
    const request = {
      workingCsvId: workingCsv.workingCsvId,
      offset: 0,
      limit: 10,
      filters: [{ column: 'age', kind: 'number', operator: 'greaterThan', value: 40 }] as const,
    };
    const filteredSearch = await workspace().getCsvRows({
      ...request,
      filters: [...request.filters],
      search: 'compiler',
    });
    const parameterizedSearch = await workspace().getCsvRows({
      ...request,
      filters: [...request.filters],
      search: `compiler%' OR 1=1 --`,
    });

    expect(filteredSearch.filteredRowCount).toBe(1);
    expect(filteredSearch.rows.map((row) => row['full name'])).toEqual(['Margaret Hamilton']);
    expect(parameterizedSearch.filteredRowCount).toBe(0);
    expect(parameterizedSearch.rows).toEqual([]);
  });

});

function rowIds(rows: CsvRow[]): string[] {
  return rows.map((row) => row[csvInternalRowIdField]);
}

function expectVisibleRows(rows: CsvRow[]) {
  return expect(rows.map(({ [csvInternalRowIdField]: _rowId, ...visibleRow }) => visibleRow));
}
