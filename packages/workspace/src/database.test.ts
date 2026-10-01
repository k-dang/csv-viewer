import { Cause, Effect, Exit, Fiber } from 'effect';
import { expect, it } from 'vitest';
import { driverEffect } from './database';

it('interrupts a cancellable call cleanly when the driver cannot cancel it', async () => {
  const call = Promise.withResolvers<void>();
  const work = Effect.runFork(driverEffect(() => call.promise, () => Promise.reject(new Error('cancel failed'))));

  const interruption = Effect.runPromise(Fiber.interrupt(work));
  call.reject(new Error('interrupted'));
  await interruption;

  const exit = await Effect.runPromise(Fiber.await(work));
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false);
  expect(Exit.hasInterrupts(exit)).toBe(true);
});
