import * as filesystem from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CsvWorkspaceFixture } from './fixtures/desktop-workspace';

describe('desktop view export delivery through CsvViewer', () => {
  let fixture: CsvWorkspaceFixture;
  let failWrite = false;
  beforeEach(async () => {
    failWrite = false;
    fixture = await CsvWorkspaceFixture.create(undefined, undefined, async (temporaryPath, contents) => {
      await filesystem.writeFile(temporaryPath, failWrite ? 'partial' : contents, { encoding: 'utf8', flag: 'wx' });
      if (failWrite) throw Object.assign(new Error('Injected write failure'), { code: 'EIO' });
    });
  });
  afterEach(async () => { await fixture.dispose(); });

  it.each([false, true])('does not publish partial bytes after a write failure (existing destination: %s)', async (existing) => {
    const csv = await fixture.openSource('source.csv', 'id,value\n1,new\n');
    if (existing) await fixture.writeSource('output.csv', 'keep these bytes');
    const readExported = fixture.captureNextExport('output.csv');
    failWrite = true;
    await expect(fixture.viewer.call({ operation: 'csv.export-view', workingCsvId: csv.workingCsvId })).rejects.toThrow('The export destination could not be accessed.');
    if (existing) await expect(readExported()).resolves.toBe('keep these bytes');
    else await expect(readExported()).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await filesystem.readdir(fixture.directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('delivers prepared contents after reopen and protects the captured source', async () => {
    const csv = await fixture.openSource('orders.csv', 'id,value\n1,before\n');
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    fixture.prompts.holdExportPrompt = async () => { fixture.prompts.holdExportPrompt = undefined; entered.resolve(); await resume.promise; };
    fixture.prompts.exportChoices.push(fixture.file('orders.csv'));
    const readExported = fixture.captureNextExport('orders-view.csv');
    const exported = fixture.viewer.call({ operation: 'csv.export-view', workingCsvId: csv.workingCsvId });
    try {
      await entered.promise;
      await fixture.writeSource('orders.csv', 'id,value\n1,after\n');
      await expect(fixture.viewer.call({ operation: 'csv.reopen', workingCsvId: csv.workingCsvId })).resolves.toMatchObject({ status: 'opened' });
    } finally { resume.resolve(); }
    await expect(exported).resolves.toEqual({ status: 'exported', rowCount: 1 });
    await expect(readExported()).resolves.toBe('id,value\n1,before\n');
    await expect(filesystem.readFile(fixture.file('orders.csv'), 'utf8')).resolves.toBe('id,value\n1,after\n');
    expect(fixture.prompts.sourceConflictCount).toBe(1);
    expect(fixture.prompts.defaultExportPaths[0]).toBe(fixture.file('orders-view.csv'));
  });
});
