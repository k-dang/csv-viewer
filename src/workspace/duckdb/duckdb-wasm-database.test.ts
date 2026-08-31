import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import WebWorker from 'web-worker';
import { afterEach, describe, expect, it } from 'vitest';
import { DuckDbWasmWorkspaceDatabase } from './duckdb-wasm-database';

const require = createRequire(`${process.cwd()}/package.json`);

let database: DuckDbWasmWorkspaceDatabase | undefined;

afterEach(async () => {
  await database?.close();
  database = undefined;
});

describe('DuckDbWasmWorkspaceDatabase', () => {
  it('runs parameterized queries on the pinned in-memory DuckDB core', async () => {
    database = createDatabase();

    const rows = await database.readObjects(
      'SELECT version() AS version, ?::VARCHAR AS text, ?::BOOLEAN AS enabled, ?::INTEGER AS count',
      ['local', true, 3],
    );

    expect(rows).toEqual([
      {
        version: 'v1.5.5',
        text: 'local',
        enabled: true,
        count: 3,
      },
    ]);
  });

  it('reads registered memory files while rejecting remote sources and extension fetching', async () => {
    database = createDatabase();
    const reference = await database.registerFileBuffer(
      'people.csv',
      new TextEncoder().encode('name,age\nAda,37\n'),
    );

    const rows = await database.readObjects(
      `SELECT * FROM read_csv_auto('${reference}', all_varchar = true)`,
    );

    expect(rows).toEqual([{ name: 'Ada', age: '37' }]);
    await expect(
      database.readObjects(
        "SELECT current_setting('enable_external_access') AS external_access, current_setting('autoinstall_known_extensions') AS autoinstall, current_setting('autoload_known_extensions') AS autoload",
      ),
    ).resolves.toEqual([{ external_access: false, autoinstall: false, autoload: false }]);
  });

  it('rejects runtime CDN module URLs', () => {
    expect(
      () =>
        new DuckDbWasmWorkspaceDatabase({
          mainModule: 'https://cdn.example.com/duckdb.wasm',
          mainWorker: 'duckdb.worker.js',
          createWorker: () => Promise.reject(new Error('not used')),
        }),
    ).toThrow('self-hosted');

    expect(
      () =>
        new DuckDbWasmWorkspaceDatabase({
          mainModule: 'duckdb.wasm',
          mainWorker: 'https://cdn.example.com/duckdb.worker.js',
          createWorker: () => Promise.reject(new Error('not used')),
        }),
    ).toThrow('self-hosted');
  });

  it('cancels pending work without publishing its table and keeps the connection usable', async () => {
    database = createDatabase();
    const worker = await database.connectWorker();
    const work = worker.runCancellable(
      'CREATE TABLE cancelled_wasm_work AS SELECT sum(a.range * b.range) FROM range(1000000) a, range(1000000) b',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    await worker.cancelRunning();

    await expect(work).rejects.toMatchObject({
      name: 'DataEngineError',
      message: 'The data engine could not complete the operation.',
    });
    await expect(
      database.readObjects(
        "SELECT count(*)::BIGINT AS count FROM information_schema.tables WHERE table_name = 'cancelled_wasm_work'",
      ),
    ).resolves.toEqual([{ count: 0n }]);
    await expect(worker.readObjects('SELECT 42 AS answer')).resolves.toEqual([{ answer: 42 }]);
    await worker.close();
  }, 15_000);
});

function createDatabase(): DuckDbWasmWorkspaceDatabase {
  const mainModule = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm');
  const mainWorker = pathToFileURL(
    require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-mvp.worker.cjs'),
  ).toString();
  return new DuckDbWasmWorkspaceDatabase({
    mainModule,
    mainWorker,
    createWorker: (reference) => Promise.resolve(new WebWorker(new URL(reference))),
  });
}
