import { Effect, Exit, Scope } from 'effect';

/**
 * Opens a database in a scope the test owns. `close` runs the release steps `open` registered;
 * a failed `open` runs them before rejecting.
 */
export async function openInScope<A, E>(open: Effect.Effect<A, E, Scope.Scope>): Promise<{ database: A; close: () => Promise<void> }> {
  const scope = Scope.makeUnsafe();
  const database = await Effect.runPromise(Scope.provide(open, scope).pipe(
    Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
  ));
  return { database, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}
