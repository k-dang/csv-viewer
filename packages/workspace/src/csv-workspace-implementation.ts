import { OperationCleanup, markCleanupFailed, observeStage, recordOutcome, reportFailure, type WorkspaceDiagnostics } from './workspace-diagnostics';
import { Cause, type Context, Effect, Exit, Option, Schema } from 'effect';
import { rejected } from './comparison/comparison-key-rules';
import { Comparisons, WorkingCsv, makeWorkspaceRuntime } from './workspace-runtime';
import type { ComparisonExecutor } from './comparison/comparison-executor';
import type { WorkspaceDatabase } from './database';
import type { CsvComparisonService } from './comparison/csv-comparison-service';
import type { WorkingCsvStore } from './working-csv/working-csv-store';
import type { CsvWorkspaceHost } from './workspace-host';
import { toError } from './errors';
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
  WorkingCsvView,
  WorkspaceCloseImpact,
  ConfirmWorkspaceCloseOutcome,
} from './csv-viewer';

type ComparisonRequest = Extract<CsvViewerRequest, { operation: `comparison.${string}` }>;

/** The opaque identifiers a request carries. Diagnostics drop anything that is not a UUID. */
const RequestIdentifiers = Schema.Struct({
  workingCsvId: Schema.optional(Schema.String),
  comparisonId: Schema.optional(Schema.String),
  operationId: Schema.optional(Schema.String),
  baselineId: Schema.optional(Schema.String),
  candidateId: Schema.optional(Schema.String),
});
const ProductResult = Schema.Struct({ status: Schema.String });

/**
 * The one shared, runtime-neutral domain seam. Every operation is asynchronous and every request,
 * result, and event is structured-clone-safe, so desktop can reach it over IPC while web wires it
 * up in the page. Everything below it - the Working CSV store, edit history, query construction,
 * comparison orchestration, and database access - is internal implementation.
 */
export class CsvWorkspaceImplementation implements CsvViewer {
  private readonly csvStore: WorkingCsvStore;
  private readonly comparisonStore: CsvComparisonService;
  private readonly workspaceId = crypto.randomUUID();
  private disposal: Promise<void> | null = null;
  private readonly runtime: ReturnType<typeof makeWorkspaceRuntime>;
  private readonly context: Context.Context<never>;

  constructor(
    private readonly host: CsvWorkspaceHost,
    database: WorkspaceDatabase,
    executor?: ComparisonExecutor,
    diagnostics?: WorkspaceDiagnostics,
  ) {
    this.runtime = makeWorkspaceRuntime(host, database, executor, diagnostics);
    this.context = this.runtime.runSync(Effect.context());
    this.csvStore = this.runtime.runSync(WorkingCsv);
    this.comparisonStore = this.runtime.runSync(Comparisons);
  }

  get capabilities() {
    return this.host.capabilities;
  }

  call<Request extends CsvViewerRequest>(request: Request): Promise<CsvViewerResult<Request>>;
  async call(request: CsvViewerRequest): Promise<CsvViewerResult<CsvViewerRequest>> {
    const identifiers = Option.getOrElse(Schema.decodeUnknownOption(RequestIdentifiers)(request), () => ({}));
    return this.runEffect(this.handle(request), request.operation, identifiers);
  }

  private handle(request: CsvViewerRequest): Effect.Effect<CsvViewerResult<CsvViewerRequest>, Error> {
    switch (request.operation) {
      case 'csv.open':
        return this.openCsv(request.options, request.sourceId);
      case 'csv.open-recent':
        return this.openSource(request.sourceId, request.options).pipe(Effect.uninterruptible);
      case 'csv.reopen':
        return this.reopenCsv(request.workingCsvId, request.options);
      case 'csv.get-recent-sources':
        return Effect.tryPromise({ try: () => this.host.recentSources(), catch: toError });
      case 'csv.get-rows':
        return this.csvStore.getRows(request);
      case 'csv.get-column-values':
        return this.csvStore.getColumnValues(request);
      case 'csv.get-column-value-counts':
        return this.csvStore.getColumnValueCounts(request);
      case 'csv.edit-cell':
        return this.csvStore.editCell(request);
      case 'csv.delete-rows':
        return this.csvStore.deleteRows(request);
      case 'csv.insert-row':
        return this.csvStore.insertRow(request);
      case 'csv.rename-column':
        return this.csvStore.renameColumn(request);
      case 'csv.insert-column':
        return this.csvStore.insertColumn(request);
      case 'csv.delete-column':
        return this.csvStore.deleteColumn(request);
      case 'csv.get-edit-state':
        return this.csvStore.getEditState(request);
      case 'csv.undo':
        return this.csvStore.undo(request.workingCsvId);
      case 'csv.redo':
        return this.csvStore.redo(request.workingCsvId);
      case 'csv.export':
        return Effect.suspend(() => this.csvStore.has(request.workingCsvId)
          ? this.csvStore.exportCsv(request.workingCsvId)
          : Effect.succeed({ status: 'cancelled' } satisfies CsvExportOutcome));
      case 'csv.close':
        return this.closeCsv(request);
      default:
        return this.handleComparison(request);
    }
  }

  private handleComparison(request: ComparisonRequest): Effect.Effect<CsvViewerResult<CsvViewerRequest>, Error> {
    const closing = this.disposal && (request.operation === 'comparison.begin' || request.operation === 'comparison.get-window');
    if (closing) return Effect.succeed(rejected('source-not-found', 'The CSV workspace is closing.'));
    switch (request.operation) {
      case 'comparison.get-candidates':
        return Effect.sync(() => this.comparisonStore.candidatesFor(request.baselineId));
      case 'comparison.open':
        return Effect.sync(() => this.comparisonStore.open(request));
      case 'comparison.begin':
        return this.beginComparison(request);
      case 'comparison.cancel':
        return Effect.suspend(() => this.comparisonStore.getState(request.comparisonId)
          ? this.comparisonStore.cancel(request)
          : Effect.succeed({ status: 'comparison-not-found' } as const));
      case 'comparison.get-window':
        return this.comparisonStore.getWindow(request);
      case 'comparison.swap':
        return Effect.sync(() => this.comparisonStore.swap(request.comparisonId));
      case 'comparison.close':
        return Effect.suspend(() => this.comparisonStore.getState(request.comparisonId)
          ? this.comparisonStore.close(request.comparisonId)
          : Effect.succeed({ status: 'closed', comparisonId: request.comparisonId } as const));
      default:
        return unsupportedOperation(request);
    }
  }

  /**
   * The shared entry adapter. Runs one operation under a span named after it, with correlated
   * identifiers, its product outcome, and its cleanup result. Operations run with the workspace
   * services but outside the workspace scope: disposal settles admitted work by its own rules
   * rather than interrupting it. When operation and cleanup both fail, all causes are retained.
   */
  private async runEffect<A, E>(effect: Effect.Effect<A, E>, stage: string, identifiers: typeof RequestIdentifiers.Type = {}): Promise<A> {
    const cleanup = { failed: false };
    const cleanupResult = () => cleanup.failed ? 'cleanup-failed' : 'succeeded';
    const observed = observeStage(stage, effect.pipe(
      Effect.onExit((exit) => Exit.isFailure(exit)
        ? recordOutcome('failed', exit.cause, cleanupResult())
        : Effect.annotateCurrentSpan({
            outcome: Schema.is(ProductResult)(exit.value) ? exit.value.status : 'succeeded',
            cleanup: cleanupResult(),
          })),
      Effect.provideService(OperationCleanup, cleanup),
    )).pipe(Effect.annotateSpans({ workspaceId: this.workspaceId, requestId: crypto.randomUUID(), ...identifiers }));
    const result = await Effect.runPromiseExitWith(this.context)(observed);
    if (Exit.isSuccess(result)) return result.value;
    if (result.cause.reasons.length > 1) {
      throw new AggregateError(Cause.prettyErrors(result.cause), 'Unable to complete all workspace operations.', {
        cause: result.cause,
      });
    }
    throw Cause.squash(result.cause);
  }

  onEvent(listener: (event: CsvViewerEvent) => void): () => void {
    return this.comparisonStore.subscribe((event) => listener({ type: 'comparison', event }));
  }

  private openCsv(options?: CsvDialectOptions, reservedSourceId?: CsvSourceId): Effect.Effect<OpenCsvResult> {
    return Effect.gen({ self: this }, function* () {
      if (this.disposal) {
        if (reservedSourceId !== undefined) this.host.releaseSource(reservedSourceId);
        return { status: 'failed', message: 'The CSV workspace is closing.' } satisfies OpenCsvResult;
      }
      // Source selection may outlive the workspace; admission protects only the open that follows it.
      const sourceId = reservedSourceId ?? (yield* observeStage('csv.select-source', Effect.promise(() => this.host.acquireSource())));
      if (!sourceId) return { status: 'cancelled' } satisfies OpenCsvResult;
      if (sourceId instanceof Object) return sourceId;
      let retained = false;
      try {
        const result = yield* this.openSource(sourceId, options);
        retained = result.status === 'opened' || result.status === 'already-open';
        return result;
      } finally {
        if (!retained) this.host.releaseSource(sourceId);
      }
    }).pipe(Effect.uninterruptible);
  }

  /** The admission covers the Recent CSV Source write, so disposal waits for accepted opens. */
  private openSource(sourceId: CsvSourceId, options?: CsvDialectOptions): Effect.Effect<OpenCsvResult> {
    return Effect.gen({ self: this }, function* () {
      if (!(yield* this.csvStore.admit())) return { status: 'failed', message: 'The CSV workspace is closing.' } satisfies OpenCsvResult;
      const outcome = yield* this.csvStore.open(sourceId, options);
      if (outcome.status === 'failed') return { status: 'failed', message: outcome.failure.message } satisfies OpenCsvResult;
      if (outcome.status === 'existing') return { status: 'already-open', workingCsv: outcome.workingCsv } satisfies OpenCsvResult;
      yield* this.recordRecentSource(sourceId);
      return { status: 'opened', workingCsv: outcome.workingCsv } satisfies OpenCsvResult;
    }).pipe(Effect.scoped);
  }

  private recordRecentSource(sourceId: CsvSourceId) {
    return observeStage('csv.record-recent', Effect.tryPromise(() => this.host.recordRecentSource(sourceId)).pipe(
      Effect.catchCause((cause) => recordOutcome('cleanup-failed', cause, 'cleanup-failed').pipe(Effect.andThen(markCleanupFailed))),
    ));
  }

  private reopenCsv(workingCsvId: WorkingCsvId, options?: CsvDialectOptions): Effect.Effect<OpenCsvResult> {
    return Effect.gen({ self: this }, function* () {
      if (this.disposal) return { status: 'failed', message: 'The CSV workspace is closing.' } satisfies OpenCsvResult;
      const initial = this.csvStore.getState(workingCsvId);
      if (!initial) return { status: 'failed', message: 'The Working CSV is no longer open.' } satisfies OpenCsvResult;
      if (this.csvStore.isClosing(workingCsvId)) return { status: 'failed', message: 'This CSV is closing.' } satisfies OpenCsvResult;
      // A discard prompt may outlive disposal, so only the replacement runs under reopen admission.
      let existing: WorkingCsvView = initial;
      while (true) {
        while (existing.editState.hasUnexportedChanges) {
          const canContinue = yield* observeStage('csv.confirm-discard', Effect.promise(() => this.host.confirmDiscardChanges(existing.source.name)));
          if (!canContinue) return { status: 'cancelled' } satisfies OpenCsvResult;
          if (this.disposal) return { status: 'failed', message: 'The CSV workspace is closing.' } satisfies OpenCsvResult;
          const current = this.csvStore.getState(workingCsvId);
          if (!current) return { status: 'failed', message: 'The Working CSV is no longer open.' } satisfies OpenCsvResult;
          if (current.dataRevision === existing.dataRevision) {
            existing = current;
            break;
          }
          existing = current;
        }
        const outcome = yield* this.csvStore.replace(workingCsvId, existing.dataRevision, options);
        if (outcome.status === 'revision-changed') {
          existing = outcome.workingCsv;
          continue;
        }
        if (outcome.status === 'failed') return { status: 'failed', message: outcome.failure.message } satisfies OpenCsvResult;
        yield* this.recordRecentSource(outcome.workingCsv.source.sourceId);
        return { status: 'opened', workingCsv: outcome.workingCsv } satisfies OpenCsvResult;
      }
    }).pipe(Effect.uninterruptible);
  }

  /**
   * Starts a Comparison operation and returns immediately. Terminal outcomes arrive through
   * Comparison events, so nothing live crosses the seam.
   */
  private beginComparison(request: BeginComparisonRequest): Effect.Effect<BeginComparisonResult> {
    return this.comparisonStore.begin(request).pipe(
      Effect.map((result): BeginComparisonResult => result.status === 'accepted'
        ? { status: 'accepted', operationId: result.operationId }
        : result),
      Effect.tap((result) => result.status === 'accepted' ? Effect.annotateCurrentSpan('operationId', result.operationId) : Effect.void),
    );
  }

  private closeCsv(request: CloseWorkingCsvRequest): Effect.Effect<CloseWorkingCsvOutcome> {
    const { workingCsvId, confirmedImpact } = request;
    return Effect.gen({ self: this }, function* () {
      if (!this.csvStore.has(workingCsvId)) {
        return { status: 'closed', closedWorkingCsvId: workingCsvId, closedComparisonIds: [] } satisfies CloseWorkingCsvOutcome;
      }
      if (!this.csvStore.beginClose(workingCsvId)) {
        return {
          status: 'failed',
          failure: { code: 'cleanup-failed', message: 'The Working CSV is already closing.', retryable: true },
        } satisfies CloseWorkingCsvOutcome;
      }
      return yield* Effect.gen({ self: this }, function* () {
        yield* this.csvStore.waitForActiveWork(workingCsvId);
        const impact = yield* this.closeImpact(workingCsvId);
        if (requiresConfirmation(impact) && !sameImpact(impact, confirmedImpact)) {
          return { status: 'confirmation-required', impact } satisfies CloseWorkingCsvOutcome;
        }
        const closedComparisonIds = impact.dependentComparisons.map((comparison) => comparison.comparisonId);
        yield* observeStage('comparison.close', this.comparisonStore.closeDependents(workingCsvId));
        yield* this.csvStore.closeWorkingCsv(workingCsvId);
        return { status: 'closed', closedWorkingCsvId: workingCsvId, closedComparisonIds } satisfies CloseWorkingCsvOutcome;
      }).pipe(
        Effect.catchCause((cause) => recordOutcome('failed', cause).pipe(Effect.andThen(markCleanupFailed), Effect.as({
          status: 'failed',
          failure: {
            code: 'cleanup-failed',
            message: 'Unable to close the Working CSV and all dependent Comparisons.',
            retryable: true,
          },
        } satisfies CloseWorkingCsvOutcome))),
        Effect.ensuring(Effect.sync(() => {
          if (this.csvStore.has(workingCsvId)) this.csvStore.endClose(workingCsvId);
        })),
      );
    });
  }

  confirmClose(confirmedImpact?: WorkspaceCloseImpact): Promise<ConfirmWorkspaceCloseOutcome> {
    return this.runEffect(Effect.gen({ self: this }, function* () {
      const impact = yield* this.windowCloseImpact();
      if (requiresWorkspaceConfirmation(impact) && !sameImpact(impact, confirmedImpact)) {
        return { status: 'confirmation-required', impact } satisfies ConfirmWorkspaceCloseOutcome;
      }
      return { status: 'ready' } satisfies ConfirmWorkspaceCloseOutcome;
    }), 'workspace.confirm-close');
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

  private closeImpact(workingCsvId: WorkingCsvId): Effect.Effect<CloseImpact, Error> {
    return Effect.gen({ self: this }, function* () {
      if (!this.csvStore.has(workingCsvId)) {
        return yield* Effect.fail(new Error('Working CSV is no longer active.'));
      }
      return {
        hasUnexportedChanges: this.csvStore.hasUnexportedChanges(workingCsvId),
        dependentComparisons: yield* this.describeDependentComparisons([workingCsvId]),
      };
    });
  }

  private windowCloseImpact(): Effect.Effect<WorkspaceCloseImpact> {
    return Effect.gen({ self: this }, function* () {
      const workingCsvs = this.csvStore.list().sort((left, right) => left.workingCsvId.localeCompare(right.workingCsvId));
      return {
        workingCsvsWithUnexportedChanges: workingCsvs
          .filter((workingCsv) => workingCsv.editState.hasUnexportedChanges)
          .map((workingCsv) => ({
            workingCsvId: workingCsv.workingCsvId,
            sourceName: workingCsv.source.name,
          })),
        dependentComparisons: yield* this.describeDependentComparisons(workingCsvs.map((workingCsv) => workingCsv.workingCsvId)),
      };
    });
  }

  /** Every Comparison depending on any of these Working CSVs, deduplicated and ordered. */
  private describeDependentComparisons(workingCsvIds: WorkingCsvId[]): Effect.Effect<CloseImpact['dependentComparisons']> {
    return Effect.gen({ self: this }, function* () {
      const described = new Map<ComparisonId, CloseImpact['dependentComparisons'][number]>();
      for (const workingCsvId of workingCsvIds) {
        for (const comparisonId of this.comparisonStore.dependentComparisonIds(workingCsvId)) {
          if (described.has(comparisonId)) continue;
          const comparison = this.comparisonStore.getState(comparisonId);
          if (!comparison) {
            // A Comparison that closed between the index read and the state read is no longer
            // impacted by this close. Failing here would reject confirmClose, whose caller
            // has already prevented the window close, leaving the window unclosable.
            yield* reportFailure('comparison.close-impact', Cause.fail('comparison-not-found')).pipe(Effect.annotateSpans({ comparisonId }));
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
    });
  }

  private async disposeWorkspace(): Promise<void> {
    await this.runEffect(Effect.gen({ self: this }, function* () {
      yield* observeStage('comparison.dispose', this.comparisonStore.dispose());
      yield* observeStage('workspace.release-csvs', this.csvStore.disposeStore());
    }), 'workspace.dispose');
    await this.runtime.dispose();
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

function unsupportedOperation(request: never): never {
  const operation = Object.getOwnPropertyDescriptor(request, 'operation')?.value;
  throw new Error(`Unsupported CSV Viewer operation: ${String(operation)}`);
}
