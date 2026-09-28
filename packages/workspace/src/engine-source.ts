import { Effect } from 'effect';
import { attemptWorkspacePromise } from './errors';
import { observeCleanup } from './workspace-diagnostics';

/** Keeps an engine-readable reference until the enclosing scope closes. Release failure is cleanup. */
export function scopedEngineSource(acquire: () => Promise<string>, release: (reference: string) => Promise<void>) {
  return Effect.acquireRelease(
    attemptWorkspacePromise(acquire),
    (reference) => observeCleanup('csv.release-engine-source', attemptWorkspacePromise(() => release(reference))),
  );
}
