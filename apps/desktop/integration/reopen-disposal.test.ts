import { expect, it, vi } from 'vitest';
import { CsvWorkspaceFixture } from './fixtures/desktop-workspace';

it('disposes the workspace while a reopen discard prompt waits for the user', async () => {
  const fixture = await CsvWorkspaceFixture.create();
  try {
    const csv = await fixture.openSource('edited.csv', 'id,value\n1,before\n');
    await fixture.viewer.call({
      operation: 'csv.edit-cell', workingCsvId: csv.workingCsvId, rowId: '1', column: 'value', value: 'changed',
    });
    const promptEntered = Promise.withResolvers<void>();
    const answerPrompt = Promise.withResolvers<void>();
    fixture.prompts.holdDiscardPrompt = async () => {
      promptEntered.resolve();
      await answerPrompt.promise;
    };
    fixture.prompts.discardChoices.push(true);
    const reopening = fixture.viewer.call({ operation: 'csv.reopen', workingCsvId: csv.workingCsvId });
    await promptEntered.promise;
    let disposed = false;
    const disposal = fixture.disposeWorkspace().then(() => { disposed = true; });

    try {
      await vi.waitUntil(() => disposed, { interval: 1, timeout: 1000 });
    } finally {
      answerPrompt.resolve();
      await Promise.allSettled([reopening, disposal]);
    }

    await expect(reopening).resolves.toEqual({ status: 'failed', message: 'The CSV workspace is closing.' });
  } finally {
    await fixture.dispose();
  }
});

it('asks again when the Working CSV changes during discard confirmation', async () => {
  const fixture = await CsvWorkspaceFixture.create();
  try {
    const csv = await fixture.openSource('edited.csv', 'id,value\n1,before\n');
    await fixture.viewer.call({
      operation: 'csv.edit-cell', workingCsvId: csv.workingCsvId, rowId: '1', column: 'value', value: 'first edit',
    });
    const promptEntered = Promise.withResolvers<void>();
    const answerFirstPrompt = Promise.withResolvers<void>();
    let promptCount = 0;
    fixture.prompts.holdDiscardPrompt = async () => {
      promptCount += 1;
      if (promptCount === 1) {
        promptEntered.resolve();
        await answerFirstPrompt.promise;
      }
    };
    fixture.prompts.discardChoices.push(true, false);
    const reopening = fixture.viewer.call({ operation: 'csv.reopen', workingCsvId: csv.workingCsvId });
    await promptEntered.promise;
    let editFinished = false;
    const edit = fixture.viewer.call({
      operation: 'csv.edit-cell', workingCsvId: csv.workingCsvId, rowId: '1', column: 'value', value: 'second edit',
    }).then(() => { editFinished = true; });
    try {
      await vi.waitUntil(() => editFinished, { interval: 1, timeout: 1000 });
    } finally {
      answerFirstPrompt.resolve();
      await edit;
    }

    await expect(reopening).resolves.toEqual({ status: 'cancelled' });
    expect(promptCount).toBe(2);
    const rows = await fixture.viewer.call({ operation: 'csv.get-rows', workingCsvId: csv.workingCsvId, offset: 0, limit: 1 });
    expect(rows.rows[0].value).toBe('second edit');
  } finally {
    await fixture.dispose();
  }
});
