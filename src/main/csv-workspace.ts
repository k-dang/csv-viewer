import type { ComparisonExecutor } from './comparison-executor';
import {
  CsvComparisonService,
  type BeginComparisonResult,
} from './csv-comparison-service';
import { WorkingCsvStore } from './working-csv-store';
import type {
  BeginComparisonRequest,
  CancelComparisonRequest,
  CancelComparisonResult,
  CloseImpact,
  CloseComparisonResult,
  CloseWorkingCsvOutcome,
  CloseWorkingCsvRequest,
  ComparisonCandidate,
  ComparisonEvent,
  ComparisonId,
  ComparisonMutationOutcome,
  ComparisonView,
  ComparisonWindowOutcome,
  ComparisonWindowRequest,
  CsvCellEditRequest,
  CsvCellEditResult,
  CsvColumnValueCounts,
  CsvColumnValueCountsRequest,
  CsvDeleteRowsRequest,
  CsvDialectOptions,
  CsvEditState,
  CsvInsertRowRequest,
  CsvRowWindow,
  CsvRowWindowRequest,
  OpenComparisonResult,
  OpenComparisonRequest,
  OpenWorkingCsvOutcome,
  ReplaceWorkingCsvOutcome,
  WorkingCsvView,
  WorkingCsvId,
} from '../shared/ipc';

export interface WorkingCsvs {
  open(filePath: string, dialect?: CsvDialectOptions): Promise<OpenWorkingCsvOutcome>;
  replace(
    workingCsvId: WorkingCsvId,
    dialect?: CsvDialectOptions,
  ): Promise<ReplaceWorkingCsvOutcome>;
  getState(workingCsvId: WorkingCsvId): WorkingCsvView | null;
  getRows(request: CsvRowWindowRequest): Promise<CsvRowWindow>;
  getColumnValueCounts(request: CsvColumnValueCountsRequest): Promise<CsvColumnValueCounts>;
  editCell(request: CsvCellEditRequest): Promise<CsvCellEditResult>;
  deleteRows(request: CsvDeleteRowsRequest): Promise<CsvEditState>;
  insertRow(request: CsvInsertRowRequest): Promise<CsvEditState>;
  undo(workingCsvId: WorkingCsvId): Promise<CsvEditState>;
  redo(workingCsvId: WorkingCsvId): Promise<CsvEditState>;
  saveAs(workingCsvId: WorkingCsvId, filePath: string): Promise<CsvEditState>;
}

export type WorkspaceCloseImpact = {
  dirtyWorkingCsvs: Array<{ workingCsvId: WorkingCsvId; fileName: string }>;
  dependentComparisons: CloseImpact['dependentComparisons'];
};

export type ConfirmWorkspaceCloseOutcome =
  | { status: 'ready' }
  | { status: 'confirmation-required'; impact: WorkspaceCloseImpact };

export interface Comparisons {
  candidatesFor(baselineId: WorkingCsvId): ComparisonCandidate[];
  open(request: OpenComparisonRequest): OpenComparisonResult;
  getState(comparisonId: ComparisonId): ComparisonView | null;
  begin(request: BeginComparisonRequest): BeginComparisonResult;
  cancel(request: CancelComparisonRequest): Promise<CancelComparisonResult>;
  getWindow(request: ComparisonWindowRequest): Promise<ComparisonWindowOutcome>;
  swap(comparisonId: ComparisonId): ComparisonMutationOutcome;
  close(comparisonId: ComparisonId): Promise<CloseComparisonResult>;
  subscribe(listener: (event: ComparisonEvent) => void): () => void;
}

export class CsvWorkspace {
  readonly csvs: WorkingCsvs;
  readonly comparisons: Comparisons;
  private readonly csvStore: WorkingCsvStore;
  private readonly comparisonStore: CsvComparisonService;
  private disposal: Promise<void> | null = null;

  constructor(csvs = new WorkingCsvStore(), executor?: ComparisonExecutor) {
    this.csvStore = csvs;
    this.csvs = csvs;
    this.comparisonStore = new CsvComparisonService(
      csvs,
      executor ?? csvs.createComparisonExecutor(),
    );
    this.comparisons = this.comparisonStore;
  }

  async closeWorkingCsv(request: CloseWorkingCsvRequest): Promise<CloseWorkingCsvOutcome> {
    const { workingCsvId, confirmedImpact } = request;
    const workingCsv = this.csvs.getState(workingCsvId);
    if (!workingCsv) {
      return { status: 'closed', closedWorkingCsvId: workingCsvId, closedComparisonIds: [] };
    }

    if (!this.csvStore.beginClose(workingCsvId)) {
      return {
        status: 'failed',
        failure: {
          code: 'cleanup-failed',
          message: 'The Working CSV is already closing.',
          retryable: true,
        },
      };
    }

    try {
      await this.csvStore.waitForActiveWork(workingCsvId);
      const impact = this.closeImpact(workingCsvId);
      if (requiresConfirmation(impact) && !sameImpact(impact, confirmedImpact)) {
        return { status: 'confirmation-required', impact };
      }
      const closedComparisonIds = impact.dependentComparisons.map(
        (comparison) => comparison.comparisonId,
      );
      await this.comparisonStore.closeDependents(workingCsvId);
      await this.csvStore.closeWorkingCsv(workingCsvId);
      return { status: 'closed', closedWorkingCsvId: workingCsvId, closedComparisonIds };
    } catch (error) {
      console.error(`Failed to close Working CSV ${workingCsvId}.`, error);
      return {
        status: 'failed',
        failure: {
          code: 'cleanup-failed',
          message: 'Unable to close the Working CSV and all dependent Comparisons.',
          retryable: true,
        },
      };
    } finally {
      if (this.csvStore.getState(workingCsvId)) this.csvStore.endClose(workingCsvId);
    }
  }

  confirmWindowClose(confirmedImpact?: WorkspaceCloseImpact): ConfirmWorkspaceCloseOutcome {
    const impact = this.windowCloseImpact();
    if (!requiresWorkspaceConfirmation(impact)) return { status: 'ready' };
    if (!sameWorkspaceImpact(impact, confirmedImpact)) {
      return { status: 'confirmation-required', impact };
    }
    return { status: 'ready' };
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.csvStore.beginDisposal();
      this.comparisonStore.beginDisposal();
      this.disposal = this.disposeWorkspace().catch((error) => {
        this.disposal = null;
        throw error;
      });
    }
    return this.disposal;
  }

  private closeImpact(workingCsvId: WorkingCsvId): CloseImpact {
    const workingCsv = this.csvs.getState(workingCsvId);
    if (!workingCsv) throw new Error('Working CSV is no longer active.');
    return {
      dirty: this.csvStore.isDirty(workingCsvId),
      dependentComparisons: this.comparisonStore
        .dependentComparisonIds(workingCsvId)
        .map((comparisonId) => {
          const comparison = this.comparisons.getState(comparisonId);
          if (!comparison) {
            throw new Error(
              `Comparison ${comparisonId} disappeared while calculating close impact.`,
            );
          }
          return {
            comparisonId,
            baselineName: comparison.baseline.file.name,
            candidateName: comparison.candidate.file.name,
          };
        })
        .sort((left, right) => left.comparisonId.localeCompare(right.comparisonId)),
    };
  }

  private windowCloseImpact(): WorkspaceCloseImpact {
    const workingCsvs = this.csvStore
      .list()
      .sort((left, right) => left.workingCsvId.localeCompare(right.workingCsvId));
    const dependentComparisons = new Map<ComparisonId, CloseImpact['dependentComparisons'][number]>();
    for (const workingCsv of workingCsvs) {
      for (const comparisonId of this.comparisonStore.dependentComparisonIds(
        workingCsv.workingCsvId,
      )) {
        if (dependentComparisons.has(comparisonId)) continue;
        const comparison = this.comparisonStore.getState(comparisonId);
        if (!comparison) {
          throw new Error(`Comparison ${comparisonId} disappeared while calculating close impact.`);
        }
        dependentComparisons.set(comparisonId, {
          comparisonId,
          baselineName: comparison.baseline.file.name,
          candidateName: comparison.candidate.file.name,
        });
      }
    }
    return {
      dirtyWorkingCsvs: workingCsvs
        .filter((workingCsv) => workingCsv.editState.dirty)
        .map((workingCsv) => ({
          workingCsvId: workingCsv.workingCsvId,
          fileName: workingCsv.file.name,
        })),
      dependentComparisons: [...dependentComparisons.values()].sort((left, right) =>
        left.comparisonId.localeCompare(right.comparisonId),
      ),
    };
  }

  private async disposeWorkspace(): Promise<void> {
    await this.comparisonStore.dispose();
    await this.csvStore.disposeStore();
  }
}

function requiresConfirmation(impact: CloseImpact): boolean {
  return impact.dirty || impact.dependentComparisons.length > 0;
}

function sameImpact(current: CloseImpact, confirmed: CloseImpact | undefined): boolean {
  if (!confirmed) return false;
  return (
    current.dirty === confirmed.dirty &&
    sameDependentComparisons(current.dependentComparisons, confirmed.dependentComparisons)
  );
}

function requiresWorkspaceConfirmation(impact: WorkspaceCloseImpact): boolean {
  return impact.dirtyWorkingCsvs.length > 0 || impact.dependentComparisons.length > 0;
}

function sameWorkspaceImpact(
  current: WorkspaceCloseImpact,
  confirmed: WorkspaceCloseImpact | undefined,
): boolean {
  if (!confirmed) return false;
  return (
    current.dirtyWorkingCsvs.length === confirmed.dirtyWorkingCsvs.length &&
    current.dirtyWorkingCsvs.every((workingCsv, index) => {
      const other = confirmed.dirtyWorkingCsvs[index];
      return (
        workingCsv.workingCsvId === other.workingCsvId && workingCsv.fileName === other.fileName
      );
    }) &&
    sameDependentComparisons(current.dependentComparisons, confirmed.dependentComparisons)
  );
}

function sameDependentComparisons(
  current: CloseImpact['dependentComparisons'],
  confirmed: CloseImpact['dependentComparisons'],
): boolean {
  return (
    current.length === confirmed.length &&
    current.every((comparison, index) => {
      const other = confirmed[index];
      return (
        comparison.comparisonId === other.comparisonId &&
        comparison.baselineName === other.baselineName &&
        comparison.candidateName === other.candidateName
      );
    })
  );
}
