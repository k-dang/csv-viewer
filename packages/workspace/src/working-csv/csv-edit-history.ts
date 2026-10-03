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
 */
export class CsvEditHistory {
  private readonly undoStack: CsvEditCommand[] = [];
  private readonly redoStack: CsvEditCommand[] = [];
  private currentRevisionId: number;
  private lastExportedRevisionId: number;
  private nextRevisionId: number;

  constructor(initialRevisionId = 0) {
    this.currentRevisionId = initialRevisionId;
    this.lastExportedRevisionId = initialRevisionId;
    this.nextRevisionId = initialRevisionId + 1;
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
  markExported(revisionId: number): void {
    this.lastExportedRevisionId = revisionId;
  }

  record(draft: CsvEditDraft): void {
    const command: CsvEditCommand = {
      ...draft,
      previousRevisionId: this.currentRevisionId,
      revisionId: this.nextRevisionId,
    };
    this.currentRevisionId = command.revisionId;
    this.nextRevisionId += 1;
    this.undoStack.push(command);
    this.redoStack.length = 0;
  }

  /** Commit the history step only after its command replays successfully. */
  step(direction: 'undo' | 'redo'): Result.Result<CsvEditStep, WorkspaceRequestError> {
    const [from, to] = direction === 'undo' ? [this.undoStack, this.redoStack] : [this.redoStack, this.undoStack];
    return Result.map(
      Result.fromNullishOr(
        from.at(-1),
        () => new WorkspaceRequestError({ message: `No CSV edit is available to ${direction}.` }),
      ),
      (command) => ({
        command,
        commit: () => {
          from.pop();
          to.push(command);
          this.currentRevisionId = direction === 'undo' ? command.previousRevisionId : command.revisionId;
        },
      }),
    );
  }
}

export type CsvEditStep = { command: CsvEditCommand; commit: () => void };

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
