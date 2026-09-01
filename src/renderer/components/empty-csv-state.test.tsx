import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { RecentCsvSource } from '../../shared/csv-viewer-contract';
import { createTestCsvViewer, withCsvViewer } from '../../test-helpers/csv-viewer';
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

function renderedText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

describe('EmptyCsvState', () => {
  it('offers Recent CSV Sources on a runtime that can reopen them', async () => {
    const getRecentCsvSources = vi.fn().mockResolvedValue(recentSources);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        emptyState(
          createTestCsvViewer({
            handlers: { 'csv.get-recent-sources': getRecentCsvSources },
          }),
        ),
      );
    });

    expect(getRecentCsvSources).toHaveBeenCalledOnce();
    expect(renderedText(renderer)).toContain('Recent CSV Sources');
    expect(renderedText(renderer)).toContain('sales.csv');
  });

  it('neither requests nor offers Recent CSV Sources on a runtime that cannot reopen them', async () => {
    const getRecentCsvSources = vi.fn().mockResolvedValue(recentSources);
    const viewer = createTestCsvViewer({
      handlers: { 'csv.get-recent-sources': getRecentCsvSources },
      capabilities: { recentCsvSources: false },
    });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(emptyState(viewer));
    });

    expect(getRecentCsvSources).not.toHaveBeenCalled();
    expect(renderedText(renderer)).not.toContain('Recent CSV Sources');
    expect(renderedText(renderer)).not.toContain('sales.csv');
    expect(renderedText(renderer)).toContain('Select your CSV Sources again after reload.');
  });

  /** A CSV Source that has become unreachable must drop off the list after a failed open. */
  it('refreshes the list once an open attempt finishes', async () => {
    const getRecentCsvSources = vi.fn().mockResolvedValueOnce(recentSources).mockResolvedValueOnce([]);
    const viewer = createTestCsvViewer({
      handlers: { 'csv.get-recent-sources': getRecentCsvSources },
    });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(emptyState(viewer));
    });
    await act(async () => {
      renderer.update(emptyState(viewer, true));
    });
    await act(async () => {
      renderer.update(emptyState(viewer, false));
    });

    expect(getRecentCsvSources).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer)).not.toContain('sales.csv');
  });
});
