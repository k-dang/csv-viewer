import { link, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csvInternalRowIdField, type CsvRow } from '../shared/ipc';
import { WorkingCsvStore } from './working-csv-store';
import type { WorkspaceArtifactRegistry } from './workspace-artifact-registry';

let tempDir: string;
let service: WorkingCsvStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'csv-viewer-'));
  service = new WorkingCsvStore();
});

afterEach(async () => {
  try {
    await service.disposeStore();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe('WorkingCsvStore', () => {
  it('closes database handles when disposal validation fails', async () => {
    const filePath = await writeFixture('dispose-failure.csv', ['id', '1'].join('\n'));
    await service.openOrThrow(filePath);
    const internals = service as unknown as {
      artifactRegistry: WorkspaceArtifactRegistry;
      connection: { closeSync(): void } | null;
      instance: { closeSync(): void } | null;
      lifecycle: string;
    };
    const connectionClose = vi.spyOn(internals.connection!, 'closeSync');
    const instanceClose = vi.spyOn(internals.instance!, 'closeSync');
    internals.artifactRegistry.register({
      tableName: 'unexpected_artifact',
      owner: { kind: 'working-csv', workingCsvId: 'missing' },
      role: 'current',
    });

    await expect(service.disposeStore()).rejects.toThrow(
      'Workspace artifact invariant violated',
    );
    expect(connectionClose).toHaveBeenCalledOnce();
    expect(instanceClose).toHaveBeenCalledOnce();
    expect(internals.connection).toBeNull();
    expect(internals.instance).toBeNull();
    expect(internals.lifecycle).toBe('disposed');

    internals.artifactRegistry.remove('unexpected_artifact');
  });

  it('opens a CSV and returns file metadata, inferred columns, and row count', async () => {
    const filePath = await writeFixture(
      'people.csv',
      ['name,age,joined', 'Ada,37,2024-01-10', 'Grace,41,2024-02-12'].join('\n'),
    );

    const session = await service.openOrThrow(filePath);

    expect(session.file.name).toBe('people.csv');
    expect(session.file.path).toBe(filePath);
    expect(session.file.sizeBytes).toBeGreaterThan(0);
    expect(session.rowCount).toBe(2);
    expect(session.columns.map((column) => column.name)).toEqual(['name', 'age', 'joined']);
    expect(session.columns.map((column) => column.type)).toEqual(['VARCHAR', 'VARCHAR', 'VARCHAR']);
    expect(service.getState(session.workingCsvId)?.workingCsvId).toBe(session.workingCsvId);
  });

  it('handles quoted fields and escaped delimiters through DuckDB CSV parsing', async () => {
    const filePath = await writeFixture(
      'quoted.csv',
      ['name,note', 'Ada,"uses commas, quotes ""well"", and new lines"', 'Grace,"plain"'].join(
        '\n',
      ),
    );

    const session = await service.openOrThrow(filePath);

    expect(session.rowCount).toBe(2);
    expect(session.columns.map((column) => column.name)).toEqual(['name', 'note']);
  });

  it('opens files with a delimiter override', async () => {
    const filePath = await writeFixture('pipe.csv', ['name|age', 'Ada|37', 'Grace|41'].join('\n'));

    const session = await service.openOrThrow(filePath, { delimiter: '|' });
    const window = await service.getRows({ workingCsvId: session.workingCsvId, offset: 0, limit: 2 });

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

    const session = await service.openOrThrow(filePath, { header: false });
    const window = await service.getRows({ workingCsvId: session.workingCsvId, offset: 0, limit: 2 });

    expect(session.dialect).toEqual({ header: false });
    expect(session.columns.map((column) => column.name)).toEqual(['column0', 'column1']);
    expectVisibleRows(window.rows).toEqual([
      { column0: 'Ada', column1: '37' },
      { column0: 'Grace', column1: '41' },
    ]);
    expect(rowIds(window.rows)).toEqual(['1', '2']);
  });

  it('reopens a Working CSV behind its stable identity with a new revision', async () => {
    const filePath = await writeFixture('reopen.txt', ['name|age', 'Ada|37'].join('\n'));

    const auto = await service.openOrThrow(filePath);
    const reopened = await service.replaceOrThrow(auto.workingCsvId, { delimiter: '|' });

    expect(reopened.workingCsvId).toBe(auto.workingCsvId);
    expect(reopened.dataRevision).toBe(auto.dataRevision + 1);
    expect(reopened.file.path).toBe(filePath);
    expect(reopened.dialect).toEqual({ delimiter: '|' });
    expect(reopened.columns.map((column) => column.name)).toEqual(['name', 'age']);
    expect(service.getState(reopened.workingCsvId)).toEqual(reopened);
  });

  it('blocks every state mutator while a session close is reserved', async () => {
    const filePath = await writeFixture('closing.csv', ['name', 'Ada'].join('\n'));
    const session = await service.openOrThrow(filePath);
    const request = { workingCsvId: session.workingCsvId };

    expect(service.beginClose(session.workingCsvId)).toBe(true);
    expect(service.beginClose(session.workingCsvId)).toBe(false);
    expect(service.isClosing(session.workingCsvId)).toBe(true);

    const mutations = [
      service.replaceOrThrow(session.workingCsvId),
      service.editCell({ ...request, rowId: '1', column: 'name', value: 'Grace' }),
      service.deleteRows({ ...request, rowIds: ['1'] }),
      service.insertRow({ ...request, placement: 'append' as const, rowIds: [], hasActiveQuery: false }),
      service.undo(request.workingCsvId),
      service.redo(request.workingCsvId),
      service.exportCsv(request.workingCsvId, path.join(tempDir, 'closing-copy.csv')),
    ];
    for (const mutation of mutations) await expect(mutation).rejects.toThrow('closing');

    service.endClose(session.workingCsvId);
    expect(service.isClosing(session.workingCsvId)).toBe(false);
    await expect(
      service.editCell({ ...request, rowId: '1', column: 'name', value: 'Grace' }),
    ).resolves.toMatchObject({ hasUnexportedChanges: true });
  });

  it('increments revisions and notifies subscribers for every committed data change', async () => {
    const filePath = await writeFixture('revisions.csv', ['name', 'Ada', 'Grace'].join('\n'));
    const session = await service.openOrThrow(filePath);
    const revisions: number[] = [];
    const unsubscribe = service.subscribeToDataChanges((workingCsvId) => {
      revisions.push(service.getState(workingCsvId)?.dataRevision ?? -1);
    });

    await service.editCell({
      workingCsvId: session.workingCsvId,
      rowId: '1',
      column: 'name',
      value: 'Augusta Ada',
    });
    await service.insertRow({
      workingCsvId: session.workingCsvId,
      placement: 'append',
      rowIds: [],
      hasActiveQuery: false,
    });
    const rows = await service.getRows({ workingCsvId: session.workingCsvId, offset: 0, limit: 10 });
    await service.deleteRows({
      workingCsvId: session.workingCsvId,
      rowIds: [rows.rows.at(-1)?.[csvInternalRowIdField] ?? ''],
    });
    await service.undo(session.workingCsvId);
    await service.redo(session.workingCsvId);
    await service.replaceOrThrow(session.workingCsvId);
    unsubscribe();

    expect(revisions).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('isolates data-change listeners so one failure cannot suppress later listeners', async () => {
    const filePath = await writeFixture('listeners.csv', ['name', 'Ada'].join('\n'));
    const session = await service.openOrThrow(filePath);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const received: string[] = [];
    service.subscribeToDataChanges(() => {
      throw new Error('listener failure');
    });
    service.subscribeToDataChanges((workingCsvId) => received.push(workingCsvId));

    await service.editCell({
      workingCsvId: session.workingCsvId,
      rowId: '1',
      column: 'name',
      value: 'Grace',
    });

    expect(received).toEqual([session.workingCsvId]);
    expect(service.getState(session.workingCsvId)?.dataRevision).toBe(1);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('rejects invalid delimiter choices before opening', async () => {
    const filePath = await writeFixture('invalid-delimiter.csv', ['name,age', 'Ada,37'].join('\n'));

    await expect(service.openOrThrow(filePath, { delimiter: '||' })).rejects.toThrow(
      'Delimiter must be exactly one character',
    );
  });

  it('keeps the existing session when a reopen option is invalid', async () => {
    const filePath = await writeFixture('keep-active.csv', ['name,age', 'Ada,37'].join('\n'));
    const session = await service.openOrThrow(filePath);

    await expect(service.replaceOrThrow(session.workingCsvId, { delimiter: '||' })).rejects.toThrow(
      'Delimiter must be exactly one character',
    );

    expect(service.getState(session.workingCsvId)).toEqual(session);
  });

  it('keeps multiple sessions open with independent data', async () => {
    const firstPath = await writeFixture('first.csv', ['a', '1'].join('\n'));
    const secondPath = await writeFixture('second.csv', ['b,c', '2,3', '4,5'].join('\n'));

    const first = await service.openOrThrow(firstPath);
    const second = await service.openOrThrow(secondPath);

    expect(second.workingCsvId).not.toBe(first.workingCsvId);
    expect(service.getState(first.workingCsvId)).toEqual(first);
    expect(service.getState(second.workingCsvId)).toEqual(second);

    const firstRows = await service.getRows({ workingCsvId: first.workingCsvId, offset: 0, limit: 10 });
    const secondRows = await service.getRows({ workingCsvId: second.workingCsvId, offset: 0, limit: 10 });

    expect(firstRows.filteredRowCount).toBe(1);
    expect(secondRows.filteredRowCount).toBe(2);
    expect(second.columns.map((column) => column.name)).toEqual(['b', 'c']);
  });

  it('rejects opening a file that is already open and finds it by path', async () => {
    const filePath = await writeFixture('dedupe.csv', ['a', '1'].join('\n'));

    const session = await service.openOrThrow(filePath);

    expect(service.findByPath(filePath)).toEqual(session);
    await expect(service.openOrThrow(filePath)).rejects.toThrow('CSV file is already open');
    expect(service.findByPath(path.join(tempDir, 'other.csv'))).toBeNull();
  });

  it('keeps edit journals independent per Working CSV', async () => {
    const firstPath = await writeFixture('journal-first.csv', ['name', 'Ada'].join('\n'));
    const secondPath = await writeFixture('journal-second.csv', ['name', 'Grace'].join('\n'));

    const first = await service.openOrThrow(firstPath);
    const second = await service.openOrThrow(secondPath);

    await service.editCell({
      workingCsvId: first.workingCsvId,
      rowId: '1',
      column: 'name',
      value: 'Edited',
    });

    expect(service.hasUnexportedChanges(first.workingCsvId)).toBe(true);
    expect(service.hasUnexportedChanges(second.workingCsvId)).toBe(false);
    expect(
      service.getWithUnexportedChanges().map((workingCsv) => workingCsv.workingCsvId),
    ).toEqual([
      first.workingCsvId,
    ]);
    expect(service.getEditState({ workingCsvId: second.workingCsvId }).canUndo).toBe(false);

    await expect(service.undo(second.workingCsvId)).rejects.toThrow(
      'No CSV edit is available to undo',
    );

    await service.undo(first.workingCsvId);
    expect(service.getWithUnexportedChanges()).toEqual([]);
  });

  it('closes a session and leaves other sessions untouched', async () => {
    const firstPath = await writeFixture('close-first.csv', ['a', '1'].join('\n'));
    const secondPath = await writeFixture('close-second.csv', ['b', '2'].join('\n'));

    const first = await service.openOrThrow(firstPath);
    const second = await service.openOrThrow(secondPath);

    await service.closeWorkingCsv(first.workingCsvId);

    expect(service.getState(first.workingCsvId)).toBeNull();
    expect(service.findByPath(firstPath)).toBeNull();
    await expect(
      service.getRows({ workingCsvId: first.workingCsvId, offset: 0, limit: 1 }),
    ).rejects.toThrow('Working CSV is no longer active');

    const secondRows = await service.getRows({ workingCsvId: second.workingCsvId, offset: 0, limit: 10 });
    expect(secondRows.filteredRowCount).toBe(1);
  });

  it('reopens one session without disturbing another open session', async () => {
    const firstPath = await writeFixture(
      'reopen-isolated-first.txt',
      ['name|score', 'Ada|10'].join('\n'),
    );
    const secondPath = await writeFixture(
      'reopen-isolated-second.csv',
      ['name,score', 'Grace,20'].join('\n'),
    );

    const first = await service.openOrThrow(firstPath);
    const second = await service.openOrThrow(secondPath);
    const reopenedFirst = await service.replaceOrThrow(first.workingCsvId, { delimiter: '|' });

    expect(reopenedFirst.workingCsvId).toBe(first.workingCsvId);
    expect(reopenedFirst.dataRevision).toBe(first.dataRevision + 1);
    expect(service.getState(reopenedFirst.workingCsvId)).toEqual(reopenedFirst);
    expect(service.getState(second.workingCsvId)).toEqual(second);

    const reopenedRows = await service.getRows({
      workingCsvId: reopenedFirst.workingCsvId,
      offset: 0,
      limit: 10,
    });
    const secondRows = await service.getRows({ workingCsvId: second.workingCsvId, offset: 0, limit: 10 });

    expectVisibleRows(reopenedRows.rows).toEqual([{ name: 'Ada', score: '10' }]);
    expectVisibleRows(secondRows.rows).toEqual([{ name: 'Grace', score: '20' }]);
  });

  it('returns bounded row windows without reading the full CSV', async () => {
    const filePath = await writeFixture(
      'window.csv',
      ['name,age,note', 'Ada,37,first', 'Grace,41,second', 'Linus,54,third'].join('\n'),
    );

    const session = await service.openOrThrow(filePath);
    const window = await service.getRows({ workingCsvId: session.workingCsvId, offset: 1, limit: 1 });

    expect(window).toEqual({
      workingCsvId: session.workingCsvId,
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

    const session = await service.openOrThrow(filePath);
    const window = await service.getRows({ workingCsvId: session.workingCsvId, offset: 0, limit: 2 });

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

    const session = await service.openOrThrow(filePath);
    const sorted = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 3,
      sort: [{ column: 'age', direction: 'desc' }],
    });
    const originalOrder = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 3,
    });

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

    const session = await service.openOrThrow(filePath);
    const firstPage = await service.getRows({ workingCsvId: session.workingCsvId, offset: 0, limit: 2 });
    const sorted = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 4,
      sort: [{ column: 'name', direction: 'desc' }],
    });
    const filtered = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 4,
      filters: [{ column: 'team', kind: 'text', operator: 'contains', value: 'compiler' }],
    });
    const searched = await service.getRows({
      workingCsvId: session.workingCsvId,
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

    const session = await service.openOrThrow(filePath);
    const window = await service.getRows({
      workingCsvId: session.workingCsvId,
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

    const session = await service.openOrThrow(filePath);
    const window = await service.getRows({
      workingCsvId: session.workingCsvId,
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
      [
        '"full name","select","quote""name"',
        '"Ada Lovelace","alpha","safe"',
        '"Grace Hopper","beta","unsafe"',
      ].join('\n'),
    );

    const session = await service.openOrThrow(filePath);
    const window = await service.getRows({
      workingCsvId: session.workingCsvId,
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

    const session = await service.openOrThrow(filePath);
    const window = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 10,
      search: 'comp',
    });

    expect(window.filteredRowCount).toBe(2);
    expect(window.rows.map((row) => row.name)).toEqual(['Ada', 'Margaret']);
  });

  it('returns top column value counts with percentages and deterministic ordering', async () => {
    const filePath = await writeFixture(
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

    const session = await service.openOrThrow(filePath);
    const counts = await service.getColumnValueCounts({
      workingCsvId: session.workingCsvId,
      column: 'status',
    });

    expect(counts).toEqual({
      workingCsvId: session.workingCsvId,
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
    const filePath = await writeFixture(
      'value-counts-blanks.csv',
      ['status,note', 'Open,one', ',edited empty', 'NULL,literal null', ',parsed null'].join('\n'),
    );

    const session = await service.openOrThrow(filePath);
    await service.editCell({
      workingCsvId: session.workingCsvId,
      rowId: '2',
      column: 'status',
      value: '',
    });
    const counts = await service.getColumnValueCounts({
      workingCsvId: session.workingCsvId,
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

  it('limits column value counts to the top 50 values', async () => {
    const rows = ['code'];

    for (let index = 0; index < 55; index += 1) {
      rows.push(`value-${String(index).padStart(2, '0')}`);
    }

    const filePath = await writeFixture('value-counts-top-50.csv', rows.join('\n'));
    const session = await service.openOrThrow(filePath);
    const counts = await service.getColumnValueCounts({
      workingCsvId: session.workingCsvId,
      column: 'code',
    });

    expect(counts.scopeRowCount).toBe(55);
    expect(counts.values).toHaveLength(50);
    expect(counts.values[0].value).toBe('value-00');
    expect(counts.values.at(-1)?.value).toBe('value-49');
  });

  it('applies count scope from filters and search while ignoring sort order', async () => {
    const filePath = await writeFixture(
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

    const session = await service.openOrThrow(filePath);
    const counts = await service.getColumnValueCounts({
      workingCsvId: session.workingCsvId,
      column: 'status',
      filters: [{ column: 'team', kind: 'text', operator: 'equals', value: 'compiler' }],
      search: 'a',
    });
    const sortedRows = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 10,
      sort: [{ column: 'score', direction: 'desc' }],
      filters: [{ column: 'team', kind: 'text', operator: 'equals', value: 'compiler' }],
      search: 'a',
    });

    expect(sortedRows.rows.map((row) => row.name)).toEqual(['Barbara', 'Margaret', 'Ada']);
    expect(counts.scopeRowCount).toBe(3);
    expect(counts.values).toEqual([
      { value: 'Open', count: 2, percentOfScope: expect.closeTo(66.667, 3) },
      { value: 'Closed', count: 1, percentOfScope: expect.closeTo(33.333, 3) },
    ]);
  });

  it('returns an empty count list when count scope has no rows', async () => {
    const filePath = await writeFixture(
      'value-counts-empty-scope.csv',
      ['status', 'Open'].join('\n'),
    );

    const session = await service.openOrThrow(filePath);
    const counts = await service.getColumnValueCounts({
      workingCsvId: session.workingCsvId,
      column: 'status',
      search: 'missing',
    });

    expect(counts).toEqual({
      workingCsvId: session.workingCsvId,
      column: 'status',
      scopeRowCount: 0,
      values: [],
    });
  });

  it('calculates column value counts from the working CSV after edits, inserts, deletes, undo, and redo', async () => {
    const filePath = await writeFixture(
      'value-counts-working.csv',
      ['status,team', 'Open,compiler', 'Closed,compiler', 'Open,kernel'].join('\n'),
    );

    const session = await service.openOrThrow(filePath);

    await service.editCell({
      workingCsvId: session.workingCsvId,
      rowId: '2',
      column: 'status',
      value: 'Open',
    });
    await service.insertRow({
      workingCsvId: session.workingCsvId,
      placement: 'append',
      rowIds: [],
      hasActiveQuery: false,
    });
    await service.editCell({
      workingCsvId: session.workingCsvId,
      rowId: '4',
      column: 'status',
      value: 'Pending',
    });
    await service.editCell({
      workingCsvId: session.workingCsvId,
      rowId: '4',
      column: 'team',
      value: 'compiler',
    });
    await service.deleteRows({ workingCsvId: session.workingCsvId, rowIds: ['1'] });

    const afterChanges = await service.getColumnValueCounts({
      workingCsvId: session.workingCsvId,
      column: 'status',
      filters: [{ column: 'team', kind: 'text', operator: 'equals', value: 'compiler' }],
    });

    await service.undo(session.workingCsvId);
    const afterUndo = await service.getColumnValueCounts({
      workingCsvId: session.workingCsvId,
      column: 'status',
      filters: [{ column: 'team', kind: 'text', operator: 'equals', value: 'compiler' }],
    });

    await service.redo(session.workingCsvId);
    const afterRedo = await service.getColumnValueCounts({
      workingCsvId: session.workingCsvId,
      column: 'status',
      filters: [{ column: 'team', kind: 'text', operator: 'equals', value: 'compiler' }],
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
    const filePath = await writeFixture(
      'search-clear.csv',
      ['name,team', 'Ada,compiler', 'Grace,navy'].join('\n'),
    );

    const session = await service.openOrThrow(filePath);
    const noResults = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 10,
      search: 'missing',
    });
    const cleared = await service.getRows({ workingCsvId: session.workingCsvId, offset: 0, limit: 10 });

    expect(noResults.filteredRowCount).toBe(0);
    expect(noResults.rows).toEqual([]);
    expect(cleared.filteredRowCount).toBe(2);
    expect(cleared.rows.map((row) => row.name)).toEqual(['Ada', 'Grace']);
  });

  it('composes search with active filters using parameterized search values', async () => {
    const filePath = await writeFixture(
      'search-filter.csv',
      [
        '"full name",age,team',
        '"Ada Lovelace",37,compiler',
        '"Grace Hopper",41,navy',
        '"Margaret Hamilton",87,compiler',
      ].join('\n'),
    );

    const session = await service.openOrThrow(filePath);
    const filteredSearch = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 10,
      search: 'compiler',
      filters: [{ column: 'age', kind: 'number', operator: 'greaterThan', value: 40 }],
    });
    const parameterizedSearch = await service.getRows({
      workingCsvId: session.workingCsvId,
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
    const filePath = await writeFixture(
      'edit.csv',
      ['name,code', 'Ada,001', 'Grace,002'].join('\n'),
    );

    const session = await service.openOrThrow(filePath);
    const firstWindow = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 2,
    });
    const result = await service.editCell({
      workingCsvId: session.workingCsvId,
      rowId: firstWindow.rows[1][csvInternalRowIdField],
      column: 'code',
      value: '00042',
    });
    const editedWindow = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 2,
    });

    expect(result).toEqual({
      workingCsvId: session.workingCsvId,
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
    const filePath = await writeFixture(
      'edit-sorted.csv',
      ['name,score', 'Ada,10', 'Grace,30', 'Linus,20'].join('\n'),
    );

    const session = await service.openOrThrow(filePath);
    const sorted = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 3,
      sort: [{ column: 'score', direction: 'desc' }],
    });

    await service.editCell({
      workingCsvId: session.workingCsvId,
      rowId: sorted.rows[0][csvInternalRowIdField],
      column: 'name',
      value: 'Rear Admiral Grace',
    });
    const sourceOrder = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 3,
    });

    expect(rowIds(sorted.rows)).toEqual(['2', '3', '1']);
    expect(sourceOrder.rows[1].name).toBe('Rear Admiral Grace');
    expect(sourceOrder.rows[0].name).toBe('Ada');
  });

  it('refreshes filtered and searched row windows when an edit changes query membership', async () => {
    const filePath = await writeFixture(
      'edit-query.csv',
      ['name,team', 'Ada,compiler', 'Grace,navy', 'Linus,kernel'].join('\n'),
    );

    const session = await service.openOrThrow(filePath);
    const searched = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 10,
      search: 'navy',
    });

    await service.editCell({
      workingCsvId: session.workingCsvId,
      rowId: searched.rows[0][csvInternalRowIdField],
      column: 'team',
      value: 'compiler',
    });
    const filtered = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 10,
      filters: [{ column: 'team', kind: 'text', operator: 'equals', value: 'compiler' }],
    });
    const searchedAgain = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 10,
      search: 'navy',
    });

    expect(rowIds(filtered.rows)).toEqual(['1', '2']);
    expect(searchedAgain.filteredRowCount).toBe(0);
    expect(searchedAgain.rows).toEqual([]);
  });

  it('undoes and redoes the most recent cell edit while updating Unexported Changes', async () => {
    const filePath = await writeFixture('edit-history.csv', ['name,code', 'Ada,001'].join('\n'));

    const session = await service.openOrThrow(filePath);
    const firstWindow = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 1,
    });
    const rowId = firstWindow.rows[0][csvInternalRowIdField];

    expect(service.getEditState({ workingCsvId: session.workingCsvId })).toEqual({
      workingCsvId: session.workingCsvId,
      hasUnexportedChanges: false,
      canUndo: false,
      canRedo: false,
    });

    await service.editCell({ workingCsvId: session.workingCsvId, rowId, column: 'code', value: '007' });
    expect(service.getEditState({ workingCsvId: session.workingCsvId })).toEqual({
      workingCsvId: session.workingCsvId,
      hasUnexportedChanges: true,
      canUndo: true,
      canRedo: false,
    });

    const undone = await service.undo(session.workingCsvId);
    const afterUndo = await service.getRows({ workingCsvId: session.workingCsvId, offset: 0, limit: 1 });

    expect(undone).toEqual({
      workingCsvId: session.workingCsvId,
      hasUnexportedChanges: false,
      canUndo: false,
      canRedo: true,
    });
    expect(afterUndo.rows[0].code).toBe('001');

    const redone = await service.redo(session.workingCsvId);
    const afterRedo = await service.getRows({ workingCsvId: session.workingCsvId, offset: 0, limit: 1 });

    expect(redone).toEqual({
      workingCsvId: session.workingCsvId,
      hasUnexportedChanges: true,
      canUndo: true,
      canRedo: false,
    });
    expect(afterRedo.rows[0].code).toBe('007');
  });

  it('clears redo history when a new cell edit is made after undo', async () => {
    const filePath = await writeFixture('edit-redo-clear.csv', ['name,code', 'Ada,001'].join('\n'));

    const session = await service.openOrThrow(filePath);
    const firstWindow = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 1,
    });
    const rowId = firstWindow.rows[0][csvInternalRowIdField];

    await service.editCell({ workingCsvId: session.workingCsvId, rowId, column: 'code', value: '002' });
    await service.undo(session.workingCsvId);
    await service.editCell({ workingCsvId: session.workingCsvId, rowId, column: 'code', value: '003' });

    expect(service.getEditState({ workingCsvId: session.workingCsvId })).toEqual({
      workingCsvId: session.workingCsvId,
      hasUnexportedChanges: true,
      canUndo: true,
      canRedo: false,
    });
    await expect(service.redo(session.workingCsvId)).rejects.toThrow(
      'No CSV edit is available to redo',
    );
  });

  it('deletes one selected source row and excludes it from row windows and counts', async () => {
    const filePath = await writeFixture(
      'delete-one.csv',
      ['name,team', 'Ada,compiler', 'Grace,navy', 'Linus,kernel'].join('\n'),
    );

    const session = await service.openOrThrow(filePath);
    const firstWindow = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 3,
    });
    const result = await service.deleteRows({
      workingCsvId: session.workingCsvId,
      rowIds: [firstWindow.rows[1][csvInternalRowIdField]],
    });
    const afterDelete = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 3,
    });

    expect(result).toEqual({
      workingCsvId: session.workingCsvId,
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
    const filePath = await writeFixture(
      'delete-many-sorted.csv',
      ['name,score', 'Ada,10', 'Grace,30', 'Linus,20', 'Margaret,40'].join('\n'),
    );

    const session = await service.openOrThrow(filePath);
    const sorted = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 4,
      sort: [{ column: 'score', direction: 'desc' }],
    });

    await service.deleteRows({
      workingCsvId: session.workingCsvId,
      rowIds: [sorted.rows[0][csvInternalRowIdField], sorted.rows[2][csvInternalRowIdField]],
    });
    const sourceOrder = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 4,
    });

    expect(rowIds(sorted.rows)).toEqual(['4', '2', '3', '1']);
    expect(sourceOrder.filteredRowCount).toBe(2);
    expect(rowIds(sourceOrder.rows)).toEqual(['1', '2']);
    expect(sourceOrder.rows.map((row) => row.name)).toEqual(['Ada', 'Grace']);
  });

  it('updates filtered and searched row windows after deleting selected rows', async () => {
    const filePath = await writeFixture(
      'delete-query.csv',
      ['name,team', 'Ada,compiler', 'Grace,navy', 'Linus,kernel', 'Margaret,compiler'].join('\n'),
    );

    const session = await service.openOrThrow(filePath);
    const filtered = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 10,
      filters: [{ column: 'team', kind: 'text', operator: 'equals', value: 'compiler' }],
    });

    await service.deleteRows({
      workingCsvId: session.workingCsvId,
      rowIds: [filtered.rows[0][csvInternalRowIdField]],
    });
    const filteredAgain = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 10,
      filters: [{ column: 'team', kind: 'text', operator: 'equals', value: 'compiler' }],
    });
    const searched = await service.getRows({
      workingCsvId: session.workingCsvId,
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

    const session = await service.openOrThrow(filePath);
    await service.deleteRows({ workingCsvId: session.workingCsvId, rowIds: ['1', '3'] });

    const undone = await service.undo(session.workingCsvId);
    const afterUndo = await service.getRows({ workingCsvId: session.workingCsvId, offset: 0, limit: 3 });
    const redone = await service.redo(session.workingCsvId);
    const afterRedo = await service.getRows({ workingCsvId: session.workingCsvId, offset: 0, limit: 3 });

    expect(undone).toEqual({
      workingCsvId: session.workingCsvId,
      hasUnexportedChanges: false,
      canUndo: false,
      canRedo: true,
    });
    expect(rowIds(afterUndo.rows)).toEqual(['1', '2', '3']);
    expect(redone).toEqual({
      workingCsvId: session.workingCsvId,
      hasUnexportedChanges: true,
      canUndo: true,
      canRedo: false,
    });
    expect(rowIds(afterRedo.rows)).toEqual(['2']);
  });

  it('rejects row deletion when no valid selected row identifiers are provided', async () => {
    const filePath = await writeFixture('delete-invalid.csv', ['name', 'Ada'].join('\n'));

    const session = await service.openOrThrow(filePath);

    await expect(service.deleteRows({ workingCsvId: session.workingCsvId, rowIds: [] })).rejects.toThrow(
      'At least one CSV row must be selected for deletion',
    );
    await expect(
      service.deleteRows({ workingCsvId: session.workingCsvId, rowIds: ['missing'] }),
    ).rejects.toThrow('CSV row no longer exists: missing');
  });

  it('inserts empty rows above and below one selected source row', async () => {
    const filePath = await writeFixture(
      'insert-relative.csv',
      ['name,code', 'Ada,001', 'Grace,002', 'Linus,003'].join('\n'),
    );

    const session = await service.openOrThrow(filePath);

    await service.insertRow({
      workingCsvId: session.workingCsvId,
      placement: 'above',
      rowIds: ['2'],
      hasActiveQuery: false,
    });
    await service.insertRow({
      workingCsvId: session.workingCsvId,
      placement: 'below',
      rowIds: ['2'],
      hasActiveQuery: false,
    });
    const window = await service.getRows({ workingCsvId: session.workingCsvId, offset: 0, limit: 5 });

    expect(window.filteredRowCount).toBe(5);
    expect(rowIds(window.rows)).toEqual(['1', '4', '2', '5', '3']);
    expectVisibleRows(window.rows).toEqual([
      { name: 'Ada', code: '001' },
      { name: '', code: '' },
      { name: 'Grace', code: '002' },
      { name: '', code: '' },
      { name: 'Linus', code: '003' },
    ]);
    expect(service.getEditState({ workingCsvId: session.workingCsvId })).toEqual({
      workingCsvId: session.workingCsvId,
      hasUnexportedChanges: true,
      canUndo: true,
      canRedo: false,
    });
  });

  it('appends an empty row when no row is selected', async () => {
    const filePath = await writeFixture('insert-append.csv', ['name,code', 'Ada,001'].join('\n'));

    const session = await service.openOrThrow(filePath);
    const result = await service.insertRow({
      workingCsvId: session.workingCsvId,
      placement: 'append',
      rowIds: [],
      hasActiveQuery: false,
    });
    const window = await service.getRows({ workingCsvId: session.workingCsvId, offset: 0, limit: 2 });

    expect(result).toEqual({
      workingCsvId: session.workingCsvId,
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
    const filePath = await writeFixture('insert-invalid.csv', ['name', 'Ada', 'Grace'].join('\n'));

    const session = await service.openOrThrow(filePath);

    await expect(
      service.insertRow({
        workingCsvId: session.workingCsvId,
        placement: 'above',
        rowIds: ['1'],
        hasActiveQuery: true,
      }),
    ).rejects.toThrow('cannot be inserted while sort, filter, or search is active');
    await expect(
      service.insertRow({
        workingCsvId: session.workingCsvId,
        placement: 'below',
        rowIds: ['1', '2'],
        hasActiveQuery: false,
      }),
    ).rejects.toThrow('requires exactly one selected CSV row');
    await expect(
      service.insertRow({
        workingCsvId: session.workingCsvId,
        placement: 'append',
        rowIds: ['1'],
        hasActiveQuery: false,
      }),
    ).rejects.toThrow('Append row requires no selected CSV rows');
    await expect(
      service.insertRow({
        workingCsvId: session.workingCsvId,
        placement: 'above',
        rowIds: ['missing'],
        hasActiveQuery: false,
      }),
    ).rejects.toThrow('CSV row no longer exists: missing');
  });

  it('undoes and redoes row insertion', async () => {
    const filePath = await writeFixture('insert-history.csv', ['name', 'Ada', 'Grace'].join('\n'));

    const session = await service.openOrThrow(filePath);
    await service.insertRow({
      workingCsvId: session.workingCsvId,
      placement: 'below',
      rowIds: ['1'],
      hasActiveQuery: false,
    });

    const afterInsert = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 3,
    });
    const undone = await service.undo(session.workingCsvId);
    const afterUndo = await service.getRows({ workingCsvId: session.workingCsvId, offset: 0, limit: 3 });
    const redone = await service.redo(session.workingCsvId);
    const afterRedo = await service.getRows({ workingCsvId: session.workingCsvId, offset: 0, limit: 3 });

    expect(rowIds(afterInsert.rows)).toEqual(['1', '3', '2']);
    expect(undone).toEqual({
      workingCsvId: session.workingCsvId,
      hasUnexportedChanges: false,
      canUndo: false,
      canRedo: true,
    });
    expect(rowIds(afterUndo.rows)).toEqual(['1', '2']);
    expect(redone).toEqual({
      workingCsvId: session.workingCsvId,
      hasUnexportedChanges: true,
      canUndo: true,
      canRedo: false,
    });
    expect(rowIds(afterRedo.rows)).toEqual(['1', '3', '2']);
  });

  it('exports edited, inserted, and non-deleted rows without internal row identifiers', async () => {
    const filePath = await writeFixture(
      'export-source.csv',
      ['name,code,note', 'Ada,001,first', 'Grace,002,second', 'Linus,003,third'].join('\n'),
    );
    const outputPath = path.join(tempDir, 'exported.csv');

    const session = await service.openOrThrow(filePath);
    await service.editCell({
      workingCsvId: session.workingCsvId,
      rowId: '2',
      column: 'code',
      value: '00042',
    });
    await service.insertRow({
      workingCsvId: session.workingCsvId,
      placement: 'below',
      rowIds: ['1'],
      hasActiveQuery: false,
    });
    await service.editCell({
      workingCsvId: session.workingCsvId,
      rowId: '4',
      column: 'name',
      value: 'New, Person',
    });
    await service.deleteRows({ workingCsvId: session.workingCsvId, rowIds: ['3'] });

    const state = await service.exportCsv(session.workingCsvId, outputPath);
    const exported = await readFile(outputPath, 'utf8');

    expect(exported).toBe(
      ['name,code,note', 'Ada,001,first', '"New, Person",,', 'Grace,00042,second', ''].join('\n'),
    );
    expect(exported).not.toContain(csvInternalRowIdField);
    expect(state).toEqual({
      workingCsvId: session.workingCsvId,
      hasUnexportedChanges: false,
      canUndo: true,
      canRedo: false,
    });
    expect(service.hasUnexportedChanges(session.workingCsvId)).toBe(false);
    expect(service.getState(session.workingCsvId)?.file).toEqual(session.file);
  });

  it('exports delimiter and header settings from the active dialect', async () => {
    const filePath = await writeFixture('export-no-header.txt', ['Ada|37', 'Grace|41'].join('\n'));
    const outputPath = path.join(tempDir, 'exported-no-header.txt');

    const session = await service.openOrThrow(filePath, { delimiter: '|', header: false });
    await service.editCell({
      workingCsvId: session.workingCsvId,
      rowId: '1',
      column: 'column1',
      value: '38',
    });
    await service.exportCsv(session.workingCsvId, outputPath);

    await expect(readFile(outputPath, 'utf8')).resolves.toBe(['Ada|38', 'Grace|41', ''].join('\n'));
  });

  it('rejects exporting to the CSV Source identity before writing', async () => {
    const filePath = await writeFixture('protected-source.csv', ['name', 'Ada'].join('\n'));
    const sourceAliasPath = path.join(tempDir, 'protected-source-alias.csv');
    await link(filePath, sourceAliasPath);
    const session = await service.openOrThrow(filePath);
    await service.editCell({
      workingCsvId: session.workingCsvId,
      rowId: '1',
      column: 'name',
      value: 'Grace',
    });

    await expect(service.exportCsv(session.workingCsvId, sourceAliasPath)).rejects.toThrow(
      'CSV Source',
    );
    await expect(readFile(filePath, 'utf8')).resolves.toBe(['name', 'Ada'].join('\n'));
  });

  it('retains CSV Source identity when the source is moved after opening', async () => {
    const filePath = await writeFixture('source-before-move.csv', ['name', 'Ada'].join('\n'));
    const movedSourcePath = path.join(tempDir, 'source-after-move.csv');
    const session = await service.openOrThrow(filePath);
    await rename(filePath, movedSourcePath);

    await expect(service.isSourceDestination(session.workingCsvId, movedSourcePath)).resolves.toBe(
      true,
    );
  });

  it('tracks Unexported Changes by revision identity while preserving edit history', async () => {
    const filePath = await writeFixture('export-revisions.csv', ['name,code', 'Ada,001'].join('\n'));
    const outputPath = path.join(tempDir, 'exported.csv');
    const session = await service.openOrThrow(filePath);

    await service.editCell({
      workingCsvId: session.workingCsvId,
      rowId: '1',
      column: 'code',
      value: '002',
    });
    await expect(service.exportCsv(session.workingCsvId, outputPath)).resolves.toEqual({
      workingCsvId: session.workingCsvId,
      hasUnexportedChanges: false,
      canUndo: true,
      canRedo: false,
    });
    await expect(service.undo(session.workingCsvId)).resolves.toMatchObject({
      hasUnexportedChanges: true,
      canUndo: false,
      canRedo: true,
    });
    await expect(service.redo(session.workingCsvId)).resolves.toMatchObject({
      hasUnexportedChanges: false,
      canUndo: true,
      canRedo: false,
    });

    await service.undo(session.workingCsvId);
    await expect(
      service.editCell({
        workingCsvId: session.workingCsvId,
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
    const filePath = await writeFixture('export-redo.csv', ['name,code', 'Ada,001'].join('\n'));
    const outputPath = path.join(tempDir, 'exported-undone-revision.csv');
    const session = await service.openOrThrow(filePath);
    await service.editCell({
      workingCsvId: session.workingCsvId,
      rowId: '1',
      column: 'code',
      value: '002',
    });
    await service.undo(session.workingCsvId);

    await expect(service.exportCsv(session.workingCsvId, outputPath)).resolves.toMatchObject({
      hasUnexportedChanges: false,
      canUndo: false,
      canRedo: true,
    });
    await expect(service.redo(session.workingCsvId)).resolves.toMatchObject({
      hasUnexportedChanges: true,
      canUndo: true,
      canRedo: false,
    });
  });

  it('rejects unknown sessions and oversized row windows', async () => {
    const filePath = await writeFixture('windows.csv', ['value', '1'].join('\n'));

    const session = await service.openOrThrow(filePath);

    await expect(
      service.getRows({ workingCsvId: 'unknown-session', offset: 0, limit: 1 }),
    ).rejects.toThrow('Working CSV is no longer active');
    await expect(
      service.getRows({ workingCsvId: session.workingCsvId, offset: 0, limit: 1001 }),
    ).rejects.toThrow('1000 or less');
  });

  it('returns a clear error for missing files without keeping a session', async () => {
    const missingPath = path.join(tempDir, 'missing.csv');

    await expect(service.openOrThrow(missingPath)).rejects.toThrow('Unable to open CSV');
    expect(service.findByPath(missingPath)).toBeNull();
  });

  it('validates large-file access through bounded row windows', async () => {
    const rows = ['id,name,score'];

    for (let index = 0; index < 5000; index += 1) {
      rows.push(`${index},Person ${index},${index % 100}`);
    }

    const filePath = await writeFixture('large.csv', rows.join('\n'));
    const session = await service.openOrThrow(filePath);
    const firstWindow = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 0,
      limit: 100,
    });
    const laterWindow = await service.getRows({
      workingCsvId: session.workingCsvId,
      offset: 4500,
      limit: 75,
    });

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
    const session = await service.openOrThrow(filePath);

    await service.editCell({
      workingCsvId: session.workingCsvId,
      rowId: '4901',
      column: 'name',
      value: 'Edited Person',
    });
    await service.insertRow({
      workingCsvId: session.workingCsvId,
      placement: 'below',
      rowIds: ['4901'],
      hasActiveQuery: false,
    });
    await service.deleteRows({ workingCsvId: session.workingCsvId, rowIds: ['4902', '4903'] });

    const window = await service.getRows({ workingCsvId: session.workingCsvId, offset: 4899, limit: 5 });

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

    const session = await service.openOrThrow(filePath);
    const window = await service.getRows({ workingCsvId: session.workingCsvId, offset: 0, limit: 1 });

    expect(session.columns).toHaveLength(120);
    expect(window.rows).toHaveLength(1);
    expect(window.rows[0].metric_0).toBe('0');
    expect(window.rows[0].metric_119).toBe('119');
  });

  it('returns a distinct error for unsupported files', async () => {
    const filePath = await writeFixture('people.json', '{"name":"Ada"}');

    await expect(service.openOrThrow(filePath)).rejects.toThrow('Unsupported file type');
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
