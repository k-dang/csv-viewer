import type { CsvWorkspaceServer } from '@csv-viewer/workspace/csv-workspace';
import type { WorkspaceCloseImpact } from '@csv-viewer/workspace/csv-viewer';
import { toError } from '@csv-viewer/workspace/errors';
import { Cause, Config, Deferred, Effect, Exit, Fiber, FiberSet, Logger, Queue } from 'effect';

export type CloseOutcome = 'cancelled' | 'disposed' | 'failed' | 'forced';

/** Development sets this to the renderer server. A packaged app leaves it unset. */
export const devServerUrlConfig = Config.option(Config.String('VITE_DEV_SERVER_URL'));

/** Quit logs and force-exits when workspace release is still running after this long. */
const workspaceReleaseBound = '60 seconds';

export type DesktopProgramEvent =
  | { readonly _tag: 'quit' }
  | { readonly _tag: 'renderer-gone' }
  | { readonly _tag: 'activate' };

export interface DesktopProgram {
  readonly events: Queue.Dequeue<DesktopProgramEvent>;
  /** Runs before startup is interrupted, so a late document load cannot open a workspace. */
  readonly prepareQuit: Effect.Effect<void>;
  readonly startup: Effect.Effect<void>;
  readonly openWindow: Effect.Effect<void>;
  readonly close: Effect.Effect<CloseOutcome, Error>;
  readonly dropRenderer: Effect.Effect<void, Error>;
  readonly onClose: (outcome: CloseOutcome) => Effect.Effect<void>;
  readonly onCloseFailure: Effect.Effect<void>;
}

/** Ends one document's workspace: confirms its close impact, then disposes it. */
export class DesktopLifecycle {
  private closing: Deferred.Deferred<CloseOutcome, Error> | null = null;
  private disposed = false;

  constructor(
    private readonly workspace: Pick<CsvWorkspaceServer, 'confirmClose' | 'dispose'>,
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
      const released = yield* this.releaseWorkspace();
      if (released === 'disposed') this.disposed = true;
      return released;
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

  /**
   * `dispose()` runs detached and uninterruptible. The 60 second bound times out only the wait,
   * and a second watchdog force-exits if that wait never resumes. The release Promise stays
   * observed until it settles or the process exits.
   */
  private readonly releaseWorkspace = Effect.fnUntraced(function* (
    this: DesktopLifecycle,
  ): Effect.fn.Return<'disposed' | 'failed' | 'forced', Error> {
    const settled = yield* Deferred.make<void, Error>();
    const releaseState = { forced: false };
    yield* Effect.forkDetach(Effect.uninterruptible(
      Effect.tryPromise({
        try: () => this.workspace.dispose(),
        catch: toError,
      }).pipe(
        Effect.exit,
        Effect.flatMap((exit) => Exit.isSuccess(exit)
          ? Deferred.succeed(settled, undefined)
          : Deferred.fail(settled, toError(Cause.squash(exit.cause)))),
      ),
    ));
    const forceExit = () => {
      if (releaseState.forced) return;
      releaseState.forced = true;
      this.forceExit(1);
    };
    const watchdog = yield* Effect.forkChild(Effect.sleep(workspaceReleaseBound).pipe(
      Effect.andThen(Effect.sync(forceExit)),
    ));
    const waited = yield* Effect.exit(Deferred.await(settled).pipe(
      Effect.timeout(workspaceReleaseBound),
    ));
    yield* Fiber.interrupt(watchdog);
    if (Exit.isSuccess(waited)) return 'disposed' as const;
    if (isTimeoutCause(waited.cause)) {
      yield* Effect.logInfo('workspace.release-unfinished').pipe(
        Effect.annotateLogs({ outcome: 'failed' }),
      );
      yield* Effect.sync(forceExit);
      return 'forced' as const;
    }
    return 'failed' as const;
  });
}

/**
 * One main-process program. Callers register quit before invoking it. Quit interrupts startup,
 * then closes the workspace. A renderer crash drops that workspace without a prompt.
 */
export const runDesktopProgram = (input: DesktopProgram) => Effect.scoped(Effect.gen(function* () {
  const work = yield* FiberSet.make<void, never>();
  yield* FiberSet.run(work, input.startup);
  let quitting = false;
  while (true) {
    const event = yield* Queue.take(input.events);
    switch (event._tag) {
      case 'quit': {
        if (quitting) break;
        quitting = true;
        yield* input.prepareQuit;
        yield* FiberSet.clear(work);
        const closed = yield* Effect.exit(input.close);
        if (Exit.isFailure(closed)) {
          quitting = false;
          yield* input.onCloseFailure;
          break;
        }
        yield* input.onClose(closed.value);
        if (closed.value === 'cancelled') {
          quitting = false;
          break;
        }
        return closed.value;
      }
      case 'renderer-gone': {
        const dropped = yield* Effect.exit(input.dropRenderer);
        if (Exit.isFailure(dropped)) yield* input.onCloseFailure;
        break;
      }
      case 'activate': {
        if (!quitting) yield* FiberSet.run(work, input.openWindow);
        break;
      }
      default: {
        const unexpected: never = event;
        return unexpected;
      }
    }
  }
}));

function isTimeoutCause(cause: Cause.Cause<unknown>): boolean {
  return cause.reasons.some((reason) => reason._tag === 'Fail' && Cause.isTimeoutError(reason.error));
}

export type DocumentWorkspace = {
  readonly workspace: Pick<CsvWorkspaceServer, 'confirmClose' | 'dispose' | 'publishIntent'>;
  readonly lifecycle: DesktopLifecycle;
  /** Stops forwarding workspace events to the document. */
  readonly detach: () => void;
};

/**
 * The workspace that the window's current document owns. Loading a new document disposes the
 * previous document's workspace before opening its own, so a renderer reload also starts empty in
 * the main process. Quit aborts an open that observes the signal. An open that does not is
 * disposed once it finishes.
 */
export class WindowWorkspace {
  private current: Promise<DocumentWorkspace> | null = null;
  private opening: AbortController | null = null;

  constructor(private readonly open: (signal: AbortSignal) => Promise<DocumentWorkspace>) {}

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
    const controller = new AbortController();
    this.opening = controller;
    // The workspace reports its own release failure; the new document still gets a workspace.
    const ended = previous ? previous.then(endWithoutPrompt).catch(() => undefined) : Promise.resolve();
    const next = ended.then(() => this.open(controller.signal));
    this.current = next;
    return next;
  }

  /** Confirms and disposes the current workspace. With none open there is nothing to confirm. */
  async close(): Promise<CloseOutcome> {
    const closing = this.current;
    if (!closing) return 'disposed';
    this.opening?.abort();
    let owned: DocumentWorkspace;
    try {
      owned = await closing;
    } catch (cause) {
      if (this.opening?.signal.aborted) {
        if (this.current === closing) this.current = null;
        return 'disposed';
      }
      throw toError(cause);
    }
    const outcome = await Effect.runPromise(owned.lifecycle.requestClose().pipe(
      Effect.provide(Logger.layer([Logger.consoleLogFmt])),
    ));
    if (outcome === 'disposed' && this.current === closing) {
      owned.detach();
      this.current = null;
    }
    return outcome;
  }

  /** The renderer is gone. End its workspace without a prompt, and do not open another. */
  async drop(): Promise<void> {
    const closing = this.current;
    if (!closing) return;
    this.opening?.abort();
    if (this.current === closing) this.current = null;
    try {
      await endWithoutPrompt(await closing);
    } catch (cause) {
      if (this.opening?.signal.aborted) return;
      throw cause;
    }
  }
}

function endWithoutPrompt({ workspace, detach }: DocumentWorkspace): Promise<void> {
  detach();
  return workspace.dispose();
}
