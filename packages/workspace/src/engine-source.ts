import { Effect, Exit } from 'effect';
import { attemptWorkspacePromise } from './errors';
import { markCleanupFailed, observeStage, recordOutcome } from './workspace-diagnostics';

/** Keeps an engine-readable reference until the enclosing scope closes. Release failure is cleanup. */
export function scopedEngineSource(acquire: () => Promise<string>, release: (reference: string) => Promise<void>) {
  return Effect.acquireRelease(
    attemptWorkspacePromise(acquire),
    (reference) => reportEngineSourceRelease(() => release(reference)),
  );
}

export function reportEngineSourceRelease(release: () => Promise<void>) {
  return observeStage('csv.release-engine-source', Effect.gen(function* () {
    const result = yield* Effect.exit(attemptWorkspacePromise(release));
    if (Exit.isFailure(result)) {
      yield* recordOutcome('cleanup-failed', result.cause, 'cleanup-failed');
      yield* markCleanupFailed;
    } else {
      yield* recordOutcome('succeeded', undefined, 'succeeded');
    }
  }));
}
