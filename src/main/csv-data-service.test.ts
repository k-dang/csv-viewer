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
