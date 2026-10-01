import { Effect } from 'effect';
import { observeCleanup } from './workspace-diagnostics';

/** Keeps an engine-readable reference until the enclosing scope closes. Release failure is cleanup. */
export function scopedEngineSource<E, R, E2, R2>(
  acquire: Effect.Effect<string, E, R>,
  release: (reference: string) => Effect.Effect<void, E2, R2>,
) {
  return Effect.acquireRelease(
    acquire,
    (reference) => observeCleanup('csv.release-engine-source', Effect.suspend(() => release(reference))),
  );
}
