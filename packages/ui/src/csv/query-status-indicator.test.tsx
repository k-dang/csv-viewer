// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUERYING_LABEL_DELAY_MS, QueryStatusIndicator, type QueryState } from './query-status-indicator';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Renders the indicator under StrictMode, so effects mount, clean up, and mount again as in development. */
function renderIndicator(initial: QueryState) {
  const view = (state: QueryState) => <StrictMode><QueryStatusIndicator state={state} /></StrictMode>;
  const { container, rerender } = render(view(initial));
  return {
    text: () => container.querySelector('[aria-live="polite"]')?.textContent,
    status: () => container.querySelector('[aria-live="polite"]')?.getAttribute('data-query-status'),
    set: (state: QueryState) => rerender(view(state)),
    wait: (ms: number) => act(() => vi.advanceTimersByTime(ms)),
  };
}

describe('QueryStatusIndicator', () => {
  it('keeps Ready through a fast query and shows Querying once a query is slow', () => {
    const indicator = renderIndicator('ready');

    indicator.set('querying');
    expect(indicator.text()).toBe('Ready');
    expect(indicator.status()).toBe('querying');

    indicator.set('ready');
    indicator.wait(QUERYING_LABEL_DELAY_MS);
    expect(indicator.text()).toBe('Ready');

    indicator.set('querying');
    indicator.wait(QUERYING_LABEL_DELAY_MS - 1);
    expect(indicator.text()).toBe('Ready');
    indicator.wait(1);
    expect(indicator.text()).toBe('Querying');

    indicator.set('ready');
    indicator.set('querying');
    expect(indicator.text()).toBe('Ready');
  });

  it('leaves a slow query for a failure or idle without waiting', () => {
    const indicator = renderIndicator('querying');
    indicator.wait(QUERYING_LABEL_DELAY_MS);
    expect(indicator.text()).toBe('Querying');

    indicator.set('failed');
    expect(indicator.text()).toBe('Query failed');

    indicator.set('querying');
    indicator.wait(QUERYING_LABEL_DELAY_MS);
    indicator.set('idle');
    expect(indicator.text()).toBe('Ready');
    expect(indicator.status()).toBe('idle');
  });
});
