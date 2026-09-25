import { Cause, Context, Effect, Exit, Logger, References, Schema, Tracer } from 'effect';
import { ComparisonCleanupError } from './comparison/comparison-effects';

/** Tests can capture standard Effect logger events at workspace composition. */
export interface WorkspaceDiagnostics {
  readonly logger?: Logger.Logger<unknown, void>;
}

const outcomes = new Set([
  'started', 'succeeded', 'applied', 'accepted', 'busy', 'rejected', 'ready', 'closed',
  'requested', 'already-requested', 'already-finished', 'operation-mismatch',
  'comparison-not-found', 'result-replaced', 'invalid-key', 'sources-changed',
  'opened', 'already-open', 'revision-changed', 'working-csv-not-found',
  'cancelled', 'failed', 'recoverable-failure', 'defect', 'interrupted', 'cleanup-failed',
]);
const identifiers = new Set(['workspaceId', 'requestId', 'comparisonId', 'operationId', 'baselineId', 'candidateId', 'workingCsvId']);

// Effect accepts arbitrary attribute values; this is the diagnostic output boundary.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function approvedField(key: string, value: unknown): boolean {
  if (identifiers.has(key)) return Schema.is(Schema.String)(value) && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
  if (key === 'outcome' || key === 'failureCategory' || key === 'cleanup') return Schema.is(Schema.String)(value) && outcomes.has(value);
  if (key === 'csvFailureCategory') return Schema.is(Schema.String)(value) && ['source-access', 'dialect', 'engine'].includes(value);
  if (key === 'recoverableFailure' || key === 'defect' || key === 'interrupted') return value === true || value === false;
  return false;
}

/** Classify only the outer typed reasons. Never inspect or serialize nested driver causes. */
export function diagnosticCause(cause: Cause.Cause<unknown>): string {
  if (cause.reasons.some((reason) => reason._tag === 'Die' && reason.defect instanceof ComparisonCleanupError)) return 'cleanup-failed';
  if (Cause.hasDies(cause)) return 'defect';
  if (Cause.hasFails(cause)) return 'recoverable-failure';
  return 'interrupted';
}

/** Standard Effect spans supply tracing context and built-in log-span durations. */
export function observeStage<A, E, R>(stage: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const span = yield* Effect.currentSpan.pipe(Effect.orDie);
    const report = (outcome: string) => Effect.logInfo(stage).pipe(
      Effect.annotateLogs({ outcome, ...Object.fromEntries([...span.attributes].filter(([key, value]) => approvedField(key, value))) }),
      // A failed console or test logger must not prevent resource cleanup.
      Effect.catchCause(() => Effect.void),
    );
    yield* report('started');
    return yield* effect.pipe(Effect.onExit((exit) => report(Exit.isFailure(exit) ? diagnosticCause(exit.cause) : 'succeeded')));
  }).pipe(Effect.withLogSpan(stage), Effect.withSpan(stage, {}, { captureStackTrace: false }));
}

export function recordOutcome(outcome: string, cause?: Cause.Cause<unknown>, cleanup?: 'succeeded' | 'cleanup-failed') {
  const fields = cause ? { outcome, cleanup, failureCategory: diagnosticCause(cause), recoverableFailure: Cause.hasFails(cause), defect: cause.reasons.some((reason) => reason._tag === 'Die' && !(reason.defect instanceof ComparisonCleanupError)), interrupted: Cause.hasInterrupts(cause) } : { outcome, cleanup, failureCategory: cleanup === 'cleanup-failed' ? 'cleanup-failed' : undefined };
  return Effect.annotateCurrentSpan(fields);
}

export function diagnosticsLayer(configuration: WorkspaceDiagnostics = {}) {
  return Logger.layer([configuration.logger ?? Logger.consoleLogFmt]);
}

/** Keep the original tracing and timing context for release, without retaining its scope. */
export function retainDiagnosticContext<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const annotations = yield* Effect.spanAnnotations;
    const fields = Object.fromEntries(Object.entries(annotations).filter(([key, value]) => identifiers.has(key) && approvedField(key, value)));
    return effect.pipe(Effect.annotateSpans(fields), Effect.provideContext(Context.pick(Tracer.ParentSpan, References.CurrentLogSpans)(context)));
  });
}
