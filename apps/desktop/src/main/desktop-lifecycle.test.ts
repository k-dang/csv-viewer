import type { ConfirmWorkspaceCloseOutcome, WorkspaceCloseImpact } from '@csv-viewer/workspace/csv-viewer';
import { ConfigProvider, Deferred, Effect, Exit, Fiber, Logger, Option, Queue } from 'effect';
import { TestClock, TestConsole } from 'effect/testing';
import { expect, it, vi } from '@effect/vitest';
import { DesktopLifecycle, devServerUrlConfig, observeDocumentOpen, recoverTypedFailure, runDesktopProgram, WindowWorkspace, type DesktopProgramEvent, type DocumentWorkspace } from './desktop-lifecycle';

const impact: WorkspaceCloseImpact = {
  workingCsvsWithUnexportedChanges: [{ workingCsvId: 'csv-1', sourceName: 'people.csv' }],
  dependentComparisons: [],
};

it.effect('shares one confirmation between window close and quit and allows a fresh request after cancellation', () => Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const answer = yield* Deferred.make<boolean>();
  const confirmClose = vi.fn(async (): Promise<ConfirmWorkspaceCloseOutcome> => ({ status: 'confirmation-required', impact }));
  const dispose = vi.fn(async () => {});
  const prompt = vi.fn(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(answer))));
  const lifecycle = new DesktopLifecycle({ confirmClose, dispose }, prompt, () => undefined);

  const close = yield* Effect.forkScoped(lifecycle.requestClose());
  yield* Deferred.await(entered);
  const quit = yield* Effect.forkScoped(lifecycle.requestClose(), { startImmediately: true });
  yield* Deferred.succeed(answer, false);
  expect(yield* Fiber.join(close)).toBe('cancelled');
  expect(yield* Fiber.join(quit)).toBe('cancelled');
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(dispose).not.toHaveBeenCalled();

  expect(yield* lifecycle.requestClose()).toBe('cancelled');
  expect(prompt).toHaveBeenCalledTimes(2);
}));

it.effect('rechecks a close impact that changed during the prompt, then disposes once', () => Effect.gen(function* () {
  const changed: WorkspaceCloseImpact = {
    ...impact,
    workingCsvsWithUnexportedChanges: [...impact.workingCsvsWithUnexportedChanges, { workingCsvId: 'csv-2', sourceName: 'other.csv' }],
  };
  const confirmClose = vi.fn(async (confirmed?: WorkspaceCloseImpact): Promise<ConfirmWorkspaceCloseOutcome> =>
    confirmed === changed ? { status: 'ready' } : { status: 'confirmation-required', impact: confirmed ? changed : impact });
  const dispose = vi.fn(async () => {});
  const prompt = vi.fn(() => Effect.succeed(true));
  const lifecycle = new DesktopLifecycle({ confirmClose, dispose }, prompt, () => undefined);

  expect(yield* lifecycle.requestClose()).toBe('disposed');
  expect(prompt.mock.calls).toEqual([[impact], [changed]]);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(yield* lifecycle.requestClose()).toBe('disposed');
  expect(confirmClose).toHaveBeenCalledTimes(3);
  expect(dispose).toHaveBeenCalledTimes(1);
}));

it.effect('settles every waiter after a prompt failure and permits retry', () => Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const answer = yield* Deferred.make<boolean, Error>();
  const failure = new Error('Prompt failed.');
  const lifecycle = new DesktopLifecycle({
    confirmClose: async () => ({ status: 'confirmation-required', impact }),
    dispose: async () => {},
  }, () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(answer))), () => undefined);
  const close = yield* Effect.forkScoped(lifecycle.requestClose());
  yield* Deferred.await(entered);
  const quit = yield* Effect.forkScoped(lifecycle.requestClose(), { startImmediately: true });
  yield* Deferred.fail(answer, failure);
  expect(yield* Fiber.await(close)).toEqual(Exit.fail(failure));
  expect(yield* Fiber.await(quit)).toEqual(Exit.fail(failure));
  expect(yield* Effect.exit(lifecycle.requestClose())).toEqual(Exit.fail(failure));
}));

it.effect('returns normally when disposal finishes before 60 seconds and force-exits after logging when it does not', () => Effect.gen(function* () {
  const watched = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
    Effect.provide(Logger.layer([Logger.consoleLogFmt])),
  );
  const releaseUnfinished = function* () {
    const lines = [...(yield* TestConsole.logLines), ...(yield* TestConsole.errorLines)].map(String);
    return lines.some((line) => line.includes('message=workspace.release-unfinished') && line.includes('outcome=failed'));
  };

  const entered = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const dispose = vi.fn(() => { entered.resolve(); return cleanup.promise; });
  const forceExit = vi.fn();
  const lifecycle = new DesktopLifecycle({
    confirmClose: async () => ({ status: 'ready' }), dispose,
  }, () => Effect.succeed(true), forceExit);
  const quit = yield* Effect.forkScoped(watched(lifecycle.requestClose()));
  yield* Effect.addFinalizer(() => Effect.sync(() => cleanup.resolve()));
  yield* Effect.promise(() => entered.promise);
  const second = yield* Effect.forkScoped(watched(lifecycle.requestClose()), { startImmediately: true });
  yield* TestClock.adjust('59 seconds');
  expect(quit.pollUnsafe()).toBeUndefined();
  expect(forceExit).not.toHaveBeenCalled();
  expect(yield* releaseUnfinished()).toBe(false);
  cleanup.resolve();
  expect(yield* Fiber.join(quit)).toBe('disposed');
  expect(yield* Fiber.join(second)).toBe('disposed');
  expect(dispose).toHaveBeenCalledTimes(1);
  yield* TestClock.adjust('1 minute');
  expect(forceExit).not.toHaveBeenCalled();
  expect(yield* releaseUnfinished()).toBe(false);

  const hungEntered = Promise.withResolvers<void>();
  const hungCleanup = Promise.withResolvers<void>();
  const hungDispose = vi.fn(() => { hungEntered.resolve(); return hungCleanup.promise; });
  const hungExit = vi.fn();
  const hung = new DesktopLifecycle({
    confirmClose: async () => ({ status: 'ready' }), dispose: hungDispose,
  }, () => Effect.succeed(true), hungExit);
  const waiting = yield* Effect.forkScoped(watched(hung.requestClose()));
  yield* Effect.addFinalizer(() => Effect.sync(() => hungCleanup.resolve()));
  yield* Effect.promise(() => hungEntered.promise);
  const alsoWaiting = yield* Effect.forkScoped(watched(hung.requestClose()), { startImmediately: true });
  yield* TestClock.adjust('1 minute');
  expect(yield* Fiber.join(waiting)).toBe('forced');
  expect(yield* Fiber.join(alsoWaiting)).toBe('forced');
  expect(hungExit.mock.calls).toEqual([[1]]);
  expect(hungDispose).toHaveBeenCalledTimes(1);
  expect(yield* releaseUnfinished()).toBe(true);
}));

it.effect('reports a failed disposal so quit can exit with failure', () => Effect.gen(function* () {
  const lifecycle = new DesktopLifecycle({
    confirmClose: async () => ({ status: 'ready' }),
    dispose: async () => { throw new Error('release failed'); },
  }, () => Effect.succeed(true), () => undefined);
  expect(yield* lifecycle.requestClose()).toBe('failed');
}));

function documentWorkspaces(events: string[], prompt: () => Effect.Effect<boolean, Error> = () => Effect.succeed(true)) {
  let opened = 0;
  return () => {
    const id = ++opened;
    events.push(`open ${id}`);
    const workspace: DocumentWorkspace['workspace'] = {
      publishIntent: () => undefined,
      confirmClose: async (confirmed?: WorkspaceCloseImpact): Promise<ConfirmWorkspaceCloseOutcome> =>
        confirmed ? { status: 'ready' } : { status: 'confirmation-required', impact },
      dispose: async () => { events.push(`dispose ${id}`); },
    };
    return Promise.resolve<DocumentWorkspace>({
      workspace,
      lifecycle: new DesktopLifecycle(workspace, () => prompt().pipe(Effect.tap((answer) => Effect.sync(() => events.push(`prompt ${id}: ${answer}`)))), () => undefined),
      detach: () => { events.push(`detach ${id}`); },
    });
  };
}

it('ends the previous document workspace before a reloaded document opens its own, without a prompt', async () => {
  const events: string[] = [];
  const window = new WindowWorkspace(documentWorkspaces(events));
  await window.replace();
  await window.replace();
  expect(events).toEqual(['open 1', 'detach 1', 'dispose 1', 'open 2']);
  expect(window.isOpen).toBe(true);
});

it('ends the workspace with the window, and a later window opens a fresh one', async () => {
  const events: string[] = [];
  const window = new WindowWorkspace(documentWorkspaces(events));
  await window.replace();
  await expect(Effect.runPromise(window.close())).resolves.toBe('disposed');
  expect(window.isOpen).toBe(false);
  expect(window.get()).toBeNull();
  await expect(Effect.runPromise(window.close())).resolves.toBe('disposed');
  await window.replace();
  expect(events).toEqual(['open 1', 'prompt 1: true', 'dispose 1', 'detach 1', 'open 2']);
});

it('keeps the workspace when the close prompt is cancelled', async () => {
  const events: string[] = [];
  const window = new WindowWorkspace(documentWorkspaces(events, () => Effect.succeed(false)));
  await window.replace();
  await expect(Effect.runPromise(window.close())).resolves.toBe('cancelled');
  expect(window.isOpen).toBe(true);
  expect(events).toEqual(['open 1', 'prompt 1: false']);
});

it.effect('reads the dev server URL from Config and treats a missing value as production', () => Effect.gen(function* () {
  const read = (env: Record<string, string>) => devServerUrlConfig.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );
  expect(Option.getOrUndefined(yield* read({ VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173' }))).toBe('http://127.0.0.1:5173');
  expect(Option.isNone(yield* read({}))).toBe(true);
}));

it.effect('interrupts startup when quit arrives and does not wait for acquisition to finish', () => Effect.gen(function* () {
  const events = yield* Queue.unbounded<DesktopProgramEvent>();
  const log: string[] = [];
  const program = yield* Effect.forkChild(runDesktopProgram({
    events,
    prepareQuit: Effect.sync(() => { log.push('prepare-quit'); }),
    startup: Effect.scoped(Effect.gen(function* () {
      log.push('startup');
      yield* Effect.addFinalizer(() => Effect.sync(() => { log.push('startup-finalizer'); }));
      yield* Effect.sleep('1 hour');
      log.push('acquired');
    })),
    openWindow: Effect.void,
    close: Effect.sync(() => {
      log.push('close');
      return 'disposed' as const;
    }),
    dropRenderer: Effect.void,
    onClose: () => Effect.void,
    onCloseFailure: Effect.void,
  }));

  yield* TestClock.adjust('1 second');
  expect(log).toEqual(['startup']);
  yield* Queue.offer(events, { _tag: 'quit' });
  expect(yield* Fiber.join(program)).toBe('disposed');
  expect(log).toEqual(['startup', 'prepare-quit', 'startup-finalizer', 'close']);
  yield* TestClock.adjust('2 hours');
  expect(log).not.toContain('acquired');
}));

it.effect('drops the workspace when the renderer is gone', () => Effect.gen(function* () {
  const events = yield* Queue.unbounded<DesktopProgramEvent>();
  let dropped = 0;
  const program = yield* Effect.forkChild(runDesktopProgram({
    events,
    prepareQuit: Effect.void,
    startup: Effect.never,
    openWindow: Effect.void,
    close: Effect.succeed('disposed'),
    dropRenderer: Effect.sync(() => { dropped += 1; }),
    onClose: () => Effect.void,
    onCloseFailure: Effect.void,
  }));
  yield* Queue.offer(events, { _tag: 'renderer-gone' });
  yield* Queue.offer(events, { _tag: 'quit' });
  expect(yield* Fiber.join(program)).toBe('disposed');
  expect(dropped).toBe(1);
}));

it('interrupts workspace acquisition when quit arrives while it is opening', async () => {
  const events: string[] = [];
  const started = Promise.withResolvers<void>();
  const window = new WindowWorkspace((signal) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    events.push('acquire');
    yield* Effect.addFinalizer(() => Effect.sync(() => { events.push('finalizer'); }));
    yield* Effect.sync(() => { started.resolve(); });
    // SAFETY: quit interrupts this effect before a workspace value exists.
    return yield* Effect.never as Effect.Effect<DocumentWorkspace>;
  })), { signal }));
  const opening = window.replace();
  await started.promise;
  await expect(Effect.runPromise(window.close())).resolves.toBe('disposed');
  expect(events).toEqual(['acquire', 'finalizer']);
  await expect(opening).rejects.toThrow();
  expect(window.isOpen).toBe(false);
});

it('drops an open workspace without a prompt when the renderer is gone', async () => {
  const events: string[] = [];
  const window = new WindowWorkspace(documentWorkspaces(events));
  await window.replace();
  await Effect.runPromise(window.drop());
  expect(events).toEqual(['open 1', 'detach 1', 'dispose 1']);
  expect(window.isOpen).toBe(false);
});

it.effect('quits during an in-flight open by disposing it and does not exit 1', () => Effect.gen(function* () {
  const exit = vi.fn();
  const events = yield* Queue.unbounded<DesktopProgramEvent>();
  const log: string[] = [];
  const started = Promise.withResolvers<void>();
  const window = new WindowWorkspace((signal) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    log.push('acquire');
    yield* Effect.addFinalizer(() => Effect.sync(() => { log.push('dispose'); }));
    started.resolve();
    // SAFETY: quit aborts this open before a workspace exists.
    return yield* Effect.never as Effect.Effect<DocumentWorkspace>;
  })), { signal }));

  const program = yield* Effect.forkChild(runDesktopProgram({
    events,
    prepareQuit: Effect.sync(() => { log.push('prepare-quit'); }),
    startup: recoverTypedFailure(Effect.gen(function* () {
      log.push('startup');
      const opening = window.replace();
      observeDocumentOpen(opening, () => {
        log.push('navigation-exit');
        exit(1);
      });
      yield* Effect.promise(() => started.promise);
      yield* Effect.never;
    }), () => {
      log.push('startup-exit');
      exit(1);
    }),
    openWindow: recoverTypedFailure(Effect.void, () => { exit(1); }),
    close: window.close().pipe(Effect.tap((outcome) => Effect.sync(() => { log.push(`close:${outcome}`); }))),
    dropRenderer: Effect.void,
    onClose: () => Effect.void,
    onCloseFailure: Effect.sync(() => { log.push('close-failed'); }),
  }));

  yield* Effect.promise(() => started.promise);
  yield* Queue.offer(events, { _tag: 'quit' });
  expect(yield* Fiber.join(program)).toBe('disposed');
  expect(log).toContain('dispose');
  expect(log).not.toContain('close-failed');
  expect(log).not.toContain('navigation-exit');
  expect(log).not.toContain('startup-exit');
  expect(exit).not.toHaveBeenCalled();
}));

it.effect('a loadFile ERR_ABORTED does not invoke the startup failure exit', () => Effect.gen(function* () {
  const exit = vi.fn();
  const events = yield* Queue.unbounded<DesktopProgramEvent>();
  const log: string[] = [];
  const started = Promise.withResolvers<void>();
  const startupSettled = yield* Deferred.make<void>();
  const aborted = new Error("ERR_ABORTED (-3) loading 'file:///workspace/apps/desktop/dist-renderer/index.html'");
  const window = new WindowWorkspace((signal) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    log.push('acquire');
    yield* Effect.addFinalizer(() => Effect.sync(() => { log.push('dispose'); }));
    started.resolve();
    // SAFETY: quit aborts this open before a workspace exists.
    return yield* Effect.never as Effect.Effect<DocumentWorkspace>;
  })), { signal }));
  yield* Effect.addFinalizer(() => window.close().pipe(Effect.ignore));

  const program = yield* Effect.forkChild(runDesktopProgram({
    events,
    prepareQuit: Effect.sync(() => { log.push('prepare-quit'); }),
    startup: recoverTypedFailure(Effect.gen(function* () {
      log.push('startup');
      const opening = window.replace();
      observeDocumentOpen(opening, () => {
        log.push('navigation-exit');
        exit(1);
      });
      yield* Effect.promise(() => started.promise);
      return yield* Effect.fail(aborted);
    }), () => {
      log.push('CSV Viewer failed to start.');
      exit(1);
    }).pipe(Effect.ensuring(Deferred.succeed(startupSettled, undefined))),
    openWindow: Effect.void,
    close: window.close().pipe(Effect.tap((outcome) => Effect.sync(() => { log.push(`close:${outcome}`); }))),
    dropRenderer: Effect.void,
    onClose: (outcome) => Effect.sync(() => { log.push(`quit:${outcome}`); }),
    onCloseFailure: Effect.sync(() => { log.push('close-failed'); }),
  }));

  yield* Deferred.await(startupSettled);
  expect(log).not.toContain('CSV Viewer failed to start.');
  expect(exit).not.toHaveBeenCalled();

  yield* Queue.offer(events, { _tag: 'quit' });
  expect(yield* Fiber.join(program)).toBe('disposed');
  expect(log).toContain('dispose');
  expect(log).toContain('prepare-quit');
  expect(log).toContain('quit:disposed');
  expect(log).not.toContain('navigation-exit');
  expect(log).not.toContain('close-failed');
  expect(exit).not.toHaveBeenCalled();
}));

it.effect('a real document load failure still invokes the startup failure exit', () => Effect.gen(function* () {
  const exit = vi.fn();
  const missing = new Error("ERR_FILE_NOT_FOUND (-6) loading 'file:///workspace/apps/desktop/dist-renderer/index.html'");
  yield* recoverTypedFailure(Effect.fail(missing), () => { exit(1); });
  expect(exit.mock.calls).toEqual([[1]]);
}));

it('waits for a workspace that is still opening when quit arrives, then disposes it', async () => {
  const events: string[] = [];
  const opening = Promise.withResolvers<void>();
  const open = documentWorkspaces(events);
  const window = new WindowWorkspace(async () => {
    await opening.promise;
    return open();
  });
  void window.replace();
  const quit = Effect.runPromise(window.close());
  expect(events).toEqual([]);
  opening.resolve();
  await expect(quit).resolves.toBe('disposed');
  expect(events).toEqual(['open 1', 'prompt 1: true', 'dispose 1', 'detach 1']);
  expect(window.isOpen).toBe(false);
});

it.effect('force-exits when an aborted open does not finish releasing', () => Effect.gen(function* () {
  const watched = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
    Effect.provide(Logger.layer([Logger.consoleLogFmt])),
  );
  const forceExit = vi.fn();
  const started = Promise.withResolvers<void>();
  const window = new WindowWorkspace(() => {
    started.resolve();
    return new Promise<DocumentWorkspace>(() => undefined);
  }, forceExit);
  void window.replace();
  yield* Effect.promise(() => started.promise);
  const quitting = yield* Effect.forkScoped(watched(window.close()));
  yield* Effect.yieldNow;
  yield* TestClock.adjust('59 seconds');
  expect(quitting.pollUnsafe()).toBeUndefined();
  expect(forceExit).not.toHaveBeenCalled();
  yield* TestClock.adjust('1 second');
  expect(yield* Fiber.join(quitting)).toBe('forced');
  expect(forceExit.mock.calls).toEqual([[1]]);
  const lines = [...(yield* TestConsole.logLines), ...(yield* TestConsole.errorLines)].map(String);
  expect(lines.some((line) => line.includes('message=workspace.release-unfinished') && line.includes('outcome=failed'))).toBe(true);
}));

it('fails when releasing an open workspace fails after the renderer is gone, and quit can still see it', async () => {
  const dispose = vi.fn(async () => { throw new Error('release failed'); });
  const workspace: DocumentWorkspace['workspace'] = {
    publishIntent: () => undefined,
    confirmClose: async () => ({ status: 'ready' }),
    dispose,
  };
  const window = new WindowWorkspace(async () => ({
    workspace,
    lifecycle: new DesktopLifecycle(workspace, () => Effect.succeed(true), () => undefined),
    detach: () => undefined,
  }));
  await window.replace();
  await expect(Effect.runPromise(window.drop())).rejects.toThrow('CSV Viewer could not release the workspace.');
  expect(dispose).toHaveBeenCalledOnce();
  expect(window.isOpen).toBe(true);
});
