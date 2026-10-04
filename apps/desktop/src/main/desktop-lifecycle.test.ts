import type { ConfirmWorkspaceCloseOutcome, WorkspaceCloseImpact } from '@csv-viewer/workspace/csv-viewer';
import { Deferred, Effect, Exit } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopLifecycle } from './desktop-lifecycle';

const impact: WorkspaceCloseImpact = {
  workingCsvsWithUnexportedChanges: [{ workingCsvId: 'csv-1', sourceName: 'people.csv' }],
  dependentComparisons: [],
};

afterEach(() => { vi.useRealTimers(); });

it('shares confirmation between window close and quit and allows a fresh request after cancellation', async () => {
  const entered = Promise.withResolvers<void>();
  const answer = Deferred.makeUnsafe<boolean>();
  const confirmClose = vi.fn(async (): Promise<ConfirmWorkspaceCloseOutcome> => ({ status: 'confirmation-required', impact }));
  const dispose = vi.fn(async () => {});
  const prompt = vi.fn(() => Effect.sync(() => entered.resolve()).pipe(Effect.andThen(Deferred.await(answer))));
  const lifecycle = new DesktopLifecycle({ confirmClose, dispose }, prompt);

  const close = Effect.runPromise(lifecycle.requestWindowClose());
  await entered.promise;
  const quit = Effect.runPromise(lifecycle.requestQuit());
  Deferred.doneUnsafe(answer, Effect.succeed(false));
  expect(await close).toBe(false);
  expect(await quit).toBe('cancelled');
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(dispose).not.toHaveBeenCalled();

  expect(await Effect.runPromise(lifecycle.requestWindowClose())).toBe(false);
  expect(prompt).toHaveBeenCalledTimes(2);
});

it('rechecks changing close impact and reuses authorization when the window close leads to quit', async () => {
  const changed: WorkspaceCloseImpact = {
    ...impact,
    workingCsvsWithUnexportedChanges: [...impact.workingCsvsWithUnexportedChanges, { workingCsvId: 'csv-2', sourceName: 'other.csv' }],
  };
  const confirmClose = vi.fn(async (confirmed?: WorkspaceCloseImpact): Promise<ConfirmWorkspaceCloseOutcome> =>
    confirmed === changed ? { status: 'ready' } : { status: 'confirmation-required', impact: confirmed ? changed : impact });
  const dispose = vi.fn(async () => {});
  const prompt = vi.fn(() => Effect.succeed(true));
  const lifecycle = new DesktopLifecycle({ confirmClose, dispose }, prompt);

  expect(await Effect.runPromise(lifecycle.requestWindowClose())).toBe(true);
  expect(prompt.mock.calls).toEqual([[impact], [changed]]);
  expect(await Effect.runPromise(lifecycle.requestQuit())).toBe('disposed');
  expect(confirmClose).toHaveBeenLastCalledWith(changed);
  expect(prompt).toHaveBeenCalledTimes(2);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(lifecycle.isDisposed).toBe(true);
});

it('settles all confirmation waiters after a prompt failure and permits retry', async () => {
  const entered = Promise.withResolvers<void>();
  const answer = Deferred.makeUnsafe<boolean, Error>();
  const failure = new Error('Prompt failed.');
  const lifecycle = new DesktopLifecycle({
    confirmClose: async () => ({ status: 'confirmation-required', impact }),
    dispose: async () => {},
  }, () => Effect.sync(() => entered.resolve()).pipe(Effect.andThen(Deferred.await(answer))));
  const close = Effect.runPromiseExit(lifecycle.requestWindowClose());
  await entered.promise;
  const quit = Effect.runPromiseExit(lifecycle.requestQuit());
  Deferred.doneUnsafe(answer, Effect.fail(failure));
  expect(await close).toEqual(Exit.fail(failure));
  expect(await quit).toEqual(Exit.fail(failure));
  expect(await Effect.runPromiseExit(lifecycle.requestQuit())).toEqual(Exit.fail(failure));
});

it('bounds shutdown to twenty seconds while the one underlying cleanup continues', async () => {
  vi.useFakeTimers();
  const entered = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const dispose = vi.fn(() => { entered.resolve(); return cleanup.promise; });
  const lifecycle = new DesktopLifecycle({
    confirmClose: async () => ({ status: 'ready' }), dispose,
  }, () => Effect.succeed(true));
  const quit = Effect.runPromise(lifecycle.requestQuit());
  await entered.promise;
  expect(await Effect.runPromise(lifecycle.requestQuit())).toBe('cancelled');
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await quit).toBe('failed');
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(lifecycle.isDisposed).toBe(false);
  cleanup.resolve();
  await cleanup.promise;
});
