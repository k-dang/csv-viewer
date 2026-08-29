import { link, readFile, rename } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CsvWorkspaceFixture } from './testing/csv-workspace-fixture';

describe('DesktopWorkspaceHost behavior', () => {
  let fixture: CsvWorkspaceFixture;

  beforeEach(async () => {
    fixture = await CsvWorkspaceFixture.create();
  });

  afterEach(async () => {
    await fixture.dispose();
  });

  it('maps hard links for one CSV Source to one open Working CSV', async () => {
    const filePath = await fixture.writeSource('dedupe.csv', 'value\n1\n');
    const aliasPath = fixture.file('dedupe-alias.csv');
    await link(filePath, aliasPath);
    const workingCsv = await fixture.open(filePath);

    await expect(
      fixture.viewer.call({
        operation: 'csv.open-recent',
        sourceId: await fixture.sourceId(aliasPath),
      }),
    ).resolves.toEqual({ status: 'already-open', workingCsv });
  });

  it('rejects an Export CSV destination with the CSV Source identity and re-prompts', async () => {
    const filePath = await fixture.writeSource('protected-source.csv', 'name\nAda\n');
    const sourceAliasPath = fixture.file('protected-source-alias.csv');
    await link(filePath, sourceAliasPath);
    const workingCsv = await fixture.open(filePath);
    await fixture.viewer.call({
      operation: 'csv.edit-cell',
      workingCsvId: workingCsv.workingCsvId,
      rowId: '1',
      column: 'name',
      value: 'Grace',
    });
    fixture.prompts.exportChoices.push(sourceAliasPath);
    const readExported = fixture.captureNextExport('protected-output.csv');

    await expect(
      fixture.viewer.call({ operation: 'csv.export', workingCsvId: workingCsv.workingCsvId }),
    ).resolves.toMatchObject({ status: 'exported', editState: { hasUnexportedChanges: false } });
    expect(fixture.prompts.sourceConflictCount).toBe(1);
    expect(fixture.prompts.defaultExportPaths).toEqual([
      fixture.file('protected-source-edited.csv'),
      fixture.file('protected-source-edited.csv'),
    ]);
    await expect(readFile(filePath, 'utf8')).resolves.toBe('name\nAda\n');
    await expect(readExported()).resolves.toContain('Grace');
  });

  it('retains CSV Source identity when the source is moved after opening', async () => {
    const filePath = await fixture.writeSource('source-before-move.csv', 'name\nAda\n');
    const movedSourcePath = fixture.file('source-after-move.csv');
    const workingCsv = await fixture.open(filePath);
    await rename(filePath, movedSourcePath);
    fixture.prompts.exportChoices.push(movedSourcePath);
    fixture.captureNextExport('moved-output.csv');

    await fixture.viewer.call({ operation: 'csv.export', workingCsvId: workingCsv.workingCsvId });

    expect(fixture.prompts.sourceConflictCount).toBe(1);
  });

  it('records opened CSV Sources as Recent CSV Sources, most recent first', async () => {
    const first = await fixture.openSource('recent-first.csv', 'a\n1\n');
    const second = await fixture.openSource('recent-second.csv', 'b\n2\n');

    const recents = await fixture.viewer.call({ operation: 'csv.get-recent-sources' });

    expect(recents.map((recent) => recent.name)).toEqual(['recent-second.csv', 'recent-first.csv']);
    expect(recents.map((recent) => recent.sourceId)).toEqual([second.source.sourceId, first.source.sourceId]);
    expect(recents[0].location).toBe(fixture.file('recent-second.csv'));
    expect(recents[0].sizeBytes).toBeGreaterThan(0);
  });

  it('opens a CSV Source chosen through the desktop picker and cancels cleanly', async () => {
    const filePath = await fixture.writeSource('picked.csv', 'a\n1\n');

    await expect(fixture.viewer.call({ operation: 'csv.open' })).resolves.toEqual({
      status: 'cancelled',
    });

    fixture.prompts.sourceChoices.push(filePath);
    await expect(fixture.viewer.call({ operation: 'csv.open' })).resolves.toMatchObject({
      status: 'opened',
      workingCsv: { source: { name: 'picked.csv' } },
    });
  });

  it('keeps the Working CSV usable and closable while desktop export delivery waits', async () => {
    const workingCsv = await fixture.openSource('export-during-delivery.csv', 'name\nAda\nGrace\n');
    const readExported = fixture.captureNextExport('delivered.csv');
    const prompting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.prompts.holdExportPrompt = () => {
      prompting.resolve();
      return release.promise;
    };

    const exporting = fixture.viewer.call({ operation: 'csv.export', workingCsvId: workingCsv.workingCsvId });
    await prompting.promise;

    await expect(
      fixture.viewer.call({ operation: 'csv.get-rows', workingCsvId: workingCsv.workingCsvId, offset: 0, limit: 10 }),
    ).resolves.toMatchObject({ filteredRowCount: 2 });
    await expect(
      fixture.viewer.call({ operation: 'csv.close', workingCsvId: workingCsv.workingCsvId }),
    ).resolves.toMatchObject({ status: 'closed' });

    release.resolve();
    await expect(exporting).resolves.toMatchObject({
      status: 'exported',
      editState: { hasUnexportedChanges: false },
    });
    await expect(readExported()).resolves.toContain('Grace');
  });

  it('keeps later edits unexported when desktop delivery contains an earlier revision', async () => {
    const workingCsv = await fixture.openSource('export-raced.csv', 'name,code\nAda,001\n');
    const request = { workingCsvId: workingCsv.workingCsvId };
    const readExported = fixture.captureNextExport('raced.csv');
    const prompting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.prompts.holdExportPrompt = () => {
      prompting.resolve();
      return release.promise;
    };

    const exporting = fixture.viewer.call({ operation: 'csv.export', ...request });
    await prompting.promise;
    await fixture.viewer.call({ operation: 'csv.edit-cell', ...request, rowId: '1', column: 'code', value: '002' });
    release.resolve();

    await expect(exporting).resolves.toMatchObject({
      status: 'exported',
      editState: { hasUnexportedChanges: true },
    });
    await expect(readExported()).resolves.toContain('001');
    await expect(fixture.viewer.call({ operation: 'csv.undo', ...request })).resolves.toMatchObject({
      hasUnexportedChanges: false,
    });
  });
});
