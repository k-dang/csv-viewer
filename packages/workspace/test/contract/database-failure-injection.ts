import { Effect } from 'effect';
import { DataEngineError, type OwnedWorkspaceDatabase, type WorkspaceDatabase } from '../../src/database';

export function failNextExportPreparation(database: WorkspaceDatabase, failure: 'read' | 'serialization'): () => boolean {
  let released = false;
  const connect = database.connectWorkerEffect.bind(database);
  database.connectWorkerEffect = () => {
    database.connectWorkerEffect = connect;
    return connect().pipe(Effect.map((connection) => {
      const read = connection.readObjectsCancellableEffect.bind(connection);
      connection.readObjectsCancellableEffect = (sql, values) => failure === 'read'
        ? Effect.fail(new DataEngineError(new Error('PRIVATE export read failure')))
        : read(sql, values).pipe(Effect.map((rows) => {
          rows[0][Object.keys(rows[0])[0]] = new Date(NaN);
          return rows;
        }));
      const close = connection.closeEffect.bind(connection);
      connection.closeEffect = () => close().pipe(Effect.tap(() => Effect.sync(() => { released = true; })));
      return connection;
    }));
  };
  return () => released;
}

export function failNextExportWorkerRelease(database: WorkspaceDatabase): void {
  const connect = database.connectWorkerEffect.bind(database);
  database.connectWorkerEffect = () => {
    database.connectWorkerEffect = connect;
    return connect().pipe(Effect.map((connection) => {
      const close = connection.closeEffect.bind(connection);
      connection.closeEffect = () => close().pipe(Effect.andThen(Effect.fail(new DataEngineError(new Error('PRIVATE export release failure')))));
      return connection;
    }));
  };
}

export function failNextMetadataRead(database: WorkspaceDatabase): void {
  const read = database.readObjectsEffect.bind(database);
  database.readObjectsEffect = (sql, values) => {
    if (!sql.startsWith('DESCRIBE SELECT * FROM "csv_working_')) return read(sql, values);
    database.readObjectsEffect = read;
    return Effect.fail(new DataEngineError(new Error('PRIVATE metadata failure')));
  };
}

export function failNextCsvLoad(database: WorkspaceDatabase): void {
  const run = database.runEffect.bind(database);
  database.runEffect = (sql, values) => {
    if (!sql.startsWith('CREATE TABLE "csv_working_')) return run(sql, values);
    database.runEffect = run;
    return Effect.fail(new DataEngineError(new Error('PRIVATE CSV load failure')));
  };
}

export function failNextTableDrop(database: WorkspaceDatabase): void {
  const run = database.runEffect.bind(database);
  database.runEffect = (sql, values) => {
    if (!sql.startsWith('DROP TABLE IF EXISTS "csv_working_')) return run(sql, values);
    database.runEffect = run;
    return Effect.die(new Error('PRIVATE table cleanup failure'));
  };
}

export function failNextDatabaseRelease(database: OwnedWorkspaceDatabase): void {
  const close = database.closeOwnerConnection.bind(database);
  database.closeOwnerConnection = () => {
    database.closeOwnerConnection = close;
    return close().pipe(Effect.andThen(Effect.fail(new DataEngineError(new Error('PRIVATE database release failure')))));
  };
}

export function holdNextRowRead(database: WorkspaceDatabase) {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const read = database.readObjectsEffect.bind(database);
  database.readObjectsEffect = (sql, values) => Effect.gen(function* () {
    if (!sql.includes('AS filtered_row_count')) return yield* read(sql, values);
    database.readObjectsEffect = read;
    entered.resolve();
    yield* Effect.promise(() => resume.promise);
    return yield* read(sql, values);
  });
  return { entered: entered.promise, release: () => resume.resolve() };
}

export async function failNextSnapshotDrop(database: WorkspaceDatabase): Promise<void> {
  const connection = await Effect.runPromise(database.ownerConnectionEffect());
  const run = connection.runEffect.bind(connection);
  connection.runEffect = (sql, values) => {
    if (!sql.startsWith('DROP TABLE IF EXISTS "csv_comparison_')) return run(sql, values);
    connection.runEffect = run;
    return Effect.fail(new DataEngineError(new Error('PRIVATE snapshot cleanup failure')));
  };
}
