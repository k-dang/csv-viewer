import type { CsvWorkspaceServer } from '@csv-viewer/workspace/csv-workspace';
import type { WorkspaceCloseImpact } from '@csv-viewer/workspace/csv-viewer';
import { toError } from '@csv-viewer/workspace/errors';
import { Cause, Config, Deferred, Effect, Exit, FiberSet, Queue } from 'effect';

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
      return yield* this.releaseWorkspace();
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
   * `dispose()` runs on a detached uninterruptible fiber. One 60 second timer bounds the wait.
   * When release is still running, log `workspace.release-unfinished`, then force-exit.
   * The release Promise stays observed until it settles or the process exits.
   */
  readonly releaseWorkspace = Effect.fnUntraced(function* (
    this: DesktopLifecycle,
  ): Effect.fn.Return<'disposed' | 'failed' | 'forced'> {
    if (this.disposed) return 'disposed';
    const waited = yield* awaitWithinReleaseBound(() => this.workspace.dispose(), this.forceExit);
    if (waited._tag === 'forced') return 'forced';
    if (waited._tag === 'failed') return 'failed';
    this.disposed = true;
    return 'disposed';
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
 * the main process. Quit aborts an open that observes the signal. The wait for that open, including
 * its acquisition release, uses the same 60 second bound as workspace release.
 */
export class WindowWorkspace {
  private current: Promise<DocumentWorkspace> | null = null;
  private opening: AbortController | null = null;
  /** Set before take() yields, so a second close or a quit joins this confirmation. */
  private activeClose: Deferred.Deferred<CloseOutcome, Error> | null = null;

  constructor(
    private readonly open: (signal: AbortSignal) => Promise<DocumentWorkspace>,
    private readonly forceExit: (code: number) => void = () => undefined,
  ) {}

  get isOpen(): boolean {
    return this.current !== null;
  }

  /** The current document's workspace, or null once it closed. */
  get(): Promise<DocumentWorkspace> | null {
    return this.current;
  }

  /** The previous document's renderer state is already gone, so its workspace ends without a prompt. */
  replace(): Promise<DocumentWorkspace> & { readonly signal: AbortSignal } {
    const previous = this.current;
    const controller = new AbortController();
    this.opening = controller;
    // The workspace reports its own release failure; the new document still gets a workspace.
    const ended = previous ? previous.then(endWithoutPrompt).catch(() => undefined) : Promise.resolve();
    const next = ended.then(() => this.open(controller.signal));
    this.current = next;
    return Object.assign(next, { signal: controller.signal });
  }

  /**
   * The close already waiting on a confirmation. A quit that arrives while it is showing must use
   * this, including after the answer, or it starts a second prompt.
   */
  inFlightClose(): Effect.Effect<CloseOutcome, Error> | null {
    const activeClose = this.activeClose;
    return activeClose ? Deferred.await(activeClose) : null;
  }

  /** Confirms and disposes the current workspace. With none open there is nothing to confirm. */
  readonly close = Effect.fnUntraced(function* (
    this: WindowWorkspace,
  ): Effect.fn.Return<CloseOutcome, Error> {
    // Publish the shared close before the first yield. take() waits asynchronously, and an answer
    // during that wait used to let the next close or quit prompt again.
    if (this.activeClose) return yield* Deferred.await(this.activeClose);
    const activeClose = Deferred.makeUnsafe<CloseOutcome, Error>();
    this.activeClose = activeClose;
    return yield* Effect.gen({ self: this }, function* () {
      const taken = yield* this.take();
      switch (taken._tag) {
        case 'empty':
        case 'aborted':
          return 'disposed' as const;
        case 'forced':
          return 'forced' as const;
        case 'opened': {
          const outcome = yield* taken.owned.lifecycle.requestClose();
          if (outcome === 'disposed' && this.current === taken.closing) {
            taken.owned.detach();
            this.current = null;
          }
          return outcome;
        }
        default: {
          const unexpected: never = taken;
          return unexpected;
        }
      }
    }).pipe(
      Effect.onExit((exit) => Deferred.done(activeClose, exit)),
      Effect.ensuring(Effect.sync(() => {
        if (this.activeClose === activeClose) this.activeClose = null;
      })),
    );
  });

  /** The renderer is gone. End its workspace without a prompt, and do not open another. */
  readonly drop = Effect.fnUntraced(function* (this: WindowWorkspace): Effect.fn.Return<void, Error> {
    const taken = yield* this.take();
    switch (taken._tag) {
      case 'empty':
      case 'aborted':
      case 'forced':
        return;
      case 'opened': {
        taken.owned.detach();
        const released = yield* taken.owned.lifecycle.releaseWorkspace();
        if (released === 'failed') {
          return yield* Effect.fail(new Error('CSV Viewer could not release the workspace.'));
        }
        if (this.current === taken.closing) this.current = null;
        return;
      }
      default: {
        const unexpected: never = taken;
        return unexpected;
      }
    }
  });

  /**
   * Aborts the controller that belongs to the current open. A rejection before a workspace exists
   * is an empty open. A workspace that exists is returned for release.
   */
  private readonly take = Effect.fnUntraced(function* (
    this: WindowWorkspace,
  ): Effect.fn.Return<TakenOpen, Error> {
    const closing = this.current;
    if (!closing) return { _tag: 'empty' };
    const opening = this.opening;
    const settled = settleOpen(closing);
    opening?.abort();
    const waited = yield* awaitWithinReleaseBound(() => settled, this.forceExit);
    if (waited._tag === 'forced') {
      if (this.current === closing) this.current = null;
      return { _tag: 'forced' };
    }
    if (waited._tag === 'failed') return yield* Effect.fail(waited.cause);
    const settlement = waited.value;
    if (settlement._tag === 'rejected') {
      if (opening?.signal.aborted) {
        if (this.current === closing) this.current = null;
        return { _tag: 'aborted' };
      }
      return yield* Effect.fail(toError(settlement.cause));
    }
    return { _tag: 'opened', closing, owned: settlement.workspace };
  });
}

function endWithoutPrompt({ workspace, detach }: DocumentWorkspace): Promise<void> {
  detach();
  return workspace.dispose();
}

type ReleaseWait<A> =
  | { readonly _tag: 'value'; readonly value: A }
  | { readonly _tag: 'failed'; readonly cause: Error }
  | { readonly _tag: 'forced' };

type OpenSettlement =
  | { readonly _tag: 'opened'; readonly workspace: DocumentWorkspace }
  | { readonly _tag: 'rejected'; readonly cause: unknown };

type TakenOpen =
  | { readonly _tag: 'empty' }
  | { readonly _tag: 'aborted' }
  | { readonly _tag: 'forced' }
  | { readonly _tag: 'opened'; readonly closing: Promise<DocumentWorkspace>; readonly owned: DocumentWorkspace };

/** One 60 second wait. A release that is still running is logged, then force-exits. */
function awaitWithinReleaseBound<A>(
  start: () => Promise<A>,
  forceExit: (code: number) => void,
): Effect.Effect<ReleaseWait<A>> {
  return Effect.gen(function* () {
    const settled = yield* Deferred.make<A, Error>();
    yield* Effect.forkDetach(Effect.uninterruptible(Effect.gen(function* () {
      const exit = yield* Effect.exit(Effect.tryPromise({ try: start, catch: toError }));
      if (Exit.isSuccess(exit)) yield* Deferred.succeed(settled, exit.value);
      else yield* Deferred.fail(settled, toError(Cause.squash(exit.cause)));
    })));
    const waited = yield* Effect.exit(Deferred.await(settled).pipe(Effect.timeout(workspaceReleaseBound)));
    if (Exit.isSuccess(waited)) return { _tag: 'value', value: waited.value };
    if (isTimeoutCause(waited.cause)) {
      yield* Effect.logInfo('workspace.release-unfinished').pipe(
        Effect.annotateLogs({ outcome: 'failed' }),
      );
      yield* Effect.sync(() => { forceExit(1); });
      return { _tag: 'forced' };
    }
    return { _tag: 'failed', cause: toError(Cause.squash(waited.cause)) };
  });
}

function settleOpen(opening: Promise<DocumentWorkspace>): Promise<OpenSettlement> {
  return opening.then(
    (workspace) => ({ _tag: 'opened', workspace }),
    (cause: unknown) => ({ _tag: 'rejected', cause }),
  );
}

/** Recovers typed failures. An interrupt fails again so quit can close. A superseded document load does not. */
export function recoverTypedFailure<E, R>(
  effect: Effect.Effect<void, E, R>,
  onFailure: () => void,
): Effect.Effect<void, never, R> {
  return effect.pipe(Effect.catchCause((cause) => {
    if (Cause.hasInterrupts(cause)) {
      // SAFETY: Interrupt reasons carry no typed error. Re-failing the cause keeps the fiber's error channel empty.
      return Effect.failCause(cause as Cause.Cause<never>);
    }
    if (isSupersededDocumentLoad(Cause.squash(cause))) return Effect.void;
    return Effect.sync(onFailure);
  }));
}

/** Electron rejects an in-flight loadFile or loadURL with a message that starts with ERR_ABORTED. */
function isSupersededDocumentLoad(cause: unknown): boolean {
  return cause instanceof Error && cause.message.startsWith('ERR_ABORTED');
}

/** The open started by document navigation. An aborted signal is quit or a gone renderer, not a process failure. */
export function observeDocumentOpen(
  opening: Promise<unknown> & { readonly signal: AbortSignal },
  onFailure: () => void,
): void {
  opening.catch(() => {
    if (opening.signal.aborted) return;
    onFailure();
  });
}
