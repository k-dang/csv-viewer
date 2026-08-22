import type { ComparisonExecutor } from './comparison-executor';
import { CsvComparisonService } from './csv-comparison-service';
import { WorkingCsvStore } from './working-csv-store';
import type { CsvWorkspaceHost } from './workspace-host';
import type {
  BeginComparisonIpcResult,
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
  CsvEditStateRequest,
  CsvExportRequest,
  CsvInsertRowRequest,
  CsvRowWindow,
  CsvRowWindowRequest,
  CsvSourceId,
  OpenComparisonRequest,
  CsvWorkspaceOperations,
  OpenComparisonResult,
  OpenCsvResult,
  RecentCsvSource,
  ReplaceWorkingCsvOutcome,
  WorkingCsvId,
  WorkingCsvView,
} from '../shared/csv-viewer-contract';

export type WorkspaceCloseImpact = {
  workingCsvsWithUnexportedChanges: Array<{ workingCsvId: WorkingCsvId; fileName: string }>;
  dependentComparisons: CloseImpact['dependentComparisons'];
};

export type ConfirmWorkspaceCloseOutcome =
  | { status: 'ready' }
  | { status: 'confirmation-required'; impact: WorkspaceCloseImpact };

/**
 * The one shared, runtime-neutral domain seam. Every operation is asynchronous and every request,
 * result, and event is structured-clone-safe, so desktop can reach it over IPC while web wires it
 * up in the page. Everything below it - the Working CSV store, edit history, query construction,
 * comparison orchestration, and database access - is internal implementation.
 */
export class CsvWorkspace implements CsvWorkspaceOperations {
  private readonly csvStore: WorkingCsvStore;
  private readonly comparisonStore: CsvComparisonService;
  private disposal: Promise<void> | null = null;

  constructor(
    private readonly host: CsvWorkspaceHost,
    executor?: ComparisonExecutor,
  ) {
    this.csvStore = new WorkingCsvStore(host);
    this.comparisonStore = new CsvComparisonService(
      this.csvStore,
      executor ?? this.csvStore.createComparisonExecutor(),
    );
  }

  async openCsv(options?: CsvDialectOptions): Promise<OpenCsvResult> {
    const sourceId = await this.host.acquireSource();
    if (!sourceId) return { status: 'cancelled' };
    return this.openRecentCsv(sourceId, options);
  }

  async openRecentCsv(sourceId: CsvSourceId, options?: CsvDialectOptions): Promise<OpenCsvResult> {
    const outcome = await this.csvStore.open(sourceId, options);
    if (outcome.status === 'failed') return { status: 'failed', message: outcome.failure.message };
    if (outcome.status === 'existing') {
      return { status: 'already-open', workingCsv: outcome.workingCsv };
    }
    await this.host.recordRecentSource(sourceId);
    return { status: 'opened', workingCsv: outcome.workingCsv };
  }

  async reopenCsv(
    workingCsvId: WorkingCsvId,
    options?: CsvDialectOptions,
  ): Promise<ReplaceWorkingCsvOutcome> {
    const outcome = await this.csvStore.replace(workingCsvId, options);
    if (outcome.status === 'replaced') {
      await this.host.recordRecentSource(outcome.workingCsv.file.sourceId);
    }
    return outcome;
  }

  async getRecentCsvSources(): Promise<RecentCsvSource[]> {
    return this.host.recentSources();
  }

  async getWorkingCsv(workingCsvId: WorkingCsvId): Promise<WorkingCsvView | null> {
    return this.csvStore.getState(workingCsvId);
  }

  async getCsvRows(request: CsvRowWindowRequest): Promise<CsvRowWindow> {
    return this.csvStore.getRows(request);
  }

  async getCsvColumnValueCounts(
    request: CsvColumnValueCountsRequest,
  ): Promise<CsvColumnValueCounts> {
    return this.csvStore.getColumnValueCounts(request);
  }

  async editCsvCell(request: CsvCellEditRequest): Promise<CsvCellEditResult> {
    return this.csvStore.editCell(request);
  }

  async deleteCsvRows(request: CsvDeleteRowsRequest): Promise<CsvEditState> {
    return this.csvStore.deleteRows(request);
  }

  async insertCsvRow(request: CsvInsertRowRequest): Promise<CsvEditState> {
    return this.csvStore.insertRow(request);
  }

  async getCsvEditState(request: CsvEditStateRequest): Promise<CsvEditState> {
    return this.csvStore.getEditState(request);
  }

  async undoCsvEdit(request: CsvEditStateRequest): Promise<CsvEditState> {
    return this.csvStore.undo(request.workingCsvId);
  }

  async redoCsvEdit(request: CsvEditStateRequest): Promise<CsvEditState> {
    return this.csvStore.redo(request.workingCsvId);
  }

  async exportCsv(request: CsvExportRequest): Promise<CsvEditState | { status: 'cancelled' }> {
    if (!this.csvStore.has(request.workingCsvId)) return { status: 'cancelled' };
    return this.csvStore.exportCsv(request.workingCsvId);
  }

  async getComparisonCandidates(baselineId: WorkingCsvId): Promise<ComparisonCandidate[]> {
    return this.comparisonStore.candidatesFor(baselineId);
  }

  async openComparison(request: OpenComparisonRequest): Promise<OpenComparisonResult> {
    return this.comparisonStore.open(request);
  }

  async getComparisonState(comparisonId: ComparisonId): Promise<ComparisonView | null> {
    return this.comparisonStore.getState(comparisonId);
  }

  /**
   * Starts a Comparison operation and returns immediately. Terminal outcomes arrive through
   * Comparison events, so nothing live crosses the seam.
   */
  async beginComparison(request: BeginComparisonRequest): Promise<BeginComparisonIpcResult> {
    const result = this.comparisonStore.begin(request);
    if (result.status !== 'accepted') return result;
    void result.completion.catch((error) => {
      console.error(`Comparison operation ${result.operationId} failed unexpectedly.`, error);
    });
    return { status: 'accepted', operationId: result.operationId };
  }

  async cancelComparison(request: CancelComparisonRequest): Promise<CancelComparisonResult> {
    return this.comparisonStore.cancel(request);
  }

  async getComparisonWindow(request: ComparisonWindowRequest): Promise<ComparisonWindowOutcome> {
    return this.comparisonStore.getWindow(request);
  }

  async swapComparison(comparisonId: ComparisonId): Promise<ComparisonMutationOutcome> {
    return this.comparisonStore.swap(comparisonId);
  }

  async closeComparison(comparisonId: ComparisonId): Promise<CloseComparisonResult> {
    return this.comparisonStore.close(comparisonId);
  }

  onComparisonEvent(listener: (event: ComparisonEvent) => void): () => void {
    return this.comparisonStore.subscribe(listener);
  }

  async closeCsv(request: CloseWorkingCsvRequest): Promise<CloseWorkingCsvOutcome> {
    const { workingCsvId, confirmedImpact } = request;
    if (!this.csvStore.has(workingCsvId)) {
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
      if (this.csvStore.has(workingCsvId)) this.csvStore.endClose(workingCsvId);
    }
  }

  async confirmWindowClose(
    confirmedImpact?: WorkspaceCloseImpact,
  ): Promise<ConfirmWorkspaceCloseOutcome> {
    const impact = this.windowCloseImpact();
    if (!requiresWorkspaceConfirmation(impact)) return { status: 'ready' };
    if (!sameImpact(impact, confirmedImpact)) {
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
    if (!this.csvStore.has(workingCsvId)) {
      throw new Error('Working CSV is no longer active.');
    }
    return {
      hasUnexportedChanges: this.csvStore.hasUnexportedChanges(workingCsvId),
      dependentComparisons: this.describeDependentComparisons([workingCsvId]),
    };
  }

  private windowCloseImpact(): WorkspaceCloseImpact {
    const workingCsvs = this.csvStore
      .list()
      .sort((left, right) => left.workingCsvId.localeCompare(right.workingCsvId));
    return {
      workingCsvsWithUnexportedChanges: workingCsvs
        .filter((workingCsv) => workingCsv.editState.hasUnexportedChanges)
        .map((workingCsv) => ({
          workingCsvId: workingCsv.workingCsvId,
          fileName: workingCsv.file.name,
        })),
      dependentComparisons: this.describeDependentComparisons(
        workingCsvs.map((workingCsv) => workingCsv.workingCsvId),
      ),
    };
  }

  /** Every Comparison depending on any of these Working CSVs, deduplicated and ordered. */
  private describeDependentComparisons(
    workingCsvIds: WorkingCsvId[],
  ): CloseImpact['dependentComparisons'] {
    const described = new Map<ComparisonId, CloseImpact['dependentComparisons'][number]>();
    for (const workingCsvId of workingCsvIds) {
      for (const comparisonId of this.comparisonStore.dependentComparisonIds(workingCsvId)) {
        if (described.has(comparisonId)) continue;
        const comparison = this.comparisonStore.getState(comparisonId);
        if (!comparison) {
          // A Comparison that closed between the index read and the state read is no longer
          // impacted by this close. Throwing here would reject confirmWindowClose, whose caller
          // has already prevented the window close, leaving the window unclosable.
          console.error(`Comparison ${comparisonId} disappeared while calculating close impact.`);
          continue;
        }
        described.set(comparisonId, {
          comparisonId,
          baselineName: comparison.baseline.file.name,
          candidateName: comparison.candidate.file.name,
        });
      }
    }
    return [...described.values()].sort((left, right) =>
      left.comparisonId.localeCompare(right.comparisonId),
    );
  }

  private async disposeWorkspace(): Promise<void> {
    await this.comparisonStore.dispose();
    await this.csvStore.disposeStore();
  }
}

function requiresConfirmation(impact: CloseImpact): boolean {
  return impact.hasUnexportedChanges || impact.dependentComparisons.length > 0;
}

function requiresWorkspaceConfirmation(impact: WorkspaceCloseImpact): boolean {
  return (
    impact.workingCsvsWithUnexportedChanges.length > 0 || impact.dependentComparisons.length > 0
  );
}

/**
 * Both impacts are deterministically ordered value objects, so comparing their serialized form
 * answers the only question that matters: did the user confirm exactly this impact, or has it
 * changed since we asked? Anything unrecognised compares unequal, which re-prompts.
 */
function sameImpact<T extends CloseImpact | WorkspaceCloseImpact>(
  current: T,
  confirmed: T | undefined,
): boolean {
  return confirmed !== undefined && JSON.stringify(current) === JSON.stringify(confirmed);
}
