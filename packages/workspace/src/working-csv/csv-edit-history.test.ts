import { Result } from 'effect';
import { describe, expect, it } from 'vitest';
import { WorkspaceRequestError } from '../errors';
import { CsvEditHistory } from './csv-edit-history';

describe('CsvEditHistory', () => {
  it('reports the existing messages when there is nothing to undo or redo', () => {
    const history = CsvEditHistory.create();
    expect(history.step('undo')).toEqual(
      Result.fail(new WorkspaceRequestError({ message: 'No CSV edit is available to undo.' })),
    );
    expect(history.step('redo')).toEqual(
      Result.fail(new WorkspaceRequestError({ message: 'No CSV edit is available to redo.' })),
    );
  });

  it('returns the next history without changing the history that was stepped', () => {
    const history = CsvEditHistory.create(3).record({ type: 'insert-row', rowId: '9' });
    const undo = Result.getOrThrow(history.step('undo'));

    expect(Result.getOrThrow(history.step('undo')).command).toBe(undo.command);
    expect([history.canUndo, history.canRedo, history.currentRevision]).toEqual([true, false, 4]);

    const undone = undo.history;
    expect([undone.canUndo, undone.canRedo, undone.currentRevision]).toEqual([false, true, 3]);
    expect([history.canUndo, history.canRedo, history.currentRevision]).toEqual([true, false, 4]);

    const redone = Result.getOrThrow(undone.step('redo')).history;
    expect([redone.canUndo, redone.canRedo, redone.currentRevision]).toEqual([true, false, 4]);
  });
});
