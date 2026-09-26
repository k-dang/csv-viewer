import { rm } from 'node:fs/promises';
import { Effect, Logger } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsvWorkspaceFixture } from './fixtures/desktop-workspace';
import { DuckDbWorkspaceDatabase } from '../src/main/duckdb-database';
import { WorkingCsvStore } from '../../../packages/workspace/src/working-csv/working-csv-store';
import type { WorkspaceArtifactRegistry } from '../../../packages/workspace/src/workspace-artifact-registry';

/**
 * Store invariants that the CsvWorkspace surface cannot observe: disposal ordering when its own
 * validation fails, and isolation between the data-change listeners the Comparison area relies on.
 * These drive a bare WorkingCsvStore, so they borrow only the fixture's host and temp directory.
 */
let fixture: CsvWorkspaceFixture;
let store: WorkingCsvStore;

beforeEach(async () => {
  fixture = await CsvWorkspaceFixture.create();
  store = new WorkingCsvStore(fixture.host, new DuckDbWorkspaceDatabase());
});

afterEach(async () => {
  await rm(fixture.directory, { recursive: true, force: true });
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

describe('WorkingCsvStore invariants', () => {
  it('closes database handles when disposal validation fails', async () => {
    await openWorkingCsv('dispose-failure.csv', ['id', '1'].join('\n'));

    const descriptors = Object.getOwnPropertyDescriptors(store);
    const database: DuckDbWorkspaceDatabase = descriptors.database.value;
    const artifactRegistry: WorkspaceArtifactRegistry =
      descriptors.artifactRegistry.value;
    const databaseClose = vi.spyOn(database, 'close');
    artifactRegistry.register({
      tableName: 'unexpected_artifact',
      owner: { kind: 'working-csv', workingCsvId: 'missing' },
      role: 'current',
    });

    await expect(Effect.runPromise(store.disposeStore())).rejects.toThrow('Workspace artifact invariant violated');
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(database.isOpen()).toBe(false);
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
    expect(failures).toEqual(['recoverable-failure']);
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
