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
      fixture.workspace.openRecentCsv(await fixture.sourceId(aliasPath)),
    ).resolves.toEqual({ status: 'already-open', workingCsv });
  });

  it('rejects an Export CSV destination with the CSV Source identity and re-prompts', async () => {
    const filePath = await fixture.writeSource(
      'protected-source.csv',
      'name\nAda\n',
    );
    const sourceAliasPath = fixture.file('protected-source-alias.csv');
    await link(filePath, sourceAliasPath);
    const workingCsv = await fixture.open(filePath);
    await fixture.workspace.editCsvCell({
      workingCsvId: workingCsv.workingCsvId,
      rowId: '1',
      column: 'name',
      value: 'Grace',
    });
    fixture.prompts.exportChoices.push(sourceAliasPath);
    const outputPath = fixture.queueExportTo('protected-output.csv');

    await expect(
      fixture.workspace.exportCsv({ workingCsvId: workingCsv.workingCsvId }),
    ).resolves.toMatchObject({ hasUnexportedChanges: false });
    expect(fixture.prompts.sourceConflictCount).toBe(1);
    await expect(readFile(filePath, 'utf8')).resolves.toBe('name\nAda\n');
    await expect(readFile(outputPath, 'utf8')).resolves.toContain('Grace');
  });

  it('retains CSV Source identity when the source is moved after opening', async () => {
    const filePath = await fixture.writeSource(
      'source-before-move.csv',
      'name\nAda\n',
    );
    const movedSourcePath = fixture.file('source-after-move.csv');
    const workingCsv = await fixture.open(filePath);
    await rename(filePath, movedSourcePath);
    fixture.prompts.exportChoices.push(movedSourcePath);
    fixture.queueExportTo('moved-output.csv');

    await fixture.workspace.exportCsv({
      workingCsvId: workingCsv.workingCsvId,
    });

    expect(fixture.prompts.sourceConflictCount).toBe(1);
  });

  it('records opened CSV Sources as Recent CSV Sources, most recent first', async () => {
    const first = await fixture.openSource('recent-first.csv', 'a\n1\n');
    const second = await fixture.openSource('recent-second.csv', 'b\n2\n');

    const recents = await fixture.workspace.getRecentCsvSources();

    expect(recents.map((recent) => recent.name)).toEqual([
      'recent-second.csv',
      'recent-first.csv',
    ]);
    expect(recents.map((recent) => recent.sourceId)).toEqual([
      second.file.sourceId,
      first.file.sourceId,
    ]);
    expect(recents[0].location).toBe(fixture.file('recent-second.csv'));
    expect(recents[0].sizeBytes).toBeGreaterThan(0);
  });

  it('opens a CSV Source chosen through the desktop picker and cancels cleanly', async () => {
    const filePath = await fixture.writeSource('picked.csv', 'a\n1\n');

    await expect(fixture.workspace.openCsv()).resolves.toEqual({
      status: 'cancelled',
    });

    fixture.prompts.sourceChoices.push(filePath);
    await expect(fixture.workspace.openCsv()).resolves.toMatchObject({
      status: 'opened',
      workingCsv: { file: { name: 'picked.csv' } },
    });
  });

  it('keeps the Working CSV usable and closable while desktop export delivery waits', async () => {
    const workingCsv = await fixture.openSource(
      'export-during-delivery.csv',
      'name\nAda\nGrace\n',
    );
    fixture.queueExportTo('delivered.csv');
    const prompting = deferred();
    const release = deferred();
    fixture.prompts.holdExportPrompt = () => {
      prompting.resolve();
      return release.promise;
    };

    const exporting = fixture.workspace.exportCsv({
      workingCsvId: workingCsv.workingCsvId,
    });
    await prompting.promise;

    await expect(
      fixture.workspace.getCsvRows({
        workingCsvId: workingCsv.workingCsvId,
        offset: 0,
        limit: 10,
      }),
    ).resolves.toMatchObject({ filteredRowCount: 2 });
    await expect(
      fixture.workspace.closeCsv({ workingCsvId: workingCsv.workingCsvId }),
    ).resolves.toMatchObject({ status: 'closed' });

    release.resolve();
    await expect(exporting).resolves.toMatchObject({
      hasUnexportedChanges: false,
    });
    await expect(
      readFile(fixture.file('delivered.csv'), 'utf8'),
    ).resolves.toContain('Grace');
  });

  it('keeps later edits unexported when desktop delivery contains an earlier revision', async () => {
    const workingCsv = await fixture.openSource(
      'export-raced.csv',
      'name,code\nAda,001\n',
    );
    const request = { workingCsvId: workingCsv.workingCsvId };
    fixture.queueExportTo('raced.csv');
    const prompting = deferred();
    const release = deferred();
    fixture.prompts.holdExportPrompt = () => {
      prompting.resolve();
      return release.promise;
    };

    const exporting = fixture.workspace.exportCsv(request);
    await prompting.promise;
    await fixture.workspace.editCsvCell({
      ...request,
      rowId: '1',
      column: 'code',
      value: '002',
    });
    release.resolve();

    await expect(exporting).resolves.toMatchObject({
      hasUnexportedChanges: true,
    });
    await expect(
      readFile(fixture.file('raced.csv'), 'utf8'),
    ).resolves.toContain('001');
    await expect(fixture.workspace.undoCsvEdit(request)).resolves.toMatchObject(
      {
        hasUnexportedChanges: false,
      },
    );
  });
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
