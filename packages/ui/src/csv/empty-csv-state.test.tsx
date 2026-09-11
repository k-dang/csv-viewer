// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecentCsvSource } from '@csv-viewer/workspace/csv-viewer';
import { createTestCsvViewer, withCsvViewer } from '../test-helpers/csv-viewer';
import { EmptyCsvState } from './empty-csv-state';

const recentSources: RecentCsvSource[] = [
  {
    sourceId: 'source-1',
    name: 'sales.csv',
    location: '/data/sales.csv',
    sizeBytes: 128,
    lastOpenedAt: '2026-01-01T00:00:00.000Z',
  },
];

function emptyState(viewer: ReturnType<typeof createTestCsvViewer>, isOpening = false) {
  return withCsvViewer(
    <EmptyCsvState
      isOpening={isOpening}
      errorMessage={null}
      dialectError={null}
      onOpenCsv={vi.fn()}
      onOpenRecent={vi.fn()}
    />,
    viewer,
  );
}

afterEach(cleanup);

describe('EmptyCsvState', () => {
  it('offers Recent CSV Sources on a runtime that can reopen them', async () => {
    const getRecentCsvSources = vi.fn().mockResolvedValue(recentSources);
    const viewer = createTestCsvViewer({
      handlers: { 'csv.get-recent-sources': getRecentCsvSources },
    });

    const { container } = render(emptyState(viewer));
    await act(async () => {});

    expect(getRecentCsvSources).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Recent CSV Sources');
    expect(container.textContent).toContain('sales.csv');
  });

  it('neither requests nor offers Recent CSV Sources on a runtime that cannot reopen them', async () => {
    const getRecentCsvSources = vi.fn().mockResolvedValue(recentSources);
    const viewer = createTestCsvViewer({
      handlers: { 'csv.get-recent-sources': getRecentCsvSources },
      capabilities: { recentCsvSources: false },
    });

    const { container } = render(emptyState(viewer));
    await act(async () => {});

    expect(getRecentCsvSources).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Recent CSV Sources');
    expect(container.textContent).not.toContain('sales.csv');
    expect(container.textContent).toContain('Select your CSV Sources again after reload.');
  });

  /** A CSV Source that has become unreachable must drop off the list after a failed open. */
  it('refreshes the list once an open attempt finishes', async () => {
    const getRecentCsvSources = vi.fn().mockResolvedValueOnce(recentSources).mockResolvedValueOnce([]);
    const viewer = createTestCsvViewer({
      handlers: { 'csv.get-recent-sources': getRecentCsvSources },
    });

    const { container, rerender } = render(emptyState(viewer));
    await act(async () => rerender(emptyState(viewer, true)));
    await act(async () => rerender(emptyState(viewer, false)));

    expect(getRecentCsvSources).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('sales.csv');
  });
});
