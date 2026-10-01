import { Effect } from 'effect';
import { DataEngineError, type OwnedWorkspaceDatabase, type WorkspaceDatabase } from '../../src/database';

export function failNextMetadataRead(database: WorkspaceDatabase): void {
  const read = database.readObjects.bind(database);
  database.readObjects = (sql, values) => {
    if (!sql.startsWith('DESCRIBE SELECT * FROM "csv_working_')) return read(sql, values);
    database.readObjects = read;
    return Promise.reject(new DataEngineError(new Error('PRIVATE metadata failure')));
  };
}

export function failNextCsvLoad(database: WorkspaceDatabase): void {
  const run = database.run.bind(database);
  database.run = (sql, values) => {
    if (!sql.startsWith('CREATE TABLE "csv_working_')) return run(sql, values);
    database.run = run;
    return Promise.reject(new DataEngineError(new Error('PRIVATE CSV load failure')));
  };
}

export function failNextTableDrop(database: WorkspaceDatabase): void {
  const run = database.run.bind(database);
  database.run = (sql, values) => {
    if (!sql.startsWith('DROP TABLE IF EXISTS "csv_working_')) return run(sql, values);
    database.run = run;
    return Promise.reject(new Error('PRIVATE table cleanup failure'));
  };
}

export function failNextDatabaseRelease(database: OwnedWorkspaceDatabase): void {
  const close = database.closeOwnerConnection.bind(database);
  database.closeOwnerConnection = () => {
    database.closeOwnerConnection = close;
    return close().pipe(Effect.andThen(Effect.fail(new DataEngineError(new Error('PRIVATE database release failure')))));
  };
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

export function holdNextRowRead(database: WorkspaceDatabase) {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const read = database.readObjects.bind(database);
  database.readObjects = async (sql, values) => {
    if (!sql.includes('AS filtered_row_count')) return read(sql, values);
    database.readObjects = read;
    entered.resolve();
    await resume.promise;
    return read(sql, values);
  };
  return { entered: entered.promise, release: () => resume.resolve() };
}
