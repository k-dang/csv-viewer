import { OperationCleanup, markCleanupFailed, observeCleanup, observeStage, recordOutcome, reportFailure } from './workspace-diagnostics';
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Schema, Scope, Stream } from 'effect';
import type { Rpc, RpcGroup } from 'effect/rpc';
import { rejected } from './comparison/comparison-key-rules';
import { makeWorkspaceLayer } from './workspace-runtime';
import { DatabaseReleaseError, stoppedEngineMessage, type DataEngineError, type OpenWorkspaceDatabase } from './database';
import { Comparisons } from './comparison/csv-comparison-service';
import { WorkingCsvs } from './working-csv/working-csv-store';
import { CsvWorkspaceHost, type CsvSourceUnavailableError } from './workspace-host';
import type { CreateCsvViewerOptions, CsvWorkspaceServer } from './csv-workspace';
import { CsvViewerRpcs } from './csv-viewer-rpcs';
import { genericWorkspaceFailure, type CsvOpenError, isExpectedWorkspaceError, malformedRequestMessage, WorkspaceRequestError } from './errors';
import { CloseImpact, type BeginComparisonRequest, type CloseWorkingCsvRequest } from './csv-viewer-requests';
import type {
  BeginComparisonResult,
  CloseWorkingCsvOutcome,
  ComparisonId,
  CsvDialectOptions,
  CsvExportOutcome,
  CsvSourceId,
  CsvViewerEvent,
  CsvViewerIntent,
  OpenCsvResult,
  WorkingCsvId,
  WorkingCsvView,
  WorkspaceCloseImpact,
  ConfirmWorkspaceCloseOutcome,
} from './csv-viewer';

type WorkspaceServices = Layer.Success<ReturnType<typeof makeWorkspaceLayer>>;
type HandlerContext = Context.Context<Rpc.ToHandler<RpcGroup.Rpcs<typeof CsvViewerRpcs>>>;
type DroppedPath = (
  filePath: string,
) => Effect.Effect<CsvSourceId, WorkspaceRequestError | CsvSourceUnavailableError>;

/** Disposal closes the build scope. Forked fibers live in a child of that scope, so closing it interrupts them. */
interface WorkspaceRuntime {
  readonly disposeEffect: Effect.Effect<void>;
  runFork<A, E>(effect: Effect.Effect<A, E, WorkspaceServices>): Fiber.Fiber<A, E>;
}

/** The opaque identifiers a request carries. Diagnostics drop anything that is not a UUID. */
const RequestIdentifiers = Schema.Struct({
  workingCsvId: Schema.optional(Schema.String),
  comparisonId: Schema.optional(Schema.String),
  operationId: Schema.optional(Schema.String),
  baselineId: Schema.optional(Schema.String),
  candidateId: Schema.optional(Schema.String),
});
const ProductResult = Schema.Struct({ status: Schema.String });
const decodeIdentifiers = Schema.decodeUnknownOption(RequestIdentifiers);
const sameCloseImpact = Schema.toEquivalence(CloseImpact);
const engineStoppedEvent: Extract<CsvViewerEvent, { type: 'fatal-error' }> = {
  type: 'fatal-error',
  message: 'The local data engine stopped unexpectedly.',
};

/**
 * The services behind CsvViewerRpcs. Handlers run with those services and not as runtime fibers:
 * disposing the runtime would interrupt them, while disposal settles admitted work by its own rules.
 */
export class CsvWorkspaceImplementation implements CsvWorkspaceServer {
  private disposal: Promise<void> | null = null;
  private readonly host: CsvWorkspaceHost;
  private readonly workingCsvs: WorkingCsvs;
  private readonly comparisons: Comparisons;
  private readonly listeners = new Set<(event: CsvViewerEvent) => void>();
  private readonly acquireDroppedPath: DroppedPath;
  handlerContext!: HandlerContext;

  private constructor(
    private readonly workspaceId: string,
    private readonly runtime: WorkspaceRuntime,
    private readonly context: Context.Context<WorkspaceServices>,
    private readonly stopped: Deferred.Deferred<void> | undefined,
    acquireDroppedPath: DroppedPath | undefined,
  ) {
    this.host = Context.get(context, CsvWorkspaceHost);
    this.workingCsvs = Context.get(context, WorkingCsvs);
    this.comparisons = Context.get(context, Comparisons);
    this.acquireDroppedPath = acquireDroppedPath ?? (() => Effect.fail(new WorkspaceRequestError({
      message: 'Drop a file from your device.',
    })));
  }

  /**
   * Builds the workspace runtime. A failed build disposes it, which releases whatever the database
   * acquisition registered, and rejects with the build failure.
   */
  static async create(
    openDatabase: OpenWorkspaceDatabase,
    host: CsvWorkspaceHost,
    { executor, diagnostics, startup, acquireDroppedPath }: CreateCsvViewerOptions,
  ): Promise<CsvWorkspaceImplementation> {
    const workspaceId = crypto.randomUUID();
    const layer = makeWorkspaceLayer(openDatabase, host, executor, diagnostics, startup?.stopped);
    // Acquisition runs on this fiber so startup cancellation interrupts it. A forked build would
    // only be awaited, and a driver failure would hide that interrupt in the diagnostics.
    const scope = Scope.makeUnsafe('sequential');
    const building = Layer.buildWithScope(layer, scope).pipe(Effect.annotateSpans({ workspaceId }));
    const build = startup
      ? Effect.raceFirst(building, Deferred.await(startup.stopped).pipe(Effect.andThen(Effect.fail(workspaceStoppedError()))))
      : building;
    const built = await Effect.runPromiseExit(build, { signal: startup?.signal });
    const disposeEffect = Scope.close(scope, Exit.void);
    // The release stage reports a failed release; startup rejects with why the build failed.
    const disposeFailedStartup = () => Effect.runPromise(Effect.exit(disposeEffect));
    if (Exit.isFailure(built)) {
      await disposeFailedStartup();
      throw Cause.squash(built.cause);
    }
    if (startup && Deferred.isDoneUnsafe(startup.stopped)) {
      await disposeFailedStartup();
      throw workspaceStoppedError();
    }
    const context = built.value;
    const fiberScope = Scope.forkUnsafe(scope, 'parallel');
    const runtime: WorkspaceRuntime = {
      disposeEffect,
      runFork: (effect) => Effect.runFork(effect.pipe(Effect.provideContext(context)), {
        onFiberStart: Fiber.runIn(fiberScope),
      }),
    };
    const workspace = new CsvWorkspaceImplementation(workspaceId, runtime, context, startup?.stopped, acquireDroppedPath);
    if (startup) {
      // Disposal interrupts the watcher, so a started notification finishes first.
      runtime.runFork(Deferred.await(startup.stopped).pipe(
        Effect.andThen(observeStage('workspace.engine-stopped', workspace.emitEngineStopped().pipe(
          Effect.andThen(recordOutcome('failed')),
        )).pipe(Effect.uninterruptible)),
        Effect.annotateSpans({ workspaceId }),
      ));
    }
    await workspace.attachHandlers();
    return workspace;
  }

  get capabilities() {
    return this.host.capabilities;
  }

  private async attachHandlers(): Promise<void> {
    // SAFETY: Each handler closes over this workspace. Building the table requires no service context.
    this.handlerContext = await Effect.runPromise(CsvViewerRpcs.toHandlers(this.rpcHandlers()) as Effect.Effect<HandlerContext>);
  }

  private rpcHandlers(): RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof CsvViewerRpcs>> {
    return {
      'csv.open': (payload) => this.request(this.openCsv(payload), 'csv.open', payload),
      'csv.open-recent': (payload) => this.request(
        this.openSource(payload.sourceId, payload.options).pipe(Effect.uninterruptible),
        'csv.open-recent',
        payload,
      ),
      'csv.reopen': (payload) => this.request(this.reopenCsv(payload.workingCsvId, payload.options), 'csv.reopen', payload),
      'csv.get-recent-sources': () => this.request(Effect.suspend(() => this.host.recentSources()), 'csv.get-recent-sources', {}),
      'csv.get-rows': (payload) => this.request(this.workingCsvs.getRows(payload), 'csv.get-rows', payload),
      'csv.get-column-values': (payload) => this.request(this.workingCsvs.getColumnValues(payload), 'csv.get-column-values', payload),
      'csv.get-column-value-counts': (payload) => this.request(this.workingCsvs.getColumnValueCounts(payload), 'csv.get-column-value-counts', payload),
      'csv.edit-cell': (payload) => this.request(this.workingCsvs.editCell(payload), 'csv.edit-cell', payload),
      'csv.delete-rows': (payload) => this.request(this.workingCsvs.deleteRows(payload), 'csv.delete-rows', payload),
      'csv.insert-row': (payload) => this.request(this.workingCsvs.insertRow(payload), 'csv.insert-row', payload),
      'csv.rename-column': (payload) => this.request(this.workingCsvs.renameColumn(payload), 'csv.rename-column', payload),
      'csv.insert-column': (payload) => this.request(this.workingCsvs.insertColumn(payload), 'csv.insert-column', payload),
      'csv.delete-column': (payload) => this.request(this.workingCsvs.deleteColumn(payload), 'csv.delete-column', payload),
      'csv.reorder-columns': (payload) => this.request(this.workingCsvs.reorderColumns(payload), 'csv.reorder-columns', payload),
      'csv.get-edit-state': (payload) => this.request(this.workingCsvs.getEditState(payload), 'csv.get-edit-state', payload),
      'csv.undo': (payload) => this.request(this.workingCsvs.undo(payload.workingCsvId), 'csv.undo', payload),
      'csv.redo': (payload) => this.request(this.workingCsvs.redo(payload.workingCsvId), 'csv.redo', payload),
      'csv.export': (payload) => this.request(Effect.suspend(() => this.workingCsvs.has(payload.workingCsvId)
        ? this.workingCsvs.exportCsv(payload.workingCsvId)
        : Effect.succeed({ status: 'cancelled' } satisfies CsvExportOutcome)), 'csv.export', payload),
      'csv.export-view': (payload) => this.request(this.workingCsvs.exportView(payload), 'csv.export-view', payload),
      'csv.close': (payload) => this.request(this.closeCsv(payload), 'csv.close', payload),
      'comparison.get-candidates': (payload) => this.request(
        Effect.sync(() => this.comparisons.candidatesFor(payload.baselineId)),
        'comparison.get-candidates',
        payload,
      ),
      'comparison.open': (payload) => this.request(Effect.sync(() => this.comparisons.open(payload)), 'comparison.open', payload),
      'comparison.begin': (payload) => this.request(Effect.suspend(() => this.disposal
        ? Effect.succeed(rejected('source-not-found', 'The CSV workspace is closing.'))
        : this.beginComparison(payload)), 'comparison.begin', payload),
      'comparison.cancel': (payload) => this.request(Effect.suspend(() => this.comparisons.getState(payload.comparisonId)
        ? this.comparisons.cancel(payload)
        : Effect.succeed({ status: 'comparison-not-found' } as const)), 'comparison.cancel', payload),
      'comparison.get-window': (payload) => this.request(Effect.suspend(() => this.disposal
        ? Effect.succeed(rejected('source-not-found', 'The CSV workspace is closing.'))
        : this.comparisons.getWindow(payload)), 'comparison.get-window', payload),
      'comparison.swap': (payload) => this.request(
        Effect.sync(() => this.comparisons.swap(payload.comparisonId)),
        'comparison.swap',
        payload,
      ),
      'comparison.close': (payload) => this.request(Effect.suspend(() => this.comparisons.getState(payload.comparisonId)
        ? this.comparisons.close(payload.comparisonId)
        : Effect.succeed({ status: 'closed', comparisonId: payload.comparisonId } as const)), 'comparison.close', payload),
      'csvViewer.malformed': () => this.request(
        Effect.fail(new WorkspaceRequestError({ message: malformedRequestMessage })),
        'csv-viewer.request',
        {},
        'malformed-request',
      ),
      'csv.acquire-dropped-source': (payload) => this.request(this.acquireDroppedPath(payload.path), 'csv.acquire-dropped-source', payload),
      'workspace.events': () => this.events(),
    };
  }

  /**
   * Runs one operation under a span named after it. A stopped engine rejects before any span.
   * Requests that arrive after disposal still get a product answer from the handler.
   */
  private request<A, E>(
    effect: Effect.Effect<A, E>,
    stage: string,
    // oxlint-disable-next-line anti-slop/no-object-parameters -- schema payloads vary; identifiers are the UUID fields they carry
    payload: object,
    failureOutcome: 'failed' | 'malformed-request' = 'failed',
  ): Effect.Effect<A, E | WorkspaceRequestError> {
    if (this.engineStopped) return Effect.fail(new WorkspaceRequestError({ message: stoppedEngineMessage }));
    const identifiers = Option.getOrElse(decodeIdentifiers(payload), () => ({}));
    return this.observe(effect, stage, identifiers, failureOutcome);
  }

  private observe<A, E>(
    effect: Effect.Effect<A, E>,
    stage: string,
    identifiers: typeof RequestIdentifiers.Type,
    failureOutcome: 'failed' | 'malformed-request' = 'failed',
  ): Effect.Effect<A, E> {
    const cleanup = { failed: false };
    const cleanupResult = () => cleanup.failed ? 'cleanup-failed' : 'succeeded';
    return observeStage(stage, effect.pipe(
      Effect.onExit((exit) => Exit.isFailure(exit)
        ? recordOutcome(failureOutcome, exit.cause, cleanupResult())
        : Effect.annotateCurrentSpan({
            outcome: Schema.is(ProductResult)(exit.value) ? exit.value.status : 'succeeded',
            cleanup: cleanupResult(),
          })),
      Effect.provideService(OperationCleanup, cleanup),
    )).pipe(
      Effect.annotateSpans({ workspaceId: this.workspaceId, requestId: crypto.randomUUID(), ...identifiers }),
      Effect.provideContext(this.context),
    );
  }

  /** Owner methods keep declared failures. A defect becomes the generic message. */
  private runOwner<A, E>(effect: Effect.Effect<A, E>, stage: string): Promise<A> {
    return Effect.runPromise(Effect.exit(this.observe(effect, stage, {}))).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      const [reason] = exit.cause.reasons;
      if (exit.cause.reasons.length === 1 && reason && reason._tag === 'Fail' && isExpectedWorkspaceError(reason.error)) {
        throw reason.error;
      }
      throw new Error(genericWorkspaceFailure);
    });
  }

  publishIntent(intent: CsvViewerIntent): void {
    const event: CsvViewerEvent = { type: 'intent', intent };
    for (const listener of this.listeners) {
      Effect.runFork(Effect.sync(() => listener(event)).pipe(
        Effect.catchCause((cause) => reportFailure('workspace.notify-intent', cause)),
      ));
    }
  }

  /**
   * The queue exists before the take loop, so the listener is registered before the stream waits.
   * A stopped engine replays into that buffer. Later offers wake the loop on the caller's stack.
   */
  private readonly events = Effect.fnUntraced(function* (this: CsvWorkspaceImplementation) {
    const queue = yield* Queue.unbounded<CsvViewerEvent>();
    yield* Effect.acquireRelease(
      Effect.sync(() => this.onEvent((event) => {
        Queue.offerUnsafe(queue, event);
      })),
      (stop) => Effect.sync(stop),
    );
    return queue;
  });

  /** The stop watcher emits `fatal-error` to current listeners; a later listener gets it replayed once. */
  onEvent(listener: (event: CsvViewerEvent) => void): () => void {
    if (this.engineStopped) {
      listener(engineStoppedEvent);
      return () => undefined;
    }
    this.listeners.add(listener);
    // Not a child of the workspace scope: that scope closes by disposing comparisons, and this
    // fiber has to observe the events disposal publishes before the hub shuts down.
    const stopComparisons = Effect.runFork(Stream.runForEach(this.comparisons.events, (event) => Effect.sync(() => {
      if (!this.engineStopped) listener({ type: 'comparison', event });
    })));
    return () => {
      stopComparisons.interruptUnsafe();
      this.listeners.delete(listener);
    };
  }

  /** Notifies current subscribers; onEvent replays the same event to later subscribers. */
  private emitEngineStopped(): Effect.Effect<void> {
    return Effect.suspend(() => Effect.forEach([...this.listeners], (listener) => Effect.sync(() => listener(engineStoppedEvent)).pipe(
      Effect.catchCause((cause) => reportFailure('workspace.notify-engine-stop', cause)),
    ), { discard: true }));
  }

  private get engineStopped(): boolean {
    return this.stopped !== undefined && Deferred.isDoneUnsafe(this.stopped);
  }

  private readonly openCsv = Effect.fnUntraced(function* (
    this: CsvWorkspaceImplementation,
    { options, sourceId: reservedSourceId }: { readonly sourceId?: CsvSourceId; readonly options?: CsvDialectOptions },
  ): Effect.fn.Return<OpenCsvResult, CsvSourceUnavailableError | WorkspaceRequestError | CsvOpenError> {
    if (this.disposal) {
      if (reservedSourceId !== undefined) this.host.releaseSource(reservedSourceId);
      return { status: 'failed', message: 'The CSV workspace is closing.' } satisfies OpenCsvResult;
    }
    // Source selection may outlive the workspace; admission protects only the open that follows it.
    const sourceId = reservedSourceId ?? (yield* observeStage('csv.select-source', this.host.acquireSource()));
    if (!sourceId) return { status: 'cancelled' } satisfies OpenCsvResult;
    if (sourceId instanceof Object) return sourceId;
    let retained = false;
    return yield* this.openSource(sourceId, options).pipe(
      Effect.tap((result) => Effect.sync(() => {
        retained = result.status === 'opened' || result.status === 'already-open';
      })),
      Effect.ensuring(Effect.sync(() => {
        if (!retained) this.host.releaseSource(sourceId);
      })),
    );
  }, Effect.uninterruptible);

  /** The admission covers the Recent CSV Source write, so disposal waits for accepted opens. */
  private readonly openSource = Effect.fnUntraced(function* (
    this: CsvWorkspaceImplementation,
    sourceId: CsvSourceId,
    options?: CsvDialectOptions,
  ): Effect.fn.Return<OpenCsvResult, WorkspaceRequestError | CsvOpenError, Scope.Scope> {
    if (!(yield* this.workingCsvs.admit())) return { status: 'failed', message: 'The CSV workspace is closing.' } satisfies OpenCsvResult;
    const outcome = yield* this.workingCsvs.open(sourceId, options);
    if (outcome.status === 'failed') return { status: 'failed', message: outcome.failure.message } satisfies OpenCsvResult;
    if (outcome.status === 'existing') return { status: 'already-open', workingCsv: outcome.workingCsv } satisfies OpenCsvResult;
    yield* this.recordRecentSource(sourceId);
    return { status: 'opened', workingCsv: outcome.workingCsv } satisfies OpenCsvResult;
  }, Effect.scoped);

  private recordRecentSource(sourceId: CsvSourceId) {
    return observeCleanup('csv.record-recent', Effect.suspend(() => this.host.recordRecentSource(sourceId)));
  }

  private readonly reopenCsv = Effect.fnUntraced(function* (
    this: CsvWorkspaceImplementation,
    workingCsvId: WorkingCsvId,
    options?: CsvDialectOptions,
  ): Effect.fn.Return<OpenCsvResult, CsvSourceUnavailableError | WorkspaceRequestError> {
    if (this.disposal) return { status: 'failed', message: 'The CSV workspace is closing.' } satisfies OpenCsvResult;
    const initial = this.workingCsvs.getState(workingCsvId);
    if (!initial) return { status: 'failed', message: 'The Working CSV is no longer open.' } satisfies OpenCsvResult;
    if (this.workingCsvs.isClosing(workingCsvId)) return { status: 'failed', message: 'This CSV is closing.' } satisfies OpenCsvResult;
    // A discard prompt may outlive disposal, so only the replacement runs under reopen admission.
    let existing: WorkingCsvView = initial;
    while (true) {
      while (existing.editState.hasUnexportedChanges) {
        const canContinue = yield* observeStage('csv.confirm-discard', this.host.confirmDiscardChanges(existing.source.name));
        if (!canContinue) return { status: 'cancelled' } satisfies OpenCsvResult;
        if (this.disposal) return { status: 'failed', message: 'The CSV workspace is closing.' } satisfies OpenCsvResult;
        const current = this.workingCsvs.getState(workingCsvId);
        if (!current) return { status: 'failed', message: 'The Working CSV is no longer open.' } satisfies OpenCsvResult;
        if (current.dataRevision === existing.dataRevision) {
          existing = current;
          break;
        }
        existing = current;
      }
      const outcome = yield* this.workingCsvs.replace(workingCsvId, existing.dataRevision, options);
      if (outcome.status === 'revision-changed') {
        existing = outcome.workingCsv;
        continue;
      }
      if (outcome.status === 'failed') return { status: 'failed', message: outcome.failure.message } satisfies OpenCsvResult;
      yield* this.recordRecentSource(outcome.workingCsv.source.sourceId);
      return { status: 'opened', workingCsv: outcome.workingCsv } satisfies OpenCsvResult;
    }
  }, Effect.uninterruptible);

  /**
   * Starts a Comparison operation and returns immediately. Terminal outcomes arrive through
   * Comparison events, so nothing live crosses the seam.
   */
  private beginComparison(request: BeginComparisonRequest): Effect.Effect<BeginComparisonResult> {
    return this.comparisons.begin(request).pipe(
      Effect.map((result): BeginComparisonResult => result.status === 'accepted'
        ? { status: 'accepted', operationId: result.operationId }
        : result),
      Effect.tap((result) => result.status === 'accepted' ? Effect.annotateCurrentSpan('operationId', result.operationId) : Effect.void),
    );
  }

  private readonly closeCsv = Effect.fnUntraced(function* (
    this: CsvWorkspaceImplementation,
    { workingCsvId, confirmedImpact }: CloseWorkingCsvRequest,
  ): Effect.fn.Return<CloseWorkingCsvOutcome> {
    if (!this.workingCsvs.has(workingCsvId)) {
      return { status: 'closed', closedWorkingCsvId: workingCsvId, closedComparisonIds: [] } satisfies CloseWorkingCsvOutcome;
    }
    if (!this.workingCsvs.beginClose(workingCsvId)) {
      return {
        status: 'failed',
        failure: { code: 'cleanup-failed', message: 'The Working CSV is already closing.', retryable: true },
      } satisfies CloseWorkingCsvOutcome;
    }
    return yield* this.closeClaimed(workingCsvId, confirmedImpact);
  });

  /** Closes a Working CSV whose close this caller began, and ends that close whatever the outcome. */
  private readonly closeClaimed = Effect.fnUntraced(function* (
    this: CsvWorkspaceImplementation,
    workingCsvId: WorkingCsvId,
    confirmedImpact: CloseImpact | undefined,
  ): Effect.fn.Return<CloseWorkingCsvOutcome, WorkspaceRequestError | DataEngineError> {
    yield* this.workingCsvs.waitForActiveWork(workingCsvId);
    const impact = yield* this.closeImpact(workingCsvId);
    if (requiresConfirmation(impact) && !(confirmedImpact && sameCloseImpact(impact, confirmedImpact))) {
      return { status: 'confirmation-required', impact } satisfies CloseWorkingCsvOutcome;
    }
    const closedComparisonIds = impact.dependentComparisons.map((comparison) => comparison.comparisonId);
    yield* observeStage('comparison.close', this.comparisons.closeDependents(workingCsvId));
    yield* this.workingCsvs.closeWorkingCsv(workingCsvId);
    return { status: 'closed', closedWorkingCsvId: workingCsvId, closedComparisonIds } satisfies CloseWorkingCsvOutcome;
  }, (effect, workingCsvId) => effect.pipe(
    Effect.catchCause((cause) => recordOutcome('failed', cause).pipe(Effect.andThen(markCleanupFailed), Effect.as({
      status: 'failed',
      failure: {
        code: 'cleanup-failed',
        message: 'Unable to close the Working CSV and all dependent Comparisons.',
        retryable: true,
      },
    } satisfies CloseWorkingCsvOutcome))),
    Effect.ensuring(Effect.sync(() => {
      if (this.workingCsvs.has(workingCsvId)) this.workingCsvs.endClose(workingCsvId);
    })),
  ));

  confirmClose(confirmedImpact?: WorkspaceCloseImpact): Promise<ConfirmWorkspaceCloseOutcome> {
    if (this.engineStopped) return Promise.reject(new WorkspaceRequestError({ message: stoppedEngineMessage }));
    return this.runOwner(Effect.gen({ self: this }, function* () {
      const impact = yield* this.windowCloseImpact();
      if (requiresWorkspaceConfirmation(impact) && !sameWorkspaceCloseImpact(impact, confirmedImpact)) {
        return { status: 'confirmation-required', impact } satisfies ConfirmWorkspaceCloseOutcome;
      }
      return { status: 'ready' } satisfies ConfirmWorkspaceCloseOutcome;
    }), 'workspace.confirm-close');
  }

  /** Runs once. Every later call, concurrent or not, returns the same result. */
  dispose(): Promise<void> {
    if (!this.disposal) {
      this.workingCsvs.beginDisposal();
      this.comparisons.beginDisposal();
      this.disposal = this.disposeWorkspace();
    }
    return this.disposal;
  }

  private readonly closeImpact = Effect.fnUntraced(function* (
    this: CsvWorkspaceImplementation,
    workingCsvId: WorkingCsvId,
  ): Effect.fn.Return<CloseImpact, WorkspaceRequestError> {
    if (!this.workingCsvs.has(workingCsvId)) {
      return yield* Effect.fail(new WorkspaceRequestError({ message: 'Working CSV is no longer active.' }));
    }
    return {
      hasUnexportedChanges: this.workingCsvs.hasUnexportedChanges(workingCsvId),
      dependentComparisons: yield* this.describeDependentComparisons([workingCsvId]),
    };
  });

  private readonly windowCloseImpact = Effect.fnUntraced(function* (
    this: CsvWorkspaceImplementation,
  ): Effect.fn.Return<WorkspaceCloseImpact> {
    const workingCsvs = this.workingCsvs.list().sort((left, right) => left.workingCsvId.localeCompare(right.workingCsvId));
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

  /** Every Comparison depending on any of these Working CSVs, deduplicated and ordered. */
  private readonly describeDependentComparisons = Effect.fnUntraced(function* (
    this: CsvWorkspaceImplementation,
    workingCsvIds: WorkingCsvId[],
  ): Effect.fn.Return<CloseImpact['dependentComparisons']> {
    const described = new Map<ComparisonId, CloseImpact['dependentComparisons'][number]>();
    for (const workingCsvId of workingCsvIds) {
      for (const comparisonId of this.comparisons.dependentComparisonIds(workingCsvId)) {
        if (described.has(comparisonId)) continue;
        const comparison = this.comparisons.getState(comparisonId);
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

  /**
   * Disposes the runtime, whose Layer finalizers release every service in order even when an
   * earlier release fails. A failed database release is a defect and marks cleanup failed.
   */
  private disposeWorkspace(): Promise<void> {
    return this.runOwner(Effect.exit(this.runtime.disposeEffect).pipe(
      Effect.tap((closed) => Exit.isFailure(closed) && closed.cause.reasons.some(isDatabaseReleaseFailure) ? markCleanupFailed : Effect.void),
      Effect.flatten,
    ), 'workspace.dispose');
  }
}

function isDatabaseReleaseFailure(reason: Cause.Reason<unknown>): boolean {
  return Cause.isDieReason(reason) && reason.defect instanceof DatabaseReleaseError;
}

/** The public rejection after a fatal stop never includes the Worker's error text. */
function workspaceStoppedError(): WorkspaceRequestError {
  return new WorkspaceRequestError({ message: stoppedEngineMessage });
}

function requiresConfirmation(impact: CloseImpact): boolean {
  return impact.hasUnexportedChanges || impact.dependentComparisons.length > 0;
}

function requiresWorkspaceConfirmation(impact: WorkspaceCloseImpact): boolean {
  return impact.workingCsvsWithUnexportedChanges.length > 0 || impact.dependentComparisons.length > 0;
}

/**
 * The impact is a deterministically ordered value object that never crosses a decoder, so
 * comparing its serialized form answers the only question that matters: did the owner confirm
 * exactly this impact, or has it changed since we asked? Anything unrecognised re-prompts.
 */
function sameWorkspaceCloseImpact(current: WorkspaceCloseImpact, confirmed: WorkspaceCloseImpact | undefined): boolean {
  return confirmed !== undefined && JSON.stringify(current) === JSON.stringify(confirmed);
}
