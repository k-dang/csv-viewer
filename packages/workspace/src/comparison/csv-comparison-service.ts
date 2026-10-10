import { OperationCleanup, diagnosticCause, markCleanupFailed, observeStage, recordOutcome } from '../workspace-diagnostics';
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, type Scope } from 'effect';
import type { DataEngineError } from '../database';
import type { WorkspaceRequestError } from '../errors';
import type {
  BeginComparisonRequest,
  CancelComparisonRequest,
  CancelComparisonResult,
  CloseComparisonResult,
  ComparisonCandidate,
  ComparisonEvent,
  ComparisonFault,
  ComparisonId,
  ComparisonKeyDiagnostics,
  ComparisonMutationOutcome,
  ComparisonOperationId,
  ComparisonPhase,
  ComparisonResultToken,
  ComparisonSide,
  ComparisonSummary,
  ComparisonView,
  ComparisonWindowOutcome,
  ComparisonWindowRequest,
  WorkingCsvView,
  WorkingCsvId,
  OpenComparisonResult,
  OpenComparisonRequest,
} from '../csv-viewer';
import { isValidRowWindow } from '../query/csv-query';
import { ComparisonExecutor } from './comparison-executor';
import {
  compareColumns,
  hasInvalidKeys,
  rejected,
  sharedColumnNames,
  sideOrder,
  validateKeySelection,
} from './comparison-key-rules';
import { projectComparison } from './comparison-projection';
import { cleanupEffect } from './comparison-effects';
import { WorkingCsvs } from '../working-csv/working-csv-store';

/** What Comparisons read from the Working CSVs they compare. */
export interface ComparisonCsvStore {
  getState(workingCsvId: WorkingCsvId): WorkingCsvView | null;
  list(): WorkingCsvView[];
  isClosing(workingCsvId: WorkingCsvId): boolean;
  subscribeToDataChanges(listener: (workingCsvId: WorkingCsvId) => void): () => void;
}

type Snapshot = {
  artifactId: ComparisonOperationId;
  resultToken: ComparisonResultToken;
  key: string[];
  summary: ComparisonSummary;
  swapped: boolean;
  revisions: { baseline: number; candidate: number };
  freshness: { kind: 'current' } | { kind: 'outdated'; changedSides: ComparisonSide[] };
};

type Operation = {
  operationId: ComparisonOperationId;
  intent: 'apply-key' | 'refresh';
  phase: ComparisonPhase;
  cancelRequested: boolean;
  changedSides: ComparisonSide[];
  invalidKeyDiagnostics: ComparisonKeyDiagnostics | null;
};

type AttemptResult = NonNullable<ComparisonView['lastAttempt']>;
type ClosedComparison = Extract<CloseComparisonResult, { status: 'closed' }>;

type ComparisonActivity =
  | { kind: 'idle'; lastAttempt: ComparisonView['lastAttempt'] }
  | {
      kind: 'running';
      operation: Operation;
      fiber: Fiber.Fiber<AttemptResult, DataEngineError | WorkspaceRequestError>;
      completion: Effect.Effect<ComparisonAttemptOutcome>;
    };

export type ComparisonAttemptOutcome =
  | { status: 'applied'; comparison: ComparisonView }
  | {
      status: 'invalid-key';
      diagnostics: ComparisonKeyDiagnostics;
      comparison: ComparisonView;
    }
  | { status: 'cancelled'; comparison: ComparisonView }
  | {
      status: 'sources-changed';
      changedSides: ComparisonSide[];
      comparison: ComparisonView;
    }
  | {
      status: 'failed';
      failure: Extract<ComparisonView['lastAttempt'], { status: 'failed' }>['failure'];
      comparison: ComparisonView | null;
    };

export type BeginComparisonAttempt =
  | {
      status: 'accepted';
      operationId: ComparisonOperationId;
      completion: Effect.Effect<ComparisonAttemptOutcome>;
    }
  | { status: 'busy'; activeOperationId: string }
  | { status: 'rejected'; fault: ComparisonFault };

type ComparisonRecord = {
  comparisonId: ComparisonId;
  version: number;
  baselineId: WorkingCsvId;
  candidateId: WorkingCsvId;
  snapshot: Snapshot | null;
  activity: ComparisonActivity;
};

/**
 * The workspace's Aligned Comparisons: their pairs, attempts, snapshot windows, and events.
 * Attempts run in the workspace scope; `dispose` settles them and releases their resources.
 */
export interface Comparisons {
  beginDisposal(): void;
  candidatesFor(baselineId: WorkingCsvId): ComparisonCandidate[];
  open(request: OpenComparisonRequest): OpenComparisonResult;
  getState(comparisonId: ComparisonId): ComparisonView | null;
  begin(request: BeginComparisonRequest): Effect.Effect<BeginComparisonAttempt>;
  cancel(request: CancelComparisonRequest): Effect.Effect<CancelComparisonResult>;
  getWindow(request: ComparisonWindowRequest): Effect.Effect<ComparisonWindowOutcome, DataEngineError | WorkspaceRequestError>;
  swap(comparisonId: ComparisonId): ComparisonMutationOutcome;
  close(comparisonId: ComparisonId): Effect.Effect<CloseComparisonResult>;
  dependentComparisonIds(workingCsvId: WorkingCsvId): ComparisonId[];
  closeDependents(workingCsvId: WorkingCsvId): Effect.Effect<void, DataEngineError>;
  subscribe(listener: (event: ComparisonEvent) => void): () => void;
  dispose(): Effect.Effect<void, DataEngineError>;
  /** Settles admitted work and forgets state after engine death, without initiating database cleanup. */
  stopAfterEngineStop(): Effect.Effect<void, DataEngineError>;
}

export const Comparisons = Context.Service<Comparisons>('csv-viewer/Comparisons');

/** Builds Comparisons over these Working CSVs. Attempts belong to the calling scope. */
export const makeComparisons = Effect.fnUntraced(function* (csvs: ComparisonCsvStore) {
  const service = new CsvComparisonService(csvs, yield* ComparisonExecutor, yield* Effect.scope);
  yield* Effect.addFinalizer(() => Effect.sync(service.unsubscribeFromDataChanges));
  return service;
});

export const comparisonsLayer = Layer.effect(Comparisons, WorkingCsvs.use(makeComparisons));

class CsvComparisonService implements Comparisons {
  private readonly entities = new Map<ComparisonId, ComparisonRecord>();
  private readonly pairIndex = new Map<string, ComparisonId>();
  private readonly dependencyIndex = new Map<WorkingCsvId, Set<ComparisonId>>();
  private readonly listeners = new Set<(event: ComparisonEvent) => void>();
  private readonly closing = new Map<ComparisonId, Effect.Effect<ClosedComparison, DataEngineError>>();
  private readonly pendingRetirements = new Set<string>();
  readonly unsubscribeFromDataChanges: () => void;
  private lifecycle: 'active' | 'disposing' | 'disposed' = 'active';

  constructor(
    private readonly csvs: ComparisonCsvStore,
    private readonly executor: ComparisonExecutor,
    private readonly workspaceScope: Scope.Scope,
  ) {
    this.unsubscribeFromDataChanges = csvs.subscribeToDataChanges((workingCsvId) => {
      this.markSourceChanged(workingCsvId);
    });
  }

  beginDisposal(): void {
    if (this.lifecycle === 'active') this.lifecycle = 'disposing';
  }

  candidatesFor(baselineId: WorkingCsvId): ComparisonCandidate[] {
    if (this.lifecycle !== 'active') return [];
    const baseline = this.csvs.getState(baselineId);
    if (!baseline) return [];

    return this.csvs
      .list()
      .filter((workingCsv) => workingCsv.workingCsvId !== baselineId && !this.csvs.isClosing(workingCsv.workingCsvId))
      .map((workingCsv) => ({ workingCsv, compatibility: compareColumns(baseline, workingCsv) }))
      .sort((left, right) => {
        const compatibilityOrder =
          Number(left.compatibility.kind === 'incompatible') - Number(right.compatibility.kind === 'incompatible');
        if (compatibilityOrder !== 0) return compatibilityOrder;
        return (
          compareText(left.workingCsv.source.name, right.workingCsv.source.name) ||
          compareText(left.workingCsv.source.location, right.workingCsv.source.location)
        );
      });
  }

  open(request: OpenComparisonRequest): OpenComparisonResult {
    if (this.lifecycle !== 'active') {
      return rejected('source-not-found', 'The CSV workspace is closing.');
    }
    const baseline = this.csvs.getState(request.baselineId);
    const candidate = this.csvs.getState(request.candidateId);
    if (!baseline || !candidate) return rejected('source-not-found', 'Both Working CSVs must still be open.');
    if (this.csvs.isClosing(request.baselineId) || this.csvs.isClosing(request.candidateId)) {
      return rejected('source-not-found', 'A Working CSV is closing.');
    }
    if (request.baselineId === request.candidateId)
      return rejected('same-source', 'Choose two different Working CSVs.');
    if (compareColumns(baseline, candidate).kind === 'incompatible') {
      return rejected('incompatible-columns', 'The Working CSVs must contain the same column names.');
    }

    const pair = pairKey(request.baselineId, request.candidateId);
    const existingId = this.pairIndex.get(pair);
    if (existingId) {
      const comparison = this.getState(existingId);
      if (comparison) return { status: 'existing', comparison };
      this.pairIndex.delete(pair);
    }

    const entity: ComparisonRecord = {
      comparisonId: crypto.randomUUID(),
      version: 1,
      baselineId: request.baselineId,
      candidateId: request.candidateId,
      snapshot: null,
      activity: { kind: 'idle', lastAttempt: null },
    };
    this.entities.set(entity.comparisonId, entity);
    this.pairIndex.set(pair, entity.comparisonId);
    this.addDependency(entity.baselineId, entity.comparisonId);
    this.addDependency(entity.candidateId, entity.comparisonId);
    return { status: 'created', comparison: this.project(entity) };
  }

  getState(comparisonId: ComparisonId): ComparisonView | null {
    const entity = this.entities.get(comparisonId);
    return entity ? this.project(entity) : null;
  }

  // Admission must record ownership and open the gate even if its caller is interrupted.
  readonly begin = Effect.fnUntraced(function* (
    this: CsvComparisonService,
    request: BeginComparisonRequest,
  ): Effect.fn.Return<BeginComparisonAttempt> {
    if (this.lifecycle !== 'active') {
      return rejected('source-not-found', 'The CSV workspace is closing.');
    }
    const entity = this.entities.get(request.comparisonId);
    if (!entity) return rejected('comparison-not-found', 'The Comparison Tab is no longer open.');
    if (entity.activity.kind === 'running') {
      return { status: 'busy', activeOperationId: entity.activity.operation.operationId };
    }

    if (this.closing.has(entity.comparisonId)) {
      return rejected('comparison-not-found', 'The Comparison Tab is closing.');
    }

    const key = request.kind === 'apply-key' ? request.key : entity.snapshot?.key;
    if (!key) return rejected('no-applied-key', 'Apply a Comparison Key before refreshing.');
    const keyFault = validateKeySelection(key, this.availableKeyColumns(entity));
    if (keyFault) return { status: 'rejected', fault: keyFault };
    if (this.csvs.isClosing(entity.baselineId) || this.csvs.isClosing(entity.candidateId)) {
      return rejected('source-not-found', 'A Working CSV is closing.');
    }
    if (!this.sourcesCompatible(entity))
      return rejected('incompatible-columns', 'The Working CSVs no longer contain the same columns.');

    const operation: Operation = {
      operationId: crypto.randomUUID(),
      intent: request.kind,
      phase: 'validating',
      cancelRequested: false,
      changedSides: [],
      invalidKeyDiagnostics: null,
    };
    const ready = yield* Deferred.make<void>();
    const completed = yield* Deferred.make<ComparisonAttemptOutcome>();
    const cleanup = { failed: false };
    const fiber = yield* Effect.forkIn(
      Effect.scoped(Deferred.await(ready).pipe(
        // Return from admission before starting database work.
        Effect.andThen(Effect.yieldNow),
        Effect.andThen(this.compute(entity, operation, [...key])),
      )).pipe(
        Effect.onExit((result) => Effect.gen({ self: this }, function* () {
          const outcome = this.finishAttempt(entity, operation, result);
          const cause = Exit.isFailure(result) ? result.cause : undefined;
          yield* recordOutcome(outcome.status, cause, cleanup.failed || (cause && diagnosticCause(cause) === 'cleanup-failed') ? 'cleanup-failed' : 'succeeded');
          return outcome;
        }).pipe(Effect.onExit((exit) => Deferred.done(completed, exit)))),
        (effect) => observeStage('comparison.compute', effect),
        Effect.provideService(OperationCleanup, cleanup),
        Effect.annotateSpans({ comparisonId: entity.comparisonId, operationId: operation.operationId, baselineId: entity.baselineId, candidateId: entity.candidateId }),
      ),
      this.workspaceScope,
      // Install settlement before a running-state subscriber can request cancellation.
      { startImmediately: true },
    );
    const completion = Deferred.await(completed);
    entity.activity = { kind: 'running', operation, fiber, completion };
    this.publishChange(entity);
    yield* Deferred.succeed(ready, undefined);
    return { status: 'accepted', operationId: operation.operationId, completion };
  }, Effect.uninterruptible);

  readonly cancel = Effect.fnUntraced(function* (
    this: CsvComparisonService,
    request: CancelComparisonRequest,
  ): Effect.fn.Return<CancelComparisonResult> {
    const entity = this.entities.get(request.comparisonId);
    if (!entity) return { status: 'comparison-not-found' };
    if (entity.activity.kind === 'idle') return { status: 'already-finished' };
    const operation = entity.activity.operation;
    if (operation.operationId !== request.operationId) return { status: 'operation-mismatch' };
    if (operation.cancelRequested) return { status: 'already-requested' };
    operation.cancelRequested = true;
    yield* Effect.forkIn(Fiber.interrupt(entity.activity.fiber), this.workspaceScope);
    return { status: 'requested' };
  });

  readonly getWindow = Effect.fnUntraced(function* (
    this: CsvComparisonService,
    request: ComparisonWindowRequest,
  ): Effect.fn.Return<ComparisonWindowOutcome, DataEngineError | WorkspaceRequestError> {
    if (this.lifecycle !== 'active') {
      return rejected('source-not-found', 'The CSV workspace is closing.');
    }
    const entity = this.entities.get(request.comparisonId);
    if (!entity) return { status: 'comparison-not-found' };
    const snapshot = entity.snapshot;
    if (!snapshot || snapshot.resultToken !== request.resultToken) {
      return { status: 'result-replaced', currentResultToken: snapshot?.resultToken ?? null };
    }
    if (!isValidRowWindow(request.offset, request.limit)) {
      return rejected(
        'invalid-window',
        'Comparison windows require a non-negative offset and a limit of at most 1,000.',
      );
    }

    const read = yield* Effect.exit(this.executor.readWindow({
        artifactId: snapshot.artifactId,
        keyCount: snapshot.key.length,
        valueCount: snapshot.summary.changedColumns.length,
        offset: request.offset,
        limit: request.limit,
        rows: request.rows,
        search: request.search,
        order: request.order,
        swapped: snapshot.swapped,
      }));
    const current = this.entities.get(request.comparisonId)?.snapshot;
    if (!current || current.resultToken !== request.resultToken) {
      return { status: 'result-replaced', currentResultToken: current?.resultToken ?? null };
    }

    if (Exit.isFailure(read)) return yield* Effect.failCause(read.cause);
    const stored = read.value;
    return {
      status: 'ready',
      window: {
        comparisonId: entity.comparisonId,
        resultToken: snapshot.resultToken,
        offset: request.offset,
        totalRowCount: stored.totalRowCount,
        keyColumns: [...snapshot.key],
        rows: stored.rows,
      },
    };
  });

  swap(comparisonId: ComparisonId): ComparisonMutationOutcome {
    if (this.lifecycle !== 'active') {
      return rejected('source-not-found', 'The CSV workspace is closing.');
    }
    const entity = this.entities.get(comparisonId);
    if (!entity) return rejected('comparison-not-found', 'The Comparison Tab is no longer open.');
    if (entity.activity.kind === 'running') {
      return rejected('busy', 'Wait for the active comparison operation to finish.');
    }

    [entity.baselineId, entity.candidateId] = [entity.candidateId, entity.baselineId];
    if (entity.snapshot) {
      const snapshot = entity.snapshot;
      snapshot.swapped = !snapshot.swapped;
      [snapshot.summary.rows.baselineOnly, snapshot.summary.rows.candidateOnly] = [
        snapshot.summary.rows.candidateOnly,
        snapshot.summary.rows.baselineOnly,
      ];
      [snapshot.revisions.baseline, snapshot.revisions.candidate] = [
        snapshot.revisions.candidate,
        snapshot.revisions.baseline,
      ];
      if (snapshot.freshness.kind === 'outdated') {
        snapshot.freshness = {
          kind: 'outdated',
          changedSides: snapshot.freshness.changedSides
            .map((side) => (side === 'baseline' ? 'candidate' : 'baseline'))
            .sort(sideOrder),
        };
      }
      snapshot.resultToken = crypto.randomUUID();
    }
    this.publishChange(entity);
    return { status: 'changed', comparison: this.project(entity) };
  }

  /** Converts cleanup failure into the public close result, keeping Causes inside the service. */
  close(comparisonId: ComparisonId): Effect.Effect<CloseComparisonResult> {
    return this.closeInternal(comparisonId).pipe(Effect.catchCause(() => Effect.succeed({
      status: 'failed',
      failure: { code: 'cleanup-failed', message: 'Unable to clean up the Comparison snapshot.', retryable: true },
    } satisfies CloseComparisonResult)));
  }

  // Shared close must finish cleanup even when one caller stops waiting.
  private readonly closeInternal = Effect.fnUntraced(function* (
    this: CsvComparisonService,
    comparisonId: ComparisonId,
  ): Effect.fn.Return<ClosedComparison, DataEngineError> {
    const pending = this.closing.get(comparisonId);
    if (pending) return yield* pending;
    const entity = this.entities.get(comparisonId);
    if (!entity) return { status: 'closed', comparisonId };
    const completion = yield* Effect.cached(this.closeEntity(entity).pipe(
      Effect.ensuring(Effect.sync(() => this.closing.delete(comparisonId))),
    ));
    this.closing.set(comparisonId, completion);
    return yield* completion;
  }, Effect.uninterruptible, Effect.onExit((exit) => Exit.isFailure(exit)
    ? recordOutcome('failed', exit.cause).pipe(Effect.andThen(markCleanupFailed))
    : Effect.void));

  private readonly closeEntity = Effect.fnUntraced(function* (
    this: CsvComparisonService,
    entity: ComparisonRecord,
  ): Effect.fn.Return<ClosedComparison, DataEngineError> {
    const { comparisonId } = entity;
    if (entity.activity.kind === 'running') {
      const { operation, fiber, completion } = entity.activity;
      operation.cancelRequested = true;
      yield* Fiber.interrupt(fiber);
      yield* completion;
    }
    if (entity.snapshot) {
      yield* this.executor.dropSnapshot(entity.snapshot.artifactId);
    }
    this.entities.delete(comparisonId);
    this.pairIndex.delete(pairKey(entity.baselineId, entity.candidateId));
    this.removeDependency(entity.baselineId, comparisonId);
    this.removeDependency(entity.candidateId, comparisonId);
    this.emit({ kind: 'closed', comparisonId });
    return { status: 'closed', comparisonId };
  });

  dependentComparisonIds(workingCsvId: WorkingCsvId): ComparisonId[] {
    return [...(this.dependencyIndex.get(workingCsvId) ?? [])];
  }

  readonly closeDependents = Effect.fnUntraced(function* (
    this: CsvComparisonService,
    workingCsvId: WorkingCsvId,
  ): Effect.fn.Return<void, DataEngineError> {
    for (const comparisonId of this.dependentComparisonIds(workingCsvId)) {
      yield* this.closeInternal(comparisonId);
    }
  });

  subscribe(listener: (event: ComparisonEvent) => void): () => void {
    if (this.lifecycle !== 'active') return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Finish every admitted close and cleanup attempt before disposal can settle.
  readonly dispose = Effect.fnUntraced(function* (
    this: CsvComparisonService,
  ): Effect.fn.Return<void, DataEngineError> {
    this.beginDisposal();
    this.unsubscribeFromDataChanges();
    const failures: Cause.Cause<DataEngineError>[] = [];
    for (const comparisonId of [...this.entities.keys()]) {
      const closed = yield* Effect.exit(this.closeInternal(comparisonId));
      if (Exit.isFailure(closed)) failures.push(closed.cause);
    }
    const disposed = yield* Effect.exit(this.executor.dispose());
    if (Exit.isFailure(disposed)) failures.push(disposed.cause);
    this.listeners.clear();
    if (failures.length > 0) return yield* Effect.failCause(failures.reduce((combined, cause) => Cause.combine(combined, cause), Cause.empty));
    this.lifecycle = 'disposed';
  }, Effect.uninterruptible);

  /** Keep source projections alive until every attempt and admitted close has settled. */
  readonly stopAfterEngineStop = Effect.fnUntraced(function* (
    this: CsvComparisonService,
  ): Effect.fn.Return<void, DataEngineError> {
    this.beginDisposal();
    this.unsubscribeFromDataChanges();
    const settled: Exit.Exit<unknown, DataEngineError>[] = [];
    for (const entity of this.entities.values()) {
      if (entity.activity.kind !== 'running') continue;
      const { operation, fiber, completion } = entity.activity;
      operation.cancelRequested = true;
      yield* Fiber.interrupt(fiber);
      settled.push(yield* Effect.exit(completion));
    }
    for (const close of [...this.closing.values()]) settled.push(yield* Effect.exit(close));
    this.entities.clear();
    this.pairIndex.clear();
    this.dependencyIndex.clear();
    this.pendingRetirements.clear();
    this.listeners.clear();
    this.lifecycle = 'disposed';
    yield* Exit.asVoidAll(settled);
  }, Effect.uninterruptible);

  // onExit settles after the attempt scope closes, even when its fiber was interrupted.
  private finishAttempt(
    entity: ComparisonRecord,
    operation: Operation,
    result: Exit.Exit<AttemptResult, DataEngineError | WorkspaceRequestError>,
  ): ComparisonAttemptOutcome {
    // Cancellation or cleanup failure after publication must preserve the committed result.
    if (entity.snapshot?.artifactId === operation.operationId) {
      return this.settle(entity, operation, { attemptId: operation.operationId, status: 'applied' });
    }
    if (operation.changedSides.length > 0) {
      return this.finishSourcesChanged(entity, operation, operation.changedSides);
    }
    if (operation.cancelRequested || (Exit.isFailure(result) && Cause.hasInterrupts(result.cause))) {
      return this.finishCancelled(entity, operation);
    }
    if (operation.invalidKeyDiagnostics) {
      return this.settle(entity, operation, {
        attemptId: operation.operationId,
        status: 'invalid-key',
        diagnostics: operation.invalidKeyDiagnostics,
      });
    }
    if (Exit.isFailure(result)) return this.finishFailed(entity, operation, result.cause);
    return this.settle(entity, operation, result.value);
  }

  private readonly compute = Effect.fnUntraced(function* (
    this: CsvComparisonService,
    entity: ComparisonRecord,
    operation: Operation,
    key: string[],
  ): Effect.fn.Return<AttemptResult, DataEngineError | WorkspaceRequestError, Scope.Scope> {
    yield* this.retryPendingRetirements();
    const baseline = this.csvs.getState(entity.baselineId);
    const candidate = this.csvs.getState(entity.candidateId);
    if (!baseline || !candidate) {
      return {
        attemptId: operation.operationId,
        status: 'failed',
        failure: {
          code: 'source-unavailable',
          message: 'A source Working CSV is no longer available.',
          retryable: false,
        },
      };
    }
    const captured = { baseline: baseline.dataRevision, candidate: candidate.dataRevision };
    const executor = yield* observeStage('comparison.acquire-worker', this.executor.openAttempt());
    const baselineDiagnostics = yield* observeStage('comparison.validate-key', executor.validateKey(entity.baselineId, key)).pipe(Effect.annotateSpans({ workingCsvId: entity.baselineId }));
    const candidateDiagnostics = yield* observeStage('comparison.validate-key', executor.validateKey(entity.candidateId, key)).pipe(Effect.annotateSpans({ workingCsvId: entity.candidateId }));
    const diagnostics: ComparisonKeyDiagnostics = {
      key,
      baseline: baselineDiagnostics,
      candidate: candidateDiagnostics,
    };
    if (hasInvalidKeys(diagnostics)) {
      // Keep completed diagnostics if closing the worker turns the scope's Exit into a failure.
      operation.invalidKeyDiagnostics = diagnostics;
      return { attemptId: operation.operationId, status: 'invalid-key', diagnostics };
    }

    operation.phase = 'comparing';
    this.publishChange(entity);
    yield* Effect.yieldNow;
    const valueColumns = baseline.columns.map((column) => column.name).filter((column) => !key.includes(column));
    // Retire partial snapshots unless publication transferred ownership to the tab.
    yield* Effect.addFinalizer(() => Effect.suspend(() =>
      entity.snapshot?.artifactId !== operation.operationId
        ? cleanupEffect(this.retireSnapshot(operation.operationId))
        : Effect.void,
    ));
    const summary = yield* observeStage('comparison.snapshot', executor.createSnapshot({
      artifactId: operation.operationId,
      comparisonId: entity.comparisonId,
      baselineId: entity.baselineId,
      candidateId: entity.candidateId,
      key,
      valueColumns,
    }));
    yield* Effect.yieldNow;
    const previousArtifactId = entity.snapshot?.artifactId;
    if (previousArtifactId) {
      yield* Effect.addFinalizer(() => Effect.suspend(() =>
        entity.snapshot?.artifactId === operation.operationId
          ? cleanupEffect(this.retireSnapshot(previousArtifactId))
          : Effect.void,
      ));
    }
    return yield* Effect.sync((): AttemptResult => {
      const changedSides = changedComparisonSides(
        this.csvs.getState(entity.baselineId),
        this.csvs.getState(entity.candidateId),
        captured,
      );
      if (changedSides.length > 0) {
        return { attemptId: operation.operationId, status: 'sources-changed', changedSides };
      }
      if (!this.operationIsCurrent(entity, operation)) {
        return { attemptId: operation.operationId, status: 'cancelled' };
      }
      this.executor.activateSnapshot(operation.operationId);
      entity.snapshot = {
        artifactId: operation.operationId,
        resultToken: operation.operationId,
        key,
        swapped: false,
        summary,
        revisions: captured,
        freshness: { kind: 'current' },
      };
      this.publishChange(entity);
      return { attemptId: operation.operationId, status: 'applied' };
    });
  });

  private readonly retireSnapshot = Effect.fnUntraced(function* (
    this: CsvComparisonService,
    artifactId: ComparisonOperationId,
  ): Effect.fn.Return<void, DataEngineError> {
    const retired = yield* Effect.exit(this.executor.dropSnapshot(artifactId));
    if (Exit.isFailure(retired)) {
      this.pendingRetirements.add(artifactId);
      return yield* Effect.failCause(retired.cause);
    }
    this.pendingRetirements.delete(artifactId);
  });

  private readonly retryPendingRetirements = Effect.fnUntraced(function* (
    this: CsvComparisonService,
  ) {
    for (const artifactId of [...this.pendingRetirements]) {
      // Keep failed retirements for the next attempt or executor disposal.
      yield* Effect.exit(this.retireSnapshot(artifactId));
    }
  });

  private finishCancelled(entity: ComparisonRecord, operation: Operation): ComparisonAttemptOutcome {
    return this.settle(entity, operation, {
      attemptId: operation.operationId,
      status: 'cancelled',
    });
  }

  private finishFailed(entity: ComparisonRecord, operation: Operation, cause: Cause.Cause<DataEngineError | WorkspaceRequestError>): ComparisonAttemptOutcome {
    const [reason] = cause.reasons;
    const sourceUnavailable = cause.reasons.length === 1 && reason._tag === 'Fail' && reason.error._tag === 'WorkspaceRequestError';
    return this.settle(entity, operation, {
      attemptId: operation.operationId,
      status: 'failed',
      failure: sourceUnavailable
        ? { code: 'source-unavailable', message: 'A source Working CSV is no longer available.', retryable: false }
        : { code: 'query-failed', message: 'The comparison query failed. Try again.', retryable: true },
    });
  }

  private finishSourcesChanged(
    entity: ComparisonRecord,
    operation: Operation,
    changedSides: ComparisonSide[],
  ): ComparisonAttemptOutcome {
    return this.settle(entity, operation, {
      attemptId: operation.operationId,
      status: 'sources-changed',
      changedSides: [...changedSides].sort(sideOrder),
    });
  }

  private operationIsCurrent(entity: ComparisonRecord, operation: Operation): boolean {
    return (
      this.entities.get(entity.comparisonId) === entity &&
      entity.activity.kind === 'running' &&
      entity.activity.operation.operationId === operation.operationId &&
      !operation.cancelRequested
    );
  }

  private markSourceChanged(workingCsvId: WorkingCsvId): void {
    for (const comparisonId of this.dependencyIndex.get(workingCsvId) ?? []) {
      const entity = this.entities.get(comparisonId);
      if (!entity) throw new Error('Comparison dependency index invariant violated.');
      const side =
        entity.baselineId === workingCsvId ? 'baseline' : entity.candidateId === workingCsvId ? 'candidate' : null;
      if (!side) continue;
      if (entity.activity.kind === 'running') {
        const { operation } = entity.activity;
        if (!operation.changedSides.includes(side)) operation.changedSides.push(side);
        // Data changes arrive through a synchronous callback. Request interruption only;
        // the workspace-owned fiber still runs its finalizers and terminal projection.
        entity.activity.fiber.interruptUnsafe();
      }
      if (!entity.snapshot) continue;
      const changedSides = entity.snapshot.freshness.kind === 'outdated' ? entity.snapshot.freshness.changedSides : [];
      if (!changedSides.includes(side)) changedSides.push(side);
      entity.snapshot.freshness = {
        kind: 'outdated',
        changedSides: [...changedSides].sort(sideOrder),
      };
      this.publishChange(entity);
    }
  }

  private addDependency(workingCsvId: WorkingCsvId, comparisonId: ComparisonId): void {
    const comparisons = this.dependencyIndex.get(workingCsvId) ?? new Set<ComparisonId>();
    comparisons.add(comparisonId);
    this.dependencyIndex.set(workingCsvId, comparisons);
  }

  private removeDependency(workingCsvId: WorkingCsvId, comparisonId: ComparisonId): void {
    const comparisons = this.dependencyIndex.get(workingCsvId);
    if (!comparisons) throw new Error('Comparison dependency index invariant violated.');
    comparisons.delete(comparisonId);
    if (comparisons.size === 0) this.dependencyIndex.delete(workingCsvId);
  }

  private sourcesCompatible(entity: ComparisonRecord): boolean {
    const baseline = this.csvs.getState(entity.baselineId);
    const candidate = this.csvs.getState(entity.candidateId);
    return Boolean(baseline && candidate && compareColumns(baseline, candidate).kind === 'compatible');
  }

  private availableKeyColumns(entity: ComparisonRecord): string[] {
    const baseline = this.csvs.getState(entity.baselineId);
    const candidate = this.csvs.getState(entity.candidateId);
    return baseline && candidate ? sharedColumnNames(baseline, candidate) : [];
  }

  private project(entity: ComparisonRecord): ComparisonView {
    const baseline = this.csvs.getState(entity.baselineId);
    const candidate = this.csvs.getState(entity.candidateId);
    if (!baseline || !candidate) throw new Error('Comparison source invariant violated.');
    return projectComparison({
      comparisonId: entity.comparisonId,
      version: entity.version,
      baseline,
      candidate,
      availableKeyColumns: this.availableKeyColumns(entity),
      operation:
        entity.activity.kind === 'running'
          ? {
              operationId: entity.activity.operation.operationId,
              intent: entity.activity.operation.intent,
              phase: entity.activity.operation.phase,
            }
          : null,
      applied: entity.snapshot,
      lastAttempt: entity.activity.kind === 'idle' ? entity.activity.lastAttempt : null,
    });
  }

  private settle(
    entity: ComparisonRecord,
    operation: Operation,
    lastAttempt: ComparisonView['lastAttempt'],
  ): ComparisonAttemptOutcome {
    if (
      this.entities.get(entity.comparisonId) !== entity ||
      entity.activity.kind !== 'running' ||
      entity.activity.operation.operationId !== operation.operationId
    ) {
      throw new Error('Comparison operation settlement invariant violated.');
    }
    entity.activity = { kind: 'idle', lastAttempt };
    this.publishChange(entity);
    if (!lastAttempt) throw new Error('Comparison terminal outcome invariant violated.');
    if (lastAttempt.status === 'failed') {
      const baseline = this.csvs.getState(entity.baselineId);
      const candidate = this.csvs.getState(entity.candidateId);
      return {
        status: 'failed',
        failure: lastAttempt.failure,
        comparison: baseline && candidate ? this.project(entity) : null,
      };
    }
    const comparison = this.project(entity);
    switch (lastAttempt.status) {
      case 'applied':
        return { status: 'applied', comparison };
      case 'invalid-key':
        return { status: 'invalid-key', diagnostics: lastAttempt.diagnostics, comparison };
      case 'cancelled':
        return { status: 'cancelled', comparison };
      case 'sources-changed':
        return { status: 'sources-changed', changedSides: lastAttempt.changedSides, comparison };
    }
  }

  private publishChange(entity: ComparisonRecord): void {
    if (!this.csvs.getState(entity.baselineId) || !this.csvs.getState(entity.candidateId)) {
      return;
    }
    entity.version += 1;
    this.emit({ kind: 'changed', comparison: this.project(entity) });
  }

  private emit(event: ComparisonEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A subscriber cannot prevent other subscribers or resource cleanup.
      }
    }
  }
}

function changedComparisonSides(
  baseline: WorkingCsvView | null,
  candidate: WorkingCsvView | null,
  captured: Snapshot['revisions'],
): ComparisonSide[] {
  const changedSides: ComparisonSide[] = [];
  if (!baseline || baseline.dataRevision !== captured.baseline) changedSides.push('baseline');
  if (!candidate || candidate.dataRevision !== captured.candidate) changedSides.push('candidate');
  return changedSides;
}

function pairKey(left: string, right: string): string {
  return [left, right].sort().join('\u0000');
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base' });
}
