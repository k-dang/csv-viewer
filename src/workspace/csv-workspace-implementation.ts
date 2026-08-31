import type { ComparisonExecutor } from './comparison-executor';
import type { WorkspaceDatabase } from './database';
import { CsvComparisonService } from './csv-comparison-service';
import { WorkingCsvStore } from './working-csv-store';
import type { CsvWorkspaceHost } from './workspace-host';
import type {
  BeginComparisonResult,
  BeginComparisonRequest,
  CloseImpact,
  CloseWorkingCsvOutcome,
  CloseWorkingCsvRequest,
  ComparisonId,
  CsvDialectOptions,
  CsvExportOutcome,
  CsvSourceId,
  CsvViewerRequest,
  CsvViewerEvent,
  CsvViewerResult,
  CsvViewer,
  OpenCsvResult,
  WorkingCsvId,
  WorkspaceCloseImpact,
  ConfirmWorkspaceCloseOutcome,
} from '../shared/csv-viewer-contract';

type ComparisonRequest = Extract<CsvViewerRequest, { operation: `comparison.${string}` }>;

/**
 * The one shared, runtime-neutral domain seam. Every operation is asynchronous and every request,
 * result, and event is structured-clone-safe, so desktop can reach it over IPC while web wires it
 * up in the page. Everything below it - the Working CSV store, edit history, query construction,
 * comparison orchestration, and database access - is internal implementation.
 */
export class CsvWorkspaceImplementation implements CsvViewer {
  private readonly csvStore: WorkingCsvStore;
  private readonly comparisonStore: CsvComparisonService;
  private disposal: Promise<void> | null = null;

  constructor(
    private readonly host: CsvWorkspaceHost,
    database: WorkspaceDatabase,
    executor?: ComparisonExecutor,
  ) {
    this.csvStore = new WorkingCsvStore(host, database);
    this.comparisonStore = new CsvComparisonService(
      this.csvStore,
      executor ?? this.csvStore.createComparisonExecutor(),
    );
  }

  get capabilities() {
    return this.host.capabilities;
  }

  call<Request extends CsvViewerRequest>(request: Request): Promise<CsvViewerResult<Request>>;
  async call(request: CsvViewerRequest): Promise<CsvViewerResult<CsvViewerRequest>> {
    switch (request.operation) {
      case 'csv.open':
        return this.openCsv(request.options);
      case 'csv.open-recent':
        return this.openRecentCsv(request.sourceId, request.options);
      case 'csv.reopen':
        return this.reopenCsv(request.workingCsvId, request.options);
      case 'csv.get-recent-sources':
        return this.host.recentSources();
      case 'csv.get-rows':
        return this.csvStore.getRows(request);
      case 'csv.get-column-value-counts':
        return this.csvStore.getColumnValueCounts(request);
      case 'csv.edit-cell':
        return this.csvStore.editCell(request);
      case 'csv.delete-rows':
        return this.csvStore.deleteRows(request);
      case 'csv.insert-row':
        return this.csvStore.insertRow(request);
      case 'csv.get-edit-state':
        return this.csvStore.getEditState(request);
      case 'csv.undo':
        return this.csvStore.undo(request.workingCsvId);
      case 'csv.redo':
        return this.csvStore.redo(request.workingCsvId);
      case 'csv.export':
        return this.exportCsv(request.workingCsvId);
      case 'csv.close':
        return this.closeCsv(request);
      default:
        return this.callComparison(request);
    }
  }

  private callComparison(request: ComparisonRequest): Promise<CsvViewerResult<CsvViewerRequest>> {
    switch (request.operation) {
      case 'comparison.get-candidates':
        return Promise.resolve(this.comparisonStore.candidatesFor(request.baselineId));
      case 'comparison.open':
        return Promise.resolve(this.comparisonStore.open(request));
      case 'comparison.begin':
        return this.beginComparison(request);
      case 'comparison.cancel':
        return Promise.resolve(this.comparisonStore.cancel(request));
      case 'comparison.get-window':
        return this.comparisonStore.getWindow(request);
      case 'comparison.swap':
        return Promise.resolve(this.comparisonStore.swap(request.comparisonId));
      case 'comparison.close':
        return this.comparisonStore.close(request.comparisonId);
      default:
        return unsupportedOperation(request);
    }
  }

  onEvent(listener: (event: CsvViewerEvent) => void): () => void {
    return this.comparisonStore.subscribe((event) => listener({ type: 'comparison', event }));
  }

  private async openCsv(options?: CsvDialectOptions): Promise<OpenCsvResult> {
    const sourceId = await this.host.acquireSource();
    if (!sourceId) return { status: 'cancelled' };
    return this.openRecentCsv(sourceId, options);
  }

  private async openRecentCsv(sourceId: CsvSourceId, options?: CsvDialectOptions): Promise<OpenCsvResult> {
    const outcome = await this.csvStore.open(sourceId, options);
    if (outcome.status === 'failed') return { status: 'failed', message: outcome.failure.message };
    if (outcome.status === 'existing') {
      return { status: 'already-open', workingCsv: outcome.workingCsv };
    }
    await this.host.recordRecentSource(sourceId);
    return { status: 'opened', workingCsv: outcome.workingCsv };
  }

  private async reopenCsv(workingCsvId: WorkingCsvId, options?: CsvDialectOptions): Promise<OpenCsvResult> {
    let existing = this.csvStore.getState(workingCsvId);
    if (!existing)
      return {
        status: 'failed',
        message: 'The Working CSV is no longer open.',
      };

    while (true) {
      while (existing.editState.hasUnexportedChanges) {
        const canContinue = await this.host.confirmDiscardChanges(existing.source.name);
        if (!canContinue) return { status: 'cancelled' };
        const current = this.csvStore.getState(workingCsvId);
        if (!current)
          return {
            status: 'failed',
            message: 'The Working CSV is no longer open.',
          };
        if (current.dataRevision === existing.dataRevision) break;
        existing = current;
      }

      const outcome = await this.csvStore.replace(workingCsvId, existing.dataRevision, options);
      if (outcome.status === 'revision-changed') {
        existing = outcome.workingCsv;
        continue;
      }
      if (outcome.status === 'replaced') {
        await this.host.recordRecentSource(outcome.workingCsv.source.sourceId);
        return { status: 'opened', workingCsv: outcome.workingCsv };
      }
      if (outcome.status === 'working-csv-not-found') {
        return {
          status: 'failed',
          message: 'The Working CSV is no longer open.',
        };
      }
      return { status: 'failed', message: outcome.failure.message };
    }
  }

  private async exportCsv(workingCsvId: WorkingCsvId): Promise<CsvExportOutcome> {
    if (!this.csvStore.has(workingCsvId)) return { status: 'cancelled' };
    return this.csvStore.exportCsv(workingCsvId);
  }

  /**
   * Starts a Comparison operation and returns immediately. Terminal outcomes arrive through
   * Comparison events, so nothing live crosses the seam.
   */
  private async beginComparison(request: BeginComparisonRequest): Promise<BeginComparisonResult> {
    const result = this.comparisonStore.begin(request);
    if (result.status !== 'accepted') return result;
    void result.completion.catch((error) => {
      console.error(`Comparison operation ${result.operationId} failed unexpectedly.`, error);
    });
    return { status: 'accepted', operationId: result.operationId };
  }

  private async closeCsv(request: CloseWorkingCsvRequest): Promise<CloseWorkingCsvOutcome> {
    const { workingCsvId, confirmedImpact } = request;
    if (!this.csvStore.has(workingCsvId)) {
      return {
        status: 'closed',
        closedWorkingCsvId: workingCsvId,
        closedComparisonIds: [],
      };
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
      const closedComparisonIds = impact.dependentComparisons.map((comparison) => comparison.comparisonId);
      await this.comparisonStore.closeDependents(workingCsvId);
      await this.csvStore.closeWorkingCsv(workingCsvId);
      return {
        status: 'closed',
        closedWorkingCsvId: workingCsvId,
        closedComparisonIds,
      };
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

  async confirmClose(confirmedImpact?: WorkspaceCloseImpact): Promise<ConfirmWorkspaceCloseOutcome> {
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
    const workingCsvs = this.csvStore.list().sort((left, right) => left.workingCsvId.localeCompare(right.workingCsvId));
    return {
      workingCsvsWithUnexportedChanges: workingCsvs
        .filter((workingCsv) => workingCsv.editState.hasUnexportedChanges)
        .map((workingCsv) => ({
          workingCsvId: workingCsv.workingCsvId,
          sourceName: workingCsv.source.name,
        })),
      dependentComparisons: this.describeDependentComparisons(workingCsvs.map((workingCsv) => workingCsv.workingCsvId)),
    };
  }

  /** Every Comparison depending on any of these Working CSVs, deduplicated and ordered. */
  private describeDependentComparisons(workingCsvIds: WorkingCsvId[]): CloseImpact['dependentComparisons'] {
    const described = new Map<ComparisonId, CloseImpact['dependentComparisons'][number]>();
    for (const workingCsvId of workingCsvIds) {
      for (const comparisonId of this.comparisonStore.dependentComparisonIds(workingCsvId)) {
        if (described.has(comparisonId)) continue;
        const comparison = this.comparisonStore.getState(comparisonId);
        if (!comparison) {
          // A Comparison that closed between the index read and the state read is no longer
          // impacted by this close. Throwing here would reject confirmClose, whose caller
          // has already prevented the window close, leaving the window unclosable.
          console.error(`Comparison ${comparisonId} disappeared while calculating close impact.`);
          continue;
        }
        described.set(comparisonId, {
          comparisonId,
          baselineName: comparison.baseline.source.name,
          candidateName: comparison.candidate.source.name,
        });
      }
    }
    return [...described.values()].sort((left, right) => left.comparisonId.localeCompare(right.comparisonId));
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
  return impact.workingCsvsWithUnexportedChanges.length > 0 || impact.dependentComparisons.length > 0;
}

/**
 * Both impacts are deterministically ordered value objects, so comparing their serialized form
 * answers the only question that matters: did the user confirm exactly this impact, or has it
 * changed since we asked? Anything unrecognised compares unequal, which re-prompts.
 */
function sameImpact<T extends CloseImpact | WorkspaceCloseImpact>(current: T, confirmed: T | undefined): boolean {
  return confirmed !== undefined && JSON.stringify(current) === JSON.stringify(confirmed);
}

function unsupportedOperation(_request: never): never {
  const operation = Object.getOwnPropertyDescriptor(Object(_request), 'operation')?.value;
  throw new Error(`Unsupported CSV Viewer operation: ${String(operation)}`);
}
