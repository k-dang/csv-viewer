import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsvWorkspaceFixture } from './fixtures/desktop-workspace';
import { DuckDbWorkspaceDatabase } from '../src/main/duckdb-database';
import { WorkingCsvStore } from '../../../packages/workspace/src/working-csv-store';
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
  const outcome = await store.open(await fixture.sourceId(filePath));
  if (outcome.status !== 'opened')
    throw new Error(`Working CSV was ${outcome.status}.`);
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

    await expect(store.disposeStore()).rejects.toThrow(
      'Workspace artifact invariant violated',
    );
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(database.isOpen()).toBe(false);
    await expect(
      store.getRows({ workingCsvId: 'missing', offset: 0, limit: 1 }),
    ).rejects.toThrow('CSV workspace is disposing.');
  });

  it('isolates data-change listeners so one failure cannot suppress later listeners', async () => {
    const workingCsv = await openWorkingCsv(
      'listeners.csv',
      ['name', 'Ada'].join('\n'),
    );
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const notified: string[] = [];
    store.subscribeToDataChanges(() => {
      throw new Error('listener failure');
    });
    store.subscribeToDataChanges((workingCsvId) => notified.push(workingCsvId));

    await store.editCell({
      workingCsvId: workingCsv.workingCsvId,
      rowId: '1',
      column: 'name',
      value: 'Grace',
    });

    expect(notified).toEqual([workingCsv.workingCsvId]);
    expect(store.getState(workingCsv.workingCsvId)?.dataRevision).toBe(1);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
    await store.disposeStore();
  });

  it('stops notifying a data-change listener once it unsubscribes', async () => {
    const workingCsv = await openWorkingCsv(
      'unsubscribe.csv',
      ['name', 'Ada'].join('\n'),
    );
    const notified: string[] = [];
    const unsubscribe = store.subscribeToDataChanges((workingCsvId) =>
      notified.push(workingCsvId),
    );

    const request = {
      workingCsvId: workingCsv.workingCsvId,
      rowId: '1',
      column: 'name',
    };
    await store.editCell({ ...request, value: 'Grace' });
    unsubscribe();
    await store.editCell({ ...request, value: 'Linus' });

    expect(notified).toEqual([workingCsv.workingCsvId]);
    await store.disposeStore();
  });
});
