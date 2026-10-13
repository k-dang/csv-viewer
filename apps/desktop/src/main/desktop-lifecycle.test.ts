import type { ConfirmWorkspaceCloseOutcome, WorkspaceCloseImpact } from '@csv-viewer/workspace/csv-viewer';
import { Deferred, Effect, Exit, Fiber, Logger } from 'effect';
import { TestClock, TestConsole } from 'effect/testing';
import { expect, it, vi } from '@effect/vitest';
import { DesktopLifecycle, WindowWorkspace, type DocumentWorkspace } from './desktop-lifecycle';

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
  await expect(window.close()).resolves.toBe('disposed');
  expect(window.isOpen).toBe(false);
  expect(window.get()).toBeNull();
  await expect(window.close()).resolves.toBe('disposed');
  await window.replace();
  expect(events).toEqual(['open 1', 'prompt 1: true', 'dispose 1', 'detach 1', 'open 2']);
});

it('keeps the workspace when the close prompt is cancelled', async () => {
  const events: string[] = [];
  const window = new WindowWorkspace(documentWorkspaces(events, () => Effect.succeed(false)));
  await window.replace();
  await expect(window.close()).resolves.toBe('cancelled');
  expect(window.isOpen).toBe(true);
  expect(events).toEqual(['open 1', 'prompt 1: false']);
});

it('waits for a workspace that is still opening when quit arrives, then disposes it', async () => {
  const events: string[] = [];
  const opening = Promise.withResolvers<void>();
  const open = documentWorkspaces(events);
  const window = new WindowWorkspace(async () => {
    await opening.promise;
    return open();
  });
  void window.replace();
  const quit = window.close();
  expect(events).toEqual([]);
  opening.resolve();
  await expect(quit).resolves.toBe('disposed');
  expect(events).toEqual(['open 1', 'prompt 1: true', 'dispose 1', 'detach 1']);
  expect(window.isOpen).toBe(false);
});
