import { afterEach, describe, expect, it } from 'vitest';
import { DuckDbWorkspaceDatabase } from './duckdb-database';

let database: DuckDbWorkspaceDatabase;

afterEach(() => {
  database.close();
});

describe('DuckDbWorkspaceDatabase', () => {
  it('opens one instance no matter how many callers ask at once', async () => {
    database = new DuckDbWorkspaceDatabase();

    const connections = await Promise.all([
      database.ownerConnection(),
      database.ownerConnection(),
      database.ownerConnection(),
    ]);

    expect(new Set(connections).size).toBe(1);
    expect(await database.ownerConnection()).toBe(connections[0]);
    expect(database.close()).toEqual([]);
    expect(database.isOpen()).toBe(false);
  });
});
