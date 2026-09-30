import { Effect, Fiber } from 'effect';
import { vi } from 'vitest';

type DriverPrototype<Method extends string> = Record<Method, (...args: never[]) => Promise<object>>;

/**
 * Wraps a real driver method so each call reports when it starts and when the real call settles,
 * then holds its result until `release`. Adapter tests use it to observe whether interruption
 * waits for the driver.
 */
export function holdDriverSettlement<Method extends string>(prototype: DriverPrototype<Method>, method: Method) {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const settled = vi.fn();
  const original = prototype[method];
  const held = function (this: DriverPrototype<Method>, ...args: never[]) {
    entered.resolve();
    return original.apply(this, args).finally(settled).finally(() => released.promise);
  };
  // SAFETY: `held` forwards the original method's arguments and resolved value.
  vi.spyOn(prototype, method as never).mockImplementation(held as never);
  return { entered: entered.promise, settled, release: () => released.resolve() };
}

/** Resolves once a real driver method is first called, then lets every call through unchanged. */
export function observeDriverCall<Method extends string>(prototype: DriverPrototype<Method>, method: Method): Promise<void> {
  const entered = Promise.withResolvers<void>();
  const original = prototype[method];
  const observed = function (this: DriverPrototype<Method>, ...args: never[]) {
    entered.resolve();
    return original.apply(this, args);
  };
  // SAFETY: `observed` forwards the original method's arguments and resolved value.
  vi.spyOn(prototype, method as never).mockImplementation(observed as never);
  return entered.promise;
}

/** Interrupts `work` and exposes whether that interruption has completed yet. */
export function observeInterruption<A, E>(work: Fiber.Fiber<A, E>) {
  const state = { completed: false };
  const done = Effect.runPromise(Fiber.interrupt(work)).then(() => {
    state.completed = true;
  });
  return { state, done };
}
