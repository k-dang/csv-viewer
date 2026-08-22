import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecentCsvSource } from '../../shared/csv-viewer-contract';
import { createTestCsvViewerRuntime, withRuntime } from '../testing/test-csv-viewer-runtime';
import { EmptyCsvState } from './empty-csv-state';

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const recentSources: RecentCsvSource[] = [
  {
    sourceId: 'source-1',
    name: 'sales.csv',
    location: '/data/sales.csv',
    sizeBytes: 128,
    lastOpenedAt: '2026-01-01T00:00:00.000Z',
  },
];

function emptyState(runtime: ReturnType<typeof createTestCsvViewerRuntime>, isOpening = false) {
  return withRuntime(
    <EmptyCsvState
      isOpening={isOpening}
      errorMessage={null}
      dialectError={null}
      onOpenCsv={vi.fn()}
      onOpenRecent={vi.fn()}
    />,
    runtime,
  );
}

function renderedText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

describe('EmptyCsvState', () => {
  it('offers Recent CSV Sources on a runtime that can reopen them', async () => {
    const getRecentCsvSources = vi.fn().mockResolvedValue(recentSources);
    let renderer: ReactTestRenderer;

    await act(async () => {
      renderer = create(emptyState(createTestCsvViewerRuntime({ getRecentCsvSources })));
    });

    expect(getRecentCsvSources).toHaveBeenCalledOnce();
    expect(renderedText(renderer!)).toContain('Recent CSV Sources');
    expect(renderedText(renderer!)).toContain('sales.csv');
  });

  it('neither requests nor offers Recent CSV Sources on a runtime that cannot reopen them', async () => {
    const getRecentCsvSources = vi.fn().mockResolvedValue(recentSources);
    const runtime = createTestCsvViewerRuntime({
      getRecentCsvSources,
      capabilities: { recentCsvSources: false },
    });
    let renderer: ReactTestRenderer;

    await act(async () => {
      renderer = create(emptyState(runtime));
    });

    expect(getRecentCsvSources).not.toHaveBeenCalled();
    expect(renderedText(renderer!)).not.toContain('Recent CSV Sources');
    expect(renderedText(renderer!)).not.toContain('sales.csv');
  });

  /** A CSV Source that has become unreachable must drop off the list after a failed open. */
  it('refreshes the list once an open attempt finishes', async () => {
    const getRecentCsvSources = vi
      .fn()
      .mockResolvedValueOnce(recentSources)
      .mockResolvedValueOnce([]);
    const runtime = createTestCsvViewerRuntime({ getRecentCsvSources });
    let renderer: ReactTestRenderer;

    await act(async () => {
      renderer = create(emptyState(runtime));
    });
    await act(async () => {
      renderer.update(emptyState(runtime, true));
    });
    await act(async () => {
      renderer.update(emptyState(runtime, false));
    });

    expect(getRecentCsvSources).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer!)).not.toContain('sales.csv');
  });
});
