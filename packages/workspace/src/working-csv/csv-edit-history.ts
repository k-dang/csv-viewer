import { Result } from 'effect';
import type { CsvCellValue } from '../csv-viewer';
import { WorkspaceRequestError } from '../errors';

export type CsvEditDraft =
  | {
      type: 'cell-edit';
      rowId: string;
      column: string;
      oldValue: CsvCellValue;
      newValue: CsvCellValue;
    }
  | { type: 'delete-rows'; rowIds: string[] }
  | { type: 'insert-row'; rowId: string }
  | { type: 'rename-column'; from: string; to: string }
  | { type: 'insert-column'; name: string; index: number }
  | {
      type: 'delete-column';
      name: string;
      index: number;
      columnType: string;
      hiddenName: string;
    }
  | { type: 'reorder-columns'; oldIndexes: number[] };

export type CsvEditCommand = CsvEditDraft & {
  previousRevisionId: number;
  revisionId: number;
};

/**
 * Undo and redo stacks plus the revision identity that decides Unexported Changes. Unexported
 * Changes is `currentRevisionId !== lastExportedRevisionId`, so it follows the data rather than
 * stack depth: an edit that restores the exported stack depth with different content still counts.
 * `journalId` is copied by `record`, `step`, and `markExported`. `create` starts a new journal.
 */
export class CsvEditHistory {
  private constructor(
    readonly undoStack: readonly CsvEditCommand[],
    readonly redoStack: readonly CsvEditCommand[],
    readonly currentRevisionId: number,
    readonly lastExportedRevisionId: number,
    readonly nextRevisionId: number,
    readonly journalId: symbol,
  ) {}

  static create(initialRevisionId = 0): CsvEditHistory {
    return new CsvEditHistory([], [], initialRevisionId, initialRevisionId, initialRevisionId + 1, Symbol());
  }

  get revisionSequence(): number {
    return this.nextRevisionId;
  }

  get currentRevision(): number {
    return this.currentRevisionId;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get hasUnexportedChanges(): boolean {
    return this.currentRevisionId !== this.lastExportedRevisionId;
  }

  /**
   * Records which revision the last successful export delivered. Passing the revision explicitly
   * keeps the answer right when the Working CSV moved on while the export was being delivered:
   * Unexported Changes stay set, and returning to the delivered revision clears them.
   */
  markExported(revisionId: number): CsvEditHistory {
    if (revisionId === this.lastExportedRevisionId) return this;
    return new CsvEditHistory(
      this.undoStack,
      this.redoStack,
      this.currentRevisionId,
      revisionId,
      this.nextRevisionId,
      this.journalId,
    );
  }

  record(draft: CsvEditDraft): CsvEditHistory {
    const command: CsvEditCommand = {
      ...draft,
      previousRevisionId: this.currentRevisionId,
      revisionId: this.nextRevisionId,
    };
    return new CsvEditHistory(
      [...this.undoStack, command],
      [],
      command.revisionId,
      this.lastExportedRevisionId,
      this.nextRevisionId + 1,
      this.journalId,
    );
  }

  step(direction: 'undo' | 'redo'): Result.Result<CsvEditStep, WorkspaceRequestError> {
    const from = direction === 'undo' ? this.undoStack : this.redoStack;
    const command = from.at(-1);
    if (command === undefined) {
      return Result.fail(new WorkspaceRequestError({ message: `No CSV edit is available to ${direction}.` }));
    }
    const history = new CsvEditHistory(
      direction === 'undo' ? this.undoStack.slice(0, -1) : [...this.undoStack, command],
      direction === 'undo' ? [...this.redoStack, command] : this.redoStack.slice(0, -1),
      direction === 'undo' ? command.previousRevisionId : command.revisionId,
      this.lastExportedRevisionId,
      this.nextRevisionId,
      this.journalId,
    );
    return Result.succeed({ command, history });
  }
}

export type CsvEditStep = { command: CsvEditCommand; history: CsvEditHistory };

export function rowCountDelta(command: CsvEditCommand, direction: 'undo' | 'redo'): number {
  const sign = direction === 'redo' ? 1 : -1;
  switch (command.type) {
    case 'cell-edit':
    case 'rename-column':
    case 'insert-column':
    case 'delete-column':
    case 'reorder-columns':
      return 0;
    case 'delete-rows':
      return sign * -command.rowIds.length;
    case 'insert-row':
      return sign;
    default: {
      const exhaustive: never = command;
      throw new Error(`Unsupported CSV edit command: ${String(exhaustive)}`);
    }
  }
}
