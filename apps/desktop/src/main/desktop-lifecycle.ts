import type { CsvWorkspaceOwner } from '@csv-viewer/workspace/csv-workspace';
import type { WorkspaceCloseImpact } from '@csv-viewer/workspace/csv-viewer';
import { toError } from '@csv-viewer/workspace/errors';
import { Deferred, Effect, Exit } from 'effect';

/** Coordinates window close and app quit; Electron owns the event callbacks and process exit. */
export class DesktopLifecycle {
  private confirmation: Deferred.Deferred<boolean, Error> | null = null;
  private authorizedImpact: WorkspaceCloseImpact | undefined;
  private quitting = false;
  private disposed = false;

  constructor(
    private readonly workspace: Pick<CsvWorkspaceOwner, 'confirmClose' | 'dispose'>,
    private readonly prompt: (impact: WorkspaceCloseImpact) => Effect.Effect<boolean, Error>,
  ) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  readonly requestWindowClose = (): Effect.Effect<boolean, Error> => this.confirmClose();

  /** One quit owns confirmation and disposal. A cancelled or failed confirmation permits another quit. */
  readonly requestQuit = Effect.fnUntraced(function* (
    this: DesktopLifecycle,
  ): Effect.fn.Return<'cancelled' | 'disposed' | 'failed', Error> {
    if (this.disposed) return 'disposed';
    if (this.quitting) return 'cancelled';
    this.quitting = true;
    return yield* Effect.gen({ self: this }, function* () {
      if (!(yield* this.confirmClose(this.authorizedImpact))) return 'cancelled' as const;
      // Disposal is memoized by the workspace. Wait at most twenty seconds without interrupting
      // its cleanup or retrying the same Promise.
      const released = yield* Effect.exit(Effect.tryPromise({
        try: () => this.workspace.dispose(), catch: toError,
      }).pipe(Effect.timeout('20 seconds')));
      if (Exit.isFailure(released)) return 'failed' as const;
      this.disposed = true;
      return 'disposed' as const;
    }).pipe(Effect.ensuring(Effect.sync(() => { this.quitting = false; })));
  });

  /** Concurrent window/quit requests share the full confirmation, including impact rechecks. */
  private readonly confirmClose = Effect.fnUntraced(function* (
    this: DesktopLifecycle,
    confirmedImpact?: WorkspaceCloseImpact,
  ): Effect.fn.Return<boolean, Error> {
    if (this.confirmation) return yield* Deferred.await(this.confirmation);
    const confirmation = yield* Deferred.make<boolean, Error>();
    this.confirmation = confirmation;
    return yield* Effect.gen({ self: this }, function* () {
      let result = yield* Effect.tryPromise({
        try: () => this.workspace.confirmClose(confirmedImpact), catch: toError,
      });
      while (result.status === 'confirmation-required') {
        const impact = result.impact;
        if (!(yield* this.prompt(impact))) return false;
        result = yield* Effect.tryPromise({
          try: () => this.workspace.confirmClose(impact), catch: toError,
        });
        if (result.status === 'ready') this.authorizedImpact = impact;
      }
      return true;
    }).pipe(
      Effect.onExit((exit) => Deferred.done(confirmation, exit)),
      Effect.ensuring(Effect.sync(() => { this.confirmation = null; })),
    );
  });
}
