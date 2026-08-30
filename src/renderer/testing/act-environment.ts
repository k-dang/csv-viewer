import { afterEach, beforeEach } from 'vitest';

/**
 * react-test-renderer refuses act() unless this global is set, and leaving it set leaks into the
 * sibling test files sharing the worker. Call once at the top of a file that renders with act().
 */
export function enableActEnvironment() {
  beforeEach(() => {
    // SAFETY: React's test renderer documents this global flag, but TypeScript's lib lacks it.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    // SAFETY: This removes the same test-only global property installed in beforeEach.
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
}
