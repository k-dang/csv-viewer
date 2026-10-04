import { Effect, Exit, Fiber, type Scope } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataEngineError, WorkspaceDatabase } from '../../src/database';
import { openInScope } from '../scoped-database';

type DriverPrototype<Method extends string> = Record<Method, (...args: never[]) => Promise<object>>;

export interface DriverMethod {
  /** Resolves once the method is first called; every call passes through unchanged. */
  observe(): Promise<void>;
  /** Reports each call's start and real settlement, then holds its result until `release`. */
  hold(): { entered: Promise<void>; settled: () => boolean; release: () => void };
}

export function driverMethod<Method extends string>(prototype: DriverPrototype<Method>, method: Method): DriverMethod {
  const original = prototype[method];
  const replace = (wrap: (call: Promise<object>) => Promise<object>) => {
    const entered = Promise.withResolvers<void>();
    const wrapped = function (this: DriverPrototype<Method>, ...args: never[]) {
      entered.resolve();
      return wrap(original.apply(this, args));
    };
    // SAFETY: `wrapped` forwards the original method's arguments and resolved value.
    vi.spyOn(prototype, method as never).mockImplementation(wrapped as never);
    return entered.promise;
  };
  return {
    observe: () => replace((call) => call),
    hold: () => {
      const released = Promise.withResolvers<void>();
      let settled = false;
      const entered = replace((call) => call.finally(() => { settled = true; }).finally(() => released.promise));
      return { entered, settled: () => settled, release: () => released.resolve() };
    },
  };
}

export interface DatabaseInterruptionFixture {
  open(): Effect.Effect<WorkspaceDatabase, DataEngineError, Scope.Scope>;
  /** The driver call that starts a cancellable query. */
  readonly cancellableStart: DriverMethod;
  /** The driver call a cancellable query waits on while the engine executes it. */
  readonly cancellableExecution: DriverMethod;
  /** The driver call behind a non-cancellable read. */
  readonly read: DriverMethod;
}

const longQuery = 'SELECT sum(a.range * b.range) AS total FROM range(1000000) a, range(1000000) b';

export function describeDatabaseInterruption(name: string, fixture: DatabaseInterruptionFixture): void {
  describe(name, () => {
    let database: WorkspaceDatabase;
    let close: () => Promise<void>;

    beforeEach(async () => {
      ({ database, close } = await openInScope(fixture.open()));
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await close();
    });

    async function expectInterruptionWaitsFor(driver: ReturnType<DriverMethod['hold']>, work: Fiber.Fiber<unknown, unknown>) {
      await driver.entered;
      let interrupted = false;
      const interruption = Effect.runPromise(Fiber.interrupt(work)).then(() => {
        interrupted = true;
      });
      await vi.waitFor(() => expect(driver.settled()).toBe(true), { timeout: 10_000 });
      await new Promise((resolve) => setImmediate(resolve));
      expect(interrupted).toBe(false);

      driver.release();
      await interruption;
      expect(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(work)))).toBe(true);
    }

    it('fails driver errors as a sanitized DataEngineError', async () => {
      const failure = await Effect.runPromise(Effect.flip(database.readObjects('SELECT * FROM missing_table')));

      expect(failure).toMatchObject({
        name: 'DataEngineError',
        message: 'The data engine could not complete the operation.',
      });
      expect(failure.message).not.toContain('missing_table');
    });

    it('cancels long work interrupted as the driver starts it', async () => {
      const worker = await Effect.runPromise(database.connectWorker());
      const started = fixture.cancellableStart.observe();
      const work = Effect.runFork(worker.runCancellable(`CREATE TABLE cancelled_work AS ${longQuery}`));
      await started;

      await Effect.runPromise(Fiber.interrupt(work));

      expect(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(work)))).toBe(true);
      await expect(Effect.runPromise(database.readObjects(
        "SELECT count(*)::BIGINT AS count FROM information_schema.tables WHERE table_name = 'cancelled_work'",
      ))).resolves.toEqual([{ count: 0n }]);
      await expect(Effect.runPromise(worker.readObjects('SELECT 42 AS answer'))).resolves.toEqual([{ answer: 42 }]);
      await Effect.runPromise(worker.close());
    }, 15_000);

    it('waits for cancelled driver work to settle before interruption completes', async () => {
      const execution = fixture.cancellableExecution.hold();
      const worker = await Effect.runPromise(database.connectWorker());
      const work = Effect.runFork(worker.readObjectsCancellable(longQuery));

      await expectInterruptionWaitsFor(execution, work);

      await expect(Effect.runPromise(worker.readObjects('SELECT 42 AS answer'))).resolves.toEqual([{ answer: 42 }]);
      await Effect.runPromise(worker.close());
    }, 15_000);

    it('completes interruption of non-cancellable work only after the driver settles', async () => {
      const read = fixture.read.hold();
      const work = Effect.runFork(database.readObjects('SELECT 42 AS answer'));

      await expectInterruptionWaitsFor(read, work);
    });
  });
}
