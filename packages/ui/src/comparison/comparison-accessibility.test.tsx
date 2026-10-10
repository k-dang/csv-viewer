// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComparisonView } from '@csv-viewer/workspace/csv-viewer';
import { comparisonFixture, workingCsvFixture } from '../test-helpers/csv-views';
import { createTestCsvViewer } from '../test-helpers/csv-viewer';
import { ComparisonCandidateDialog } from './comparison-candidate-dialog';
import { ComparisonPanel } from './comparison-panel';
import { ComparisonTab } from './comparison-tab';

const workingCsv = (workingCsvId: string) =>
  workingCsvFixture({
    workingCsvId,
    columns: [
      { name: 'id', type: 'VARCHAR' },
      { name: 'value', type: 'VARCHAR' },
    ],
  });

const comparison = (overrides: Partial<ComparisonView> = {}) =>
  comparisonFixture({
    baseline: workingCsv('baseline'),
    candidate: workingCsv('candidate'),
    availableKeyColumns: ['id', 'value'],
    ...overrides,
  });

afterEach(cleanup);

/** Renders one Comparison Tab and returns its markup, the way the static dialog case reads it. */
function panelMarkup(view: ComparisonView): string {
  const tab = new ComparisonTab(createTestCsvViewer(), view);
  return render(<ComparisonPanel tab={tab} />).container.innerHTML;
}

describe('Comparison accessibility semantics', () => {
  it('delays refresh feedback, cancels its timer for a quick operation, and keeps a live Cancel action', () => {
    vi.useFakeTimers();
    try {
      const applied: ComparisonView['applied'] = { resultToken: 'result-1', key: ['id'], freshness: { kind: 'current' }, summary: { rows: { total: 0, changed: 0, unchanged: 0, baselineOnly: 0, candidateOnly: 0 }, changedColumns: [] } };
      const view = comparison({ applied });
      const cancel = vi.fn(async () => ({ status: 'requested' as const }));
      const tab = new ComparisonTab(createTestCsvViewer({ handlers: { 'comparison.cancel': cancel } }), view);
      render(<ComparisonPanel tab={tab} />);
      const operation: NonNullable<ComparisonView['operation']> = { operationId: 'operation-1', intent: 'refresh', phase: 'comparing' };
      act(() => tab.receive({ ...view, version: 2, operation }));
      act(() => vi.advanceTimersByTime(120));
      expect(screen.queryByRole('button', { name: 'Refreshing…' })).toBeNull();
      act(() => tab.receive({ ...view, version: 3 }));
      act(() => vi.advanceTimersByTime(300));
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
      act(() => tab.receive({ ...view, version: 4, operation }));
      act(() => vi.advanceTimersByTime(249));
      expect(screen.queryByRole('button', { name: 'Refreshing…' })).toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByRole('button', { name: 'Refreshing…' }).hasAttribute('disabled')).toBe(true);
      const cancelButton = screen.getByRole('button', { name: 'Cancel' });
      expect(cancelButton.closest('[aria-live]')?.getAttribute('aria-live')).toBe('polite');
      act(() => cancelButton.click());
      expect(cancel).toHaveBeenCalledWith({ operation: 'comparison.cancel', comparisonId: 'comparison-1', operationId: 'operation-1' });
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('names and describes the modal Candidate picker and exposes incompatible choices', () => {
    const baseline = workingCsv('baseline');
    const candidate = workingCsv('candidate');
    const markup = renderToStaticMarkup(
      <ComparisonCandidateDialog
        baseline={baseline}
        candidates={[
          { workingCsv: candidate, compatibility: { kind: 'compatible' } },
          {
            workingCsv: workingCsv('incompatible'),
            compatibility: {
              kind: 'incompatible',
              missingFromBaseline: ['extra'],
              missingFromCandidate: ['value'],
            },
          },
        ]}
        onChoose={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-labelledby="comparison-candidate-title"');
    expect(markup).toContain('aria-describedby="comparison-candidate-description"');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('Missing from Baseline: extra');
    expect(markup).toContain('Missing from Candidate: value');
  });

  it('delays progress feedback, then announces it politely with a keyboard-operable Cancel action', async () => {
    const cancel = vi.fn(async () => ({ status: 'requested' as const }));
    const tab = new ComparisonTab(
      createTestCsvViewer({ handlers: { 'comparison.cancel': cancel } }),
      comparison({ operation: { operationId: 'operation-1', intent: 'apply-key', phase: 'comparing' } }),
    );
    render(<ComparisonPanel tab={tab} />);

    expect(screen.queryByRole('status')).toBeNull();
    const cancelButton = await screen.findByRole('button', { name: 'Cancel' });
    const banner = cancelButton.closest('[aria-live]');
    expect(banner?.getAttribute('aria-live')).toBe('polite');
    expect(banner?.textContent).toContain('Comparing CSVs…');
    cancelButton.click();
    expect(cancel).toHaveBeenCalledWith({ operation: 'comparison.cancel', comparisonId: 'comparison-1', operationId: 'operation-1' });
  });

  it('marks invalid-key diagnostics as a programmatically focusable alert with bounded evidence', () => {
    const markup = panelMarkup(
      comparison({
        lastAttempt: {
          attemptId: 'attempt-1',
          status: 'invalid-key',
          diagnostics: {
            key: ['id'],
            baseline: {
              blankRowCount: 1,
              duplicateGroupCount: 0,
              blankExamples: [{ rowId: '1', keyValues: [null] }],
              duplicateExamples: [],
            },
            candidate: {
              blankRowCount: 0,
              duplicateGroupCount: 1,
              blankExamples: [],
              duplicateExamples: [{ keyValues: ['2'], rowCount: 2, rowIds: ['1', '2'] }],
            },
          },
        },
      }),
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('This draft is not a Valid Comparison Key.');
    expect(markup).toContain('Show bounded examples');
    expect(markup).toContain('Null');
    expect(markup).toContain('appears 2 times');
  });
});
