import { Effect } from 'effect';
import { csvInternalRowIdField } from '../../src/csv-viewer';
import { DataEngineError, type WorkspaceDatabase } from '../../src/database';
import { quoteIdentifier } from '../../src/query/csv-query';

export type ExportPreparationFailure = 'read' | 'malformed' | 'defect';

/** `malformed` returns an invalid Date cell; `defect` returns a cell that throws when it is read. */
export function failNextExportPreparation(database: WorkspaceDatabase, failure: ExportPreparationFailure): () => boolean {
  let released = false;
  const connect = database.connectWorker.bind(database);
  database.connectWorker = () => {
    database.connectWorker = connect;
    return connect().pipe(Effect.map((connection) => {
      const read = connection.readObjectsCancellable.bind(connection);
      connection.readObjectsCancellable = (sql, values) => failure === 'read'
        ? Effect.fail(new DataEngineError({ cause: new Error('PRIVATE export read failure') }))
        : read(sql, values).pipe(Effect.map(([first, ...rest]) => {
          const column = Object.keys(first)[0];
          const corrupted = failure === 'malformed'
            ? { ...first, [column]: new Date(NaN) }
            : Object.defineProperty({ ...first }, column, { enumerable: true, get: () => { throw new Error('PRIVATE export cell defect'); } });
          return [corrupted, ...rest];
        }));
      const close = connection.close.bind(connection);
      connection.close = () => close().pipe(Effect.tap(() => Effect.sync(() => { released = true; })));
      return connection;
    }));
  };
  return () => released;
}

export function failNextExportWorkerRelease(database: WorkspaceDatabase, failures: number): () => boolean {
  let remaining = failures;
  let closed = false;
  const connect = database.connectWorker.bind(database);
  database.connectWorker = () => {
    database.connectWorker = connect;
    return connect().pipe(Effect.map((connection) => {
      const close = connection.close.bind(connection);
      connection.close = () => Effect.suspend(() => {
        if (remaining === 0) return close().pipe(Effect.tap(() => Effect.sync(() => { closed = true; })));
        remaining -= 1;
        return Effect.fail(new DataEngineError({ cause: new Error('PRIVATE export release failure') }));
      });
      return connection;
    }));
  };
  return () => closed;
}

export function failNextMetadataRead(database: WorkspaceDatabase): void {
  const read = database.readObjects.bind(database);
  database.readObjects = (sql, values) => {
    if (!sql.startsWith('DESCRIBE SELECT * FROM "csv_working_')) return read(sql, values);
    database.readObjects = read;
    return Effect.fail(new DataEngineError({ cause: new Error('PRIVATE metadata failure') }));
  };
}

export function failNextCsvLoad(database: WorkspaceDatabase): void {
  const run = database.run.bind(database);
  database.run = (sql, values) => {
    if (!sql.startsWith('CREATE TABLE "csv_working_')) return run(sql, values);
    database.run = run;
    return Effect.fail(new DataEngineError({ cause: new Error('PRIVATE CSV load failure') }));
  };
}

export function failNextTableDrop(database: WorkspaceDatabase): void {
  const run = database.run.bind(database);
  database.run = (sql, values) => {
    if (!sql.startsWith('DROP TABLE IF EXISTS "csv_working_')) return run(sql, values);
    database.run = run;
    return Effect.die(new Error('PRIVATE table cleanup failure'));
  };
}

/** The next row window comes back from the real engine without its internal row identifiers. */
export function corruptNextRowWindow(database: WorkspaceDatabase): void {
  const read = database.readObjects.bind(database);
  database.readObjects = (sql, values) => {
    if (!sql.startsWith(`SELECT ${quoteIdentifier(csvInternalRowIdField)}, `)) return read(sql, values);
    database.readObjects = read;
    return read(sql, values).pipe(Effect.map((rows) => rows.map(({ [csvInternalRowIdField]: _rowId, ...row }) => row)));
  };
}

export function holdNextRowRead(database: WorkspaceDatabase) {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const read = database.readObjects.bind(database);
  database.readObjects = (sql, values) => Effect.gen(function* () {
    if (!sql.includes('AS filtered_row_count')) return yield* read(sql, values);
    database.readObjects = read;
    entered.resolve();
    yield* Effect.promise(() => resume.promise);
    return yield* read(sql, values);
  });
  return { entered: entered.promise, release: () => resume.resolve() };
}

export function holdNextExportRead(database: WorkspaceDatabase) {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const connect = database.connectWorker.bind(database);
  database.connectWorker = () => {
    database.connectWorker = connect;
    return connect().pipe(Effect.map((connection) => {
      const read = connection.readObjectsCancellable.bind(connection);
      connection.readObjectsCancellable = (sql, values) => Effect.gen(function* () {
        entered.resolve();
        yield* Effect.promise(() => resume.promise);
        return yield* read(sql, values);
      });
      return connection;
    }));
  };
  return { entered: entered.promise, release: () => resume.resolve() };
}

export async function failNextSnapshotDrop(database: WorkspaceDatabase, mode: 'failure' | 'defect' = 'failure'): Promise<void> {
  const connection = await Effect.runPromise(database.ownerConnection());
  const run = connection.run.bind(connection);
  connection.run = (sql, values) => {
    if (!sql.startsWith('DROP TABLE IF EXISTS "csv_comparison_')) return run(sql, values);
    connection.run = run;
    const cause = new Error('PRIVATE snapshot cleanup failure');
    return mode === 'defect' ? Effect.die(cause) : Effect.fail(new DataEngineError({ cause }));
  };
}
