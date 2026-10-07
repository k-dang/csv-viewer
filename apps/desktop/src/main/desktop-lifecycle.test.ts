import type { ConfirmWorkspaceCloseOutcome, WorkspaceCloseImpact } from '@csv-viewer/workspace/csv-viewer';
import { Deferred, Effect, Exit, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it, vi } from '@effect/vitest';
import { DesktopLifecycle } from './desktop-lifecycle';

const impact: WorkspaceCloseImpact = {
  workingCsvsWithUnexportedChanges: [{ workingCsvId: 'csv-1', sourceName: 'people.csv' }],
  dependentComparisons: [],
};

it.effect('shares confirmation between window close and quit and allows a fresh request after cancellation', () => Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const answer = yield* Deferred.make<boolean>();
  const confirmClose = vi.fn(async (): Promise<ConfirmWorkspaceCloseOutcome> => ({ status: 'confirmation-required', impact }));
  const dispose = vi.fn(async () => {});
  const prompt = vi.fn(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(answer))));
  const lifecycle = new DesktopLifecycle({ confirmClose, dispose }, prompt);

  const close = yield* Effect.forkScoped(lifecycle.requestWindowClose());
  yield* Deferred.await(entered);
  const quit = yield* Effect.forkScoped(lifecycle.requestQuit(), { startImmediately: true });
  yield* Deferred.succeed(answer, false);
  expect(yield* Fiber.join(close)).toBe(false);
  expect(yield* Fiber.join(quit)).toBe('cancelled');
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(dispose).not.toHaveBeenCalled();

  expect(yield* lifecycle.requestWindowClose()).toBe(false);
  expect(prompt).toHaveBeenCalledTimes(2);
}));

it.effect('rechecks changing close impact and reuses authorization when the window close leads to quit', () => Effect.gen(function* () {
  const changed: WorkspaceCloseImpact = {
    ...impact,
    workingCsvsWithUnexportedChanges: [...impact.workingCsvsWithUnexportedChanges, { workingCsvId: 'csv-2', sourceName: 'other.csv' }],
  };
  const confirmClose = vi.fn(async (confirmed?: WorkspaceCloseImpact): Promise<ConfirmWorkspaceCloseOutcome> =>
    confirmed === changed ? { status: 'ready' } : { status: 'confirmation-required', impact: confirmed ? changed : impact });
  const dispose = vi.fn(async () => {});
  const prompt = vi.fn(() => Effect.succeed(true));
  const lifecycle = new DesktopLifecycle({ confirmClose, dispose }, prompt);

  expect(yield* lifecycle.requestWindowClose()).toBe(true);
  expect(prompt.mock.calls).toEqual([[impact], [changed]]);
  expect(yield* lifecycle.requestQuit()).toBe('disposed');
  expect(confirmClose).toHaveBeenLastCalledWith(changed);
  expect(prompt).toHaveBeenCalledTimes(2);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(lifecycle.isDisposed).toBe(true);
}));

it.effect('settles all confirmation waiters after a prompt failure and permits retry', () => Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const answer = yield* Deferred.make<boolean, Error>();
  const failure = new Error('Prompt failed.');
  const lifecycle = new DesktopLifecycle({
    confirmClose: async () => ({ status: 'confirmation-required', impact }),
    dispose: async () => {},
  }, () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(answer))));
  const close = yield* Effect.forkScoped(lifecycle.requestWindowClose());
  yield* Deferred.await(entered);
  const quit = yield* Effect.forkScoped(lifecycle.requestQuit(), { startImmediately: true });
  yield* Deferred.fail(answer, failure);
  expect(yield* Fiber.await(close)).toEqual(Exit.fail(failure));
  expect(yield* Fiber.await(quit)).toEqual(Exit.fail(failure));
  expect(yield* Effect.exit(lifecycle.requestQuit())).toEqual(Exit.fail(failure));
}));

it.effect('bounds shutdown to twenty seconds while the one underlying cleanup continues', () => Effect.gen(function* () {
  const entered = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const dispose = vi.fn(() => { entered.resolve(); return cleanup.promise; });
  const lifecycle = new DesktopLifecycle({
    confirmClose: async () => ({ status: 'ready' }), dispose,
  }, () => Effect.succeed(true));
  const quit = yield* Effect.forkScoped(lifecycle.requestQuit());
  yield* Effect.addFinalizer(() => Effect.sync(() => cleanup.resolve()));
  yield* Effect.promise(() => entered.promise);
  expect(yield* lifecycle.requestQuit()).toBe('cancelled');
  yield* TestClock.adjust('20 seconds');
  expect(yield* Fiber.join(quit)).toBe('failed');
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(lifecycle.isDisposed).toBe(false);
  cleanup.resolve();
  yield* Effect.promise(() => cleanup.promise);
}));
