import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { csvInternalRowIdField } from '../shared/csv-viewer-contract';
import { CsvWorkspaceFixture } from '../main/testing/csv-workspace-fixture';

describe('Desktop CsvViewer Reopen CSV seam', () => {
  let fixture: CsvWorkspaceFixture;

  beforeEach(async () => {
    fixture = await CsvWorkspaceFixture.create();
  });

  afterEach(async () => {
    await fixture.dispose();
  });

  it('owns Reopen CSV confirmation and preserves changes when it is cancelled', async () => {
    const opened = await fixture.openSource('people.csv', 'name\nAda\n');
    const rows = await fixture.viewer.call({
      operation: 'csv.get-rows',
      workingCsvId: opened.workingCsvId,
      offset: 0,
      limit: 10,
    });
    await fixture.viewer.call({
      operation: 'csv.edit-cell',
      workingCsvId: opened.workingCsvId,
      rowId: rows.rows[0][csvInternalRowIdField],
      column: 'name',
      value: 'Grace',
    });

    fixture.prompts.discardChoices.push(false);
    await expect(
      fixture.viewer.call({ operation: 'csv.reopen', workingCsvId: opened.workingCsvId }),
    ).resolves.toEqual({ status: 'cancelled' });

    const unchanged = await fixture.viewer.call({
      operation: 'csv.get-rows',
      workingCsvId: opened.workingCsvId,
      offset: 0,
      limit: 10,
    });
    expect(unchanged.rows[0].name).toBe('Grace');

    fixture.prompts.discardChoices.push(true);
    const reopened = await fixture.viewer.call({
      operation: 'csv.reopen',
      workingCsvId: opened.workingCsvId,
    });
    expect(reopened.status).toBe('opened');
    const restored = await fixture.viewer.call({
      operation: 'csv.get-rows',
      workingCsvId: opened.workingCsvId,
      offset: 0,
      limit: 10,
    });
    expect(restored.rows[0].name).toBe('Ada');
  });

  it('does not discard an edit admitted concurrently with Reopen CSV', async () => {
    const opened = await fixture.openSource('people.csv', 'name\nAda\n');
    const rows = await fixture.viewer.call({
      operation: 'csv.get-rows',
      workingCsvId: opened.workingCsvId,
      offset: 0,
      limit: 10,
    });

    fixture.prompts.discardChoices.push(false);
    const edit = fixture.viewer.call({
      operation: 'csv.edit-cell',
      workingCsvId: opened.workingCsvId,
      rowId: rows.rows[0][csvInternalRowIdField],
      column: 'name',
      value: 'Grace',
    });
    const reopen = fixture.viewer.call({
      operation: 'csv.reopen',
      workingCsvId: opened.workingCsvId,
    });

    await edit;
    await expect(reopen).resolves.toEqual({ status: 'cancelled' });
    const unchanged = await fixture.viewer.call({
      operation: 'csv.get-rows',
      workingCsvId: opened.workingCsvId,
      offset: 0,
      limit: 10,
    });
    expect(unchanged.rows[0].name).toBe('Grace');
  });

  it('applies a queued edit to the replacement created by Reopen CSV', async () => {
    const opened = await fixture.openSource('people.csv', 'name\nAda\n');
    const rows = await fixture.viewer.call({
      operation: 'csv.get-rows',
      workingCsvId: opened.workingCsvId,
      offset: 0,
      limit: 10,
    });
    const originalWithEngineSource = fixture.host.withEngineSource.bind(fixture.host);
    const sourceRead = Promise.withResolvers<void>();
    const sourceReadRelease = Promise.withResolvers<void>();
    fixture.host.withEngineSource = async <T>(sourceId: string, use: (reference: string) => Promise<T>) => {
      sourceRead.resolve();
      await sourceReadRelease.promise;
      return originalWithEngineSource(sourceId, use);
    };

    const reopen = fixture.viewer.call({
      operation: 'csv.reopen',
      workingCsvId: opened.workingCsvId,
    });
    await sourceRead.promise;
    const edit = fixture.viewer.call({
      operation: 'csv.edit-cell',
      workingCsvId: opened.workingCsvId,
      rowId: rows.rows[0][csvInternalRowIdField],
      column: 'name',
      value: 'Grace',
    });
    sourceReadRelease.resolve();

    await expect(reopen).resolves.toMatchObject({ status: 'opened' });
    await edit;
    const currentRows = await fixture.viewer.call({
      operation: 'csv.get-rows',
      workingCsvId: opened.workingCsvId,
      offset: 0,
      limit: 10,
    });
    expect(currentRows.rows[0].name).toBe('Grace');
  });

});
