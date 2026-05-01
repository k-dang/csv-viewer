import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    expect(session.columns.map((column) => column.type)).toEqual(['VARCHAR', 'BIGINT', 'DATE']);
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
      rows: [{ name: 'Grace', age: 41, note: 'second' }],
    });
  });

  it('preserves empty strings and null values distinctly in row windows', async () => {
    const filePath = await writeFixture(
      'missing.csv',
      ['name,note,score', 'Ada,,10', 'Grace,NULL,'].join('\n'),
    );

    const session = await service.openCsv(filePath);
    const window = await service.getRows({ sessionId: session.sessionId, offset: 0, limit: 2 });

    expect(window.rows).toEqual([
      { name: 'Ada', note: null, score: 10 },
      { name: 'Grace', note: 'NULL', score: null },
    ]);
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
    expect(window.rows).toEqual([{ name: 'Margaret', age: 87, team: 'compiler' }]);
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
});

async function writeFixture(fileName: string, content: string): Promise<string> {
  const filePath = path.join(tempDir, fileName);
  await writeFile(filePath, content);
  return filePath;
}
