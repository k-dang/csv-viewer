import { Effect } from 'effect';
import type { WorkspaceDatabaseConnection } from '../src/database';

export function stubConnection(overrides: Partial<WorkspaceDatabaseConnection> = {}): WorkspaceDatabaseConnection {
  return {
    run: () => Promise.resolve(),
    readObjects: () => Promise.resolve([]),
    runCancellable: () => Promise.resolve(),
    readObjectsCancellable: () => Promise.resolve([]),
    cancelRunning: () => Promise.resolve(),
    close: () => Promise.resolve(),
    runEffect: () => Effect.void,
    readObjectsEffect: () => Effect.succeed([]),
    runCancellableEffect: () => Effect.void,
    readObjectsCancellableEffect: () => Effect.succeed([]),
    closeEffect: () => Effect.void,
    ...overrides,
  };
}
