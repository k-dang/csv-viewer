import { Result } from 'effect';
import { describe, expect, it } from 'vitest';
import { WorkspaceRequestError } from '../errors';
import { CsvEditHistory } from './csv-edit-history';

describe('CsvEditHistory', () => {
  it('reports the existing messages when there is nothing to undo or redo', () => {
    const history = new CsvEditHistory();
    expect(history.step('undo')).toEqual(
      Result.fail(new WorkspaceRequestError({ message: 'No CSV edit is available to undo.' })),
    );
    expect(history.step('redo')).toEqual(
      Result.fail(new WorkspaceRequestError({ message: 'No CSV edit is available to redo.' })),
    );
  });

  it('changes stacks and revision only when a step is committed', () => {
    const history = new CsvEditHistory(3);
    history.record({ type: 'insert-row', rowId: '9' });
    const undo = Result.getOrThrow(history.step('undo'));

    expect(Result.getOrThrow(history.step('undo')).command).toBe(undo.command);
    expect([history.canUndo, history.canRedo, history.currentRevision]).toEqual([true, false, 4]);

    undo.commit();
    expect([history.canUndo, history.canRedo, history.currentRevision]).toEqual([false, true, 3]);

    Result.getOrThrow(history.step('redo')).commit();
    expect([history.canUndo, history.canRedo, history.currentRevision]).toEqual([true, false, 4]);
  });
});
