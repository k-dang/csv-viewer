import { Effect } from 'effect';
import type { WorkspaceDatabaseConnection } from '../src/database';

export function stubConnection(overrides: Partial<WorkspaceDatabaseConnection> = {}): WorkspaceDatabaseConnection {
  return {
    run: () => Effect.void,
    readObjects: () => Effect.succeed([]),
    runCancellable: () => Effect.void,
    readObjectsCancellable: () => Effect.succeed([]),
    close: () => Effect.void,
    ...overrides,
  };
}
