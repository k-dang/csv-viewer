import type { WorkspaceDatabase } from '../../src/database';

export function failNextMetadataRead(database: WorkspaceDatabase): void {
  const read = database.readObjects.bind(database);
  database.readObjects = (sql, values) => {
    if (!sql.startsWith('DESCRIBE SELECT * FROM "csv_working_')) return read(sql, values);
    database.readObjects = read;
    return Promise.reject(new Error('PRIVATE metadata failure'));
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
