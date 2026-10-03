import { Effect, Layer, Logger } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CsvWorkspaceFixture } from './fixtures/desktop-workspace';
import { DataEngineError, WorkspaceDatabase } from '../../../packages/workspace/src/database';
import { DuckDbWorkspaceDatabase } from '../src/main/duckdb-database';
import { WorkingCsvs, workingCsvsLayer } from '../../../packages/workspace/src/working-csv/working-csv-store';
import { CsvWorkspaceHost } from '../../../packages/workspace/src/workspace-host';
import type { WorkspaceArtifactRegistry } from '../../../packages/workspace/src/workspace-artifact-registry';

/**
 * Store invariants that the CsvWorkspace surface cannot observe: refusing work after its own
 * disposal validation fails, and isolation between the data-change listeners the Comparison area relies on.
 * These build the Working CSV Layer alone, so they borrow only the fixture's host and temp directory.
 */
let fixture: CsvWorkspaceFixture;
let database: DuckDbWorkspaceDatabase;
let store: WorkingCsvs;

beforeEach(async () => {
  fixture = await CsvWorkspaceFixture.create();
  database = await Effect.runPromise(DuckDbWorkspaceDatabase.open());
  const resources = Layer.mergeAll(Layer.succeed(CsvWorkspaceHost, fixture.host), Layer.succeed(WorkspaceDatabase, database));
  store = Effect.runSync(Effect.service(WorkingCsvs).pipe(Effect.provide(workingCsvsLayer.pipe(Layer.provide(resources)))));
});

afterEach(async () => {
  await Effect.runPromise(database.closeOwnerConnection());
  await Effect.runPromise(database.closeEngine());
  await fixture.dispose();
});

async function openWorkingCsv(fileName: string, contents: string) {
  const filePath = await fixture.writeSource(fileName, contents);
  const sourceId = await fixture.sourceId(filePath);
  const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    if (!(yield* store.admit())) throw new Error('Working CSV open was not admitted.');
    return yield* store.open(sourceId);
  })));
  if (outcome.status !== 'opened') throw new Error(`Working CSV was ${outcome.status}.`);
  return outcome.workingCsv;
}

describe('Working CSV store invariants', () => {
  it('rejects a store open once disposal begins', async () => {
    const workingCsv = await openWorkingCsv('open-before-disposal.csv', 'name\nAda\n');
    const lateSourceId = await fixture.registerSource('late-open.csv', 'name\nGrace\n');
    store.beginDisposal();

    for (const sourceId of [workingCsv.source.sourceId, lateSourceId]) {
      await expect(Effect.runPromise(store.open(sourceId))).resolves.toMatchObject({
        status: 'failed',
        failure: { message: 'The CSV workspace is closing.' },
      });
    }
    await Effect.runPromise(store.disposeStore());
  });

  it('rejects later work when disposal validation fails', async () => {
    await openWorkingCsv('dispose-failure.csv', ['id', '1'].join('\n'));

    const descriptors = Object.getOwnPropertyDescriptors(store);
    const artifactRegistry: WorkspaceArtifactRegistry =
      descriptors.artifactRegistry.value;
    artifactRegistry.register({
      tableName: 'unexpected_artifact',
      owner: { kind: 'working-csv', workingCsvId: 'missing' },
      role: 'current',
    });

    await expect(Effect.runPromise(store.disposeStore())).rejects.toThrow('Workspace artifact invariant violated');
    await expect(
      Effect.runPromise(store.getRows({ workingCsvId: 'missing', offset: 0, limit: 1 })),
    ).rejects.toThrow('CSV workspace is disposing.');
  });

  it('isolates data-change listeners so one failure cannot suppress later listeners', async () => {
    const workingCsv = await openWorkingCsv('listeners.csv', ['name', 'Ada'].join('\n'));
    const failures: unknown[] = [];
    const capture = Logger.make((options) => {
      const record = Logger.formatStructured.log(options);
      if (record.message === 'csv.notify-data-change' && record.annotations.outcome !== 'started') failures.push(record.annotations.outcome);
    });
    const notified: string[] = [];
    store.subscribeToDataChanges(() => {
      throw new Error('listener failure');
    });
    store.subscribeToDataChanges((workingCsvId) => notified.push(workingCsvId));

    await Effect.runPromise(store.editCell({
      workingCsvId: workingCsv.workingCsvId,
      rowId: '1',
      column: 'name',
      value: 'Grace',
    }).pipe(Effect.provide(Logger.layer([capture]))));

    expect(notified).toEqual([workingCsv.workingCsvId]);
    expect(store.getState(workingCsv.workingCsvId)?.dataRevision).toBe(1);
    expect(failures).toEqual(['defect']);
    await Effect.runPromise(store.disposeStore());
  });

  it('leaves history, columns, and revision unchanged when an undo replay fails', async () => {
    const workingCsv = await openWorkingCsv('undo-replay-failure.csv', ['name', 'Ada'].join('\n'));
    const { workingCsvId } = workingCsv;
    await Effect.runPromise(store.renameColumn({ workingCsvId, column: 'name', name: 'title' }));
    const revision = store.getState(workingCsvId)?.dataRevision;

    const run = database.run.bind(database);
    database.run = (sql, values) => {
      if (!sql.startsWith('ALTER TABLE')) return run(sql, values);
      database.run = run;
      return Effect.fail(new DataEngineError({ cause: new Error('PRIVATE replay failure') }));
    };
    await expect(Effect.runPromise(store.undo(workingCsvId))).rejects.toThrow();

    expect(store.getState(workingCsvId)).toMatchObject({
      dataRevision: revision,
      columns: [{ name: 'title' }],
    });
    await expect(Effect.runPromise(store.getEditState({ workingCsvId }))).resolves.toMatchObject({
      canUndo: true,
      canRedo: false,
    });

    await expect(Effect.runPromise(store.undo(workingCsvId))).resolves.toMatchObject({
      canUndo: false,
      canRedo: true,
      columns: [{ name: 'name' }],
    });
    await Effect.runPromise(store.disposeStore());
  });

  it('stops notifying a data-change listener once it unsubscribes', async () => {
    const workingCsv = await openWorkingCsv('unsubscribe.csv', ['name', 'Ada'].join('\n'));
    const notified: string[] = [];
    const unsubscribe = store.subscribeToDataChanges((workingCsvId) =>
      notified.push(workingCsvId),
    );

    const request = {
      workingCsvId: workingCsv.workingCsvId,
      rowId: '1',
      column: 'name',
    };
    await Effect.runPromise(store.editCell({ ...request, value: 'Grace' }));
    unsubscribe();
    await Effect.runPromise(store.editCell({ ...request, value: 'Linus' }));

    expect(notified).toEqual([workingCsv.workingCsvId]);
    await Effect.runPromise(store.disposeStore());
  });
});
