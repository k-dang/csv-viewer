import { Context, Data, Effect, Layer, Scope } from 'effect';
import type { QueryValues } from './query/csv-query';
import type { EngineRow } from './query/csv-result-normalization';
import { observeStage } from './workspace-diagnostics';

export const engineFailureMessage = 'The data engine could not complete the operation.';

export const stoppedEngineMessage = 'The data engine has stopped. Reload CSV Viewer to start a new workspace.';

/**
 * Interrupting a cancellable query requests cancellation and waits for the driver to settle.
 * Other operations are uninterruptible until settlement, keeping their resources alive throughout.
 */
export interface WorkspaceDatabaseConnection {
  run(sql: string, values?: QueryValues): Effect.Effect<void, DataEngineError>;
  readObjects(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError>;
  /**
   * Runs long work through the engine's cancellable execution path. Kept separate from `run` and
   * `readObjects` because DuckDB-Wasm's cancellable path holds one connection's single result
   * stream, so it cannot interleave with the concurrent short queries the owner connection serves.
   */
  runCancellable(sql: string): Effect.Effect<void, DataEngineError>;
  readObjectsCancellable(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError>;
  close(): Effect.Effect<void, DataEngineError>;
}

/**
 * One acquired in-memory database with an owner connection and isolated operation connections.
 * The workspace runtime acquires it before the workspace exists and releases it after every
 * Working CSV table, so it is open for the whole life of every caller. Callers own the worker
 * connections they acquire and close each one.
 */
export interface WorkspaceDatabase {
  ownerConnection(): Effect.Effect<WorkspaceDatabaseConnection, DataEngineError>;
  connectWorker(): Effect.Effect<WorkspaceDatabaseConnection, DataEngineError>;
  run(sql: string, values?: QueryValues): Effect.Effect<void, DataEngineError>;
  readObjects(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError>;
}

export const WorkspaceDatabase = Context.Service<WorkspaceDatabase>('csv-viewer/Database');

/**
 * Acquires a runtime's database in the given scope. Each adapter registers its release steps with
 * `releaseOnClose` before it can hold the matching resource, or acquires the resource with
 * `acquireWithRelease`, so an acquisition that fails or is interrupted partway releases exactly
 * what it acquired.
 */
export type OpenWorkspaceDatabase = Effect.Effect<WorkspaceDatabase, DataEngineError, Scope.Scope>;

/** A failed database release. Closing the Layer scope dies with it, and diagnostics report it as `cleanup-failed`. */
export class DatabaseReleaseError extends Data.TaggedError('DatabaseReleaseError')<{ cause: unknown }> {
  override readonly message = 'The workspace database could not be released.';
}

/**
 * Registers one database release step. Steps run in reverse registration order, so the owner
 * connection closes before the engine stops, and every step runs even when an earlier one failed.
 */
export function releaseOnClose(
  step: DatabaseReleaseStep,
  release: Effect.Effect<void, DataEngineError>,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.addFinalizer(() => observeRelease(step, release));
}

/** Acquires one resource and registers its release step without an interruptible gap between them. */
export function acquireWithRelease<A>(
  step: DatabaseReleaseStep,
  acquire: Effect.Effect<A, DataEngineError>,
  release: (resource: A) => Effect.Effect<void, DataEngineError>,
): Effect.Effect<A, DataEngineError, Scope.Scope> {
  return Effect.acquireRelease(acquire, (resource) => observeRelease(step, release(resource)));
}

type DatabaseReleaseStep = 'connection' | 'engine';

function observeRelease(step: DatabaseReleaseStep, release: Effect.Effect<void, DataEngineError>) {
  return observeStage(`workspace.close-database-${step}`, release).pipe(Effect.orDie);
}

/**
 * Acquires the runtime's database for the Layer's scope. Closing that scope runs the release steps
 * the acquisition registered, as one stage.
 */
export function workspaceDatabaseLayer(open: OpenWorkspaceDatabase) {
  return Layer.effect(WorkspaceDatabase, Effect.gen(function* () {
    const acquisition = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => observeStage('workspace.release-database', Scope.close(acquisition, exit).pipe(
      Effect.catchCause((cause) => Effect.die(new DatabaseReleaseError({ cause }))),
    )));
    return yield* observeStage('workspace.acquire-database', Scope.provide(open, acquisition));
  }));
}

/** An expected engine failure, classified at the runtime edge. The fixed message keeps driver details from users. */
export class DataEngineError extends Data.TaggedError('DataEngineError')<{ cause: unknown }> {
  override readonly message = engineFailureMessage;
}

/**
 * Classifies driver throws and rejections as DataEngineError at the runtime edge.
 * Interruption follows the connection contract above; a failed cancellation still waits for settlement.
 */
export function driverEffect<A>(
  operation: () => Promise<A>,
  cancel?: () => Promise<void>,
): Effect.Effect<A, DataEngineError> {
  const toEngineError = (cause: unknown) => new DataEngineError({ cause });
  if (!cancel) return Effect.uninterruptible(Effect.tryPromise({ try: operation, catch: toEngineError }));
  return Effect.callback<A, DataEngineError>((resume) => {
    let pending: Promise<A>;
    try {
      pending = operation();
    } catch (cause) {
      resume(Effect.fail(toEngineError(cause)));
      return;
    }
    pending.then(
      (value) => resume(Effect.succeed(value)),
      (cause) => resume(Effect.fail(toEngineError(cause))),
    );
    return driverEffect(cancel).pipe(
      Effect.ignore,
      Effect.ensuring(Effect.promise(() => pending.then(() => undefined, () => undefined))),
    );
  });
}
