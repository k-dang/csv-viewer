import { afterEach, beforeEach } from 'vitest';

beforeEach(() => {
  // SAFETY: React's test renderer documents this global flag, but TypeScript's lib lacks it.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  // SAFETY: Remove the test-only global so it cannot leak between test files sharing a worker.
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
