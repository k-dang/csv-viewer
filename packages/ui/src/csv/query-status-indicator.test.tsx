// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUERYING_LABEL_DELAY_MS, QueryStatusIndicator } from './query-status-indicator';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('QueryStatusIndicator', () => {
  it('keeps Ready through a fast query and shows Querying once a query is slow', () => {
    const { container, rerender } = render(<QueryStatusIndicator state="ready" />);
    const status = () => container.querySelector('[aria-live="polite"]');

    rerender(<QueryStatusIndicator state="querying" />);
    expect(status()?.textContent).toBe('Ready');
    expect(status()?.getAttribute('data-query-status')).toBe('querying');

    rerender(<QueryStatusIndicator state="ready" />);
    act(() => vi.advanceTimersByTime(QUERYING_LABEL_DELAY_MS));
    expect(status()?.textContent).toBe('Ready');

    rerender(<QueryStatusIndicator state="querying" />);
    act(() => vi.advanceTimersByTime(QUERYING_LABEL_DELAY_MS));
    expect(status()?.textContent).toBe('Querying');

    rerender(<QueryStatusIndicator state="ready" />);
    rerender(<QueryStatusIndicator state="querying" />);
    expect(status()?.textContent).toBe('Ready');
  });

  it('shows a failed query at once', () => {
    const { container } = render(<QueryStatusIndicator state="failed" />);
    expect(container.textContent).toBe('Query failed');
  });
});
