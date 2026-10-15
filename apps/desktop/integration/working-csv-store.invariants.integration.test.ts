import { readFile } from 'node:fs/promises';
import { Cause, Effect, Exit, Fiber, Layer, Logger } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { CsvWorkspaceFixture } from './fixtures/desktop-workspace';
import { DataEngineError, WorkspaceDatabase } from '../../../packages/workspace/src/database';
import { DuckDbWorkspaceDatabase } from '../src/main/duckdb-database';
import { openInScope } from '../../../packages/workspace/test/scoped-database';
import { WorkingCsvs, workingCsvsLayer } from '../../../packages/workspace/src/working-csv/working-csv-store';
import { CsvWorkspaceHost } from '../../../packages/workspace/src/workspace-host';
import type { WorkspaceArtifactRegistry } from '../../../packages/workspace/src/workspace-artifact-registry';
import { failNextExportPreparation, failNextExportWorkerRelease } from '../../../packages/workspace/test/contract/database-failure-injection';

/**
 * Store invariants that the CsvWorkspace surface cannot observe: refusing work after its own
 * disposal validation fails, and isolation between the data-change listeners the Comparison area relies on.
 * These build the Working CSV Layer alone, so they borrow only the fixture's host and temp directory.
 */
let fixture: CsvWorkspaceFixture;
let database: DuckDbWorkspaceDatabase;
let closeDatabase: () => Promise<void>;
let store: WorkingCsvs;

beforeEach(async () => {
  fixture = await CsvWorkspaceFixture.create();
  ({ database, close: closeDatabase } = await openInScope(DuckDbWorkspaceDatabase.open()));
  const resources = Layer.mergeAll(Layer.succeed(CsvWorkspaceHost, fixture.host), Layer.succeed(WorkspaceDatabase, database));
  store = Effect.runSync(Effect.service(WorkingCsvs).pipe(Effect.provide(workingCsvsLayer.pipe(Layer.provide(resources)))));
});

afterEach(async () => {
  await closeDatabase();
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
  it.effect.each(['read', 'defect'] as const)('retains a %s failure alongside worker cleanup failure and retries cleanup', (failure) => Effect.gen(function* () {
    const { workingCsvId } = yield* Effect.promise(() => openWorkingCsv('export-failures.csv', 'name\nAda\n'));
    yield* Effect.addFinalizer(() => store.disposeStore().pipe(Effect.orDie));
    yield* store.editCell({ workingCsvId, rowId: '1', column: 'name', value: 'Grace' });
    failNextExportPreparation(database, failure);
    const closed = failNextExportWorkerRelease(database, 1);

    const exit = yield* Effect.exit(store.exportCsv(workingCsvId));
    if (Exit.isSuccess(exit)) throw new Error('Expected export preparation to fail.');
    expect(exit.cause.reasons).toHaveLength(2);
    const failures = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
    expect(failures).toMatchObject(failure === 'read'
      ? [{ cause: { message: 'PRIVATE export read failure' } }, { cause: { message: 'PRIVATE export release failure' } }]
      : [{ cause: { message: 'PRIVATE export release failure' } }]);
    expect(Cause.hasDies(exit.cause)).toBe(failure === 'defect');
    expect((yield* store.getEditState({ workingCsvId })).hasUnexportedChanges).toBe(true);
    expect(fixture.prompts.defaultExportPaths).toEqual([]);
    expect(closed()).toBe(false);
    yield* store.disposeStore();
    expect(closed()).toBe(true);
  }));

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

  it('marks the delivered revision when an undo commits during delivery', async () => {
    const workingCsv = await openWorkingCsv('export-undo-during-delivery.csv', 'name\nAda\n');
    const { workingCsvId } = workingCsv;
    await Effect.runPromise(store.editCell({ workingCsvId, rowId: '1', column: 'name', value: 'Grace' }));

    const releasePrompt = Promise.withResolvers<void>();
    const promptHeld = Promise.withResolvers<void>();
    fixture.prompts.holdExportPrompt = () => {
      promptHeld.resolve();
      return releasePrompt.promise;
    };
    const destination = fixture.file('delivered.csv');
    fixture.prompts.exportChoices.push(destination);

    const exported = Effect.runPromise(store.exportCsv(workingCsvId));
    try {
      await promptHeld.promise;
      await Effect.runPromise(store.undo(workingCsvId));
    } finally {
      releasePrompt.resolve();
    }

    await expect(exported).resolves.toMatchObject({
      status: 'exported',
      editState: { hasUnexportedChanges: true, canUndo: false, canRedo: true },
    });
    expect(store.hasUnexportedChanges(workingCsvId)).toBe(true);
    await expect(readFile(destination, 'utf8')).resolves.toBe('name\nGrace\n');
    const rows = await Effect.runPromise(store.getRows({ workingCsvId, offset: 0, limit: 1 }));
    expect(rows.rows[0]?.name).toBe('Ada');

    await expect(Effect.runPromise(store.redo(workingCsvId))).resolves.toMatchObject({
      hasUnexportedChanges: false,
      canUndo: true,
      canRedo: false,
    });
    await Effect.runPromise(store.disposeStore());
  });

  it('stops view-export preparation when its parent is interrupted without blocking the next edit', async () => {
    const { workingCsvId } = await openWorkingCsv('view-export-interrupt.csv', 'name\nAda\n');
    const entered = Promise.withResolvers<void>();
    const connect = database.connectWorker.bind(database);
    database.connectWorker = () => {
      database.connectWorker = connect;
      return connect().pipe(Effect.map((connection) => {
        connection.readObjectsCancellable = () => Effect.gen(function* () {
          entered.resolve();
          return yield* Effect.never;
        });
        return connection;
      }));
    };

    const fiber = Effect.runFork(store.exportView({ workingCsvId }));
    try {
      await entered.promise;
      await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.timeout('2 seconds')));
      await expect(Effect.runPromise(
        store.editCell({ workingCsvId, rowId: '1', column: 'name', value: 'Grace' }).pipe(Effect.timeout('2 seconds')),
      )).resolves.toMatchObject({ hasUnexportedChanges: true, canUndo: true });
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
    }
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
