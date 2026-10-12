import type { CsvWorkspaceOwner } from '@csv-viewer/workspace/csv-workspace';
import type { WorkspaceCloseImpact } from '@csv-viewer/workspace/csv-viewer';
import { toError } from '@csv-viewer/workspace/errors';
import { Deferred, Effect, Exit, Logger } from 'effect';

export type CloseOutcome = 'cancelled' | 'disposed' | 'failed' | 'forced';

/** Ends one document's workspace: confirms its close impact, then disposes it. */
export class DesktopLifecycle {
  private closing: Deferred.Deferred<CloseOutcome, Error> | null = null;
  private disposed = false;

  constructor(
    private readonly workspace: Pick<CsvWorkspaceOwner, 'confirmClose' | 'dispose'>,
    private readonly prompt: (impact: WorkspaceCloseImpact) => Effect.Effect<boolean, Error>,
    private readonly forceExit: (code: number) => void,
  ) {}

  /** Window close and quit share one request. A cancelled or failed request permits another. */
  readonly requestClose = Effect.fnUntraced(function* (
    this: DesktopLifecycle,
  ): Effect.fn.Return<CloseOutcome, Error> {
    if (this.disposed) return 'disposed';
    if (this.closing) return yield* Deferred.await(this.closing);
    const closing = yield* Deferred.make<CloseOutcome, Error>();
    this.closing = closing;
    return yield* Effect.gen({ self: this }, function* () {
      if (!(yield* this.confirmClose())) return 'cancelled' as const;
      // Interrupting this wait does not cancel dispose(). The release keeps running until the process exits.
      const released = yield* Effect.exit(Effect.tryPromise({
        try: () => this.workspace.dispose(), catch: toError,
      }).pipe(
        Effect.as('disposed' as const),
        Effect.timeoutOrElse({
          duration: '60 seconds',
          orElse: () => Effect.logInfo('workspace.release-unfinished').pipe(
            Effect.annotateLogs({ outcome: 'failed' }),
            Effect.andThen(Effect.sync(() => this.forceExit(1))),
            Effect.as('forced' as const),
          ),
        }),
      ));
      if (Exit.isFailure(released)) return 'failed' as const;
      if (released.value === 'disposed') this.disposed = true;
      return released.value;
    }).pipe(
      Effect.onExit((exit) => Deferred.done(closing, exit)),
      Effect.ensuring(Effect.sync(() => { this.closing = null; })),
    );
  });

  /** Rechecks the impact after every prompt, so a change made meanwhile is confirmed too. */
  private readonly confirmClose = Effect.fnUntraced(function* (
    this: DesktopLifecycle,
  ): Effect.fn.Return<boolean, Error> {
    let result = yield* Effect.tryPromise({ try: () => this.workspace.confirmClose(), catch: toError });
    while (result.status === 'confirmation-required') {
      const impact = result.impact;
      if (!(yield* this.prompt(impact))) return false;
      result = yield* Effect.tryPromise({ try: () => this.workspace.confirmClose(impact), catch: toError });
    }
    return true;
  });
}

export type DocumentWorkspace = {
  readonly workspace: Pick<CsvWorkspaceOwner, 'receive' | 'confirmClose' | 'dispose'>;
  readonly lifecycle: DesktopLifecycle;
  /** Stops forwarding workspace events to the document. */
  readonly detach: () => void;
};

/**
 * The workspace that the window's current document owns. Loading a new document disposes the
 * previous document's workspace before opening its own, so a renderer reload also starts empty in
 * the main process. Closing ends it; requests wait for a workspace that is still opening.
 */
export class WindowWorkspace {
  private current: Promise<DocumentWorkspace> | null = null;

  constructor(private readonly open: () => Promise<DocumentWorkspace>) {}

  get isOpen(): boolean {
    return this.current !== null;
  }

  /** The current document's workspace, or null once it closed. */
  get(): Promise<DocumentWorkspace> | null {
    return this.current;
  }

  /** The previous document's renderer state is already gone, so its workspace ends without a prompt. */
  replace(): Promise<DocumentWorkspace> {
    const previous = this.current;
    // The workspace reports its own release failure; the new document still gets a workspace.
    const ended = previous ? previous.then(endWithoutPrompt).catch(() => undefined) : Promise.resolve();
    const next = ended.then(this.open);
    this.current = next;
    return next;
  }

  /** Confirms and disposes the current workspace. With none open there is nothing to confirm. */
  async close(): Promise<CloseOutcome> {
    const closing = this.current;
    if (!closing) return 'disposed';
    const owned = await closing;
    const outcome = await Effect.runPromise(owned.lifecycle.requestClose().pipe(
      Effect.provide(Logger.layer([Logger.consoleLogFmt])),
    ));
    if (outcome === 'disposed' && this.current === closing) {
      owned.detach();
      this.current = null;
    }
    return outcome;
  }
}

function endWithoutPrompt({ workspace, detach }: DocumentWorkspace): Promise<void> {
  detach();
  return workspace.dispose();
}
