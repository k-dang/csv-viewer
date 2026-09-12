// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestCsvViewer, withCsvViewer } from '../test-helpers/csv-viewer';
import { EmptyCsvState } from './empty-csv-state';

afterEach(cleanup);

describe('EmptyCsvState', () => {
  it('renders recent sources and forwards the selected source', () => {
    const onOpenRecent = vi.fn();
    render(withCsvViewer(<EmptyCsvState
      recentSources={[{ sourceId: 'source-1', name: 'sales.csv', location: '/sales.csv', sizeBytes: 128, lastOpenedAt: '2026-01-01T00:00:00.000Z' }]}
      isOpening={false} errorMessage={null} dialectError={null}
      onOpenCsv={vi.fn()} onOpenRecent={onOpenRecent}
    />));
    screen.getByRole('button', { name: /sales.csv/ }).click();
    expect(onOpenRecent).toHaveBeenCalledWith('source-1');
  });

  it('explains that sources must be selected again without durable identity', () => {
    render(withCsvViewer(<EmptyCsvState
      recentSources={[]} isOpening={false} errorMessage={null} dialectError={null}
      onOpenCsv={vi.fn()} onOpenRecent={vi.fn()}
    />, createTestCsvViewer({ capabilities: { recentCsvSources: false } })));
    expect(screen.getByText('Select your CSV Sources again after reload.')).toBeTruthy();
    expect(screen.queryByText('Recent CSV Sources')).toBeNull();
  });
});
