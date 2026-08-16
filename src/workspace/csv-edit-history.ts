import type { CsvCellValue } from '../shared/ipc';

export type CsvEditDraft =
  | {
      type: 'cell-edit';
      rowId: string;
      column: string;
      oldValue: CsvCellValue;
      newValue: CsvCellValue;
    }
  | { type: 'delete-rows'; rowIds: string[] }
  | { type: 'insert-row'; rowId: string };

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

  async undo(revert: (command: CsvEditCommand) => Promise<void>): Promise<CsvEditCommand> {
    const command = this.undoStack.at(-1);
    if (!command) throw new Error('No CSV edit is available to undo.');
    await revert(command);
    this.undoStack.pop();
    this.redoStack.push(command);
    this.currentRevisionId = command.previousRevisionId;
    return command;
  }

  async redo(apply: (command: CsvEditCommand) => Promise<void>): Promise<CsvEditCommand> {
    const command = this.redoStack.at(-1);
    if (!command) throw new Error('No CSV edit is available to redo.');
    await apply(command);
    this.redoStack.pop();
    this.undoStack.push(command);
    this.currentRevisionId = command.revisionId;
    return command;
  }
}

export function rowCountDelta(command: CsvEditCommand, direction: 'undo' | 'redo'): number {
  if (command.type === 'cell-edit') return 0;
  const redoDelta = command.type === 'delete-rows' ? -command.rowIds.length : 1;
  return direction === 'redo' ? redoDelta : -redoDelta;
}
