// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { ComparisonView } from '@csv-viewer/workspace/csv-viewer';
import { comparisonFixture } from '../test-helpers/csv-views';
import { createTestCsvViewer } from '../test-helpers/csv-viewer';
import { ComparisonPanel } from './comparison-panel';
import { ComparisonTab } from './comparison-tab';

afterEach(cleanup);

/** Renders one Comparison Tab; `update` delivers later projections the way the workspace would. */
function renderPanel(comparison: ComparisonView) {
  const tab = new ComparisonTab(createTestCsvViewer(), comparison);
  render(<ComparisonPanel tab={tab} themeMode="light" />);
  return { update: (next: ComparisonView) => act(() => tab.receive(next)) };
}

it('focuses the first key on mount without stealing focus on later renders', () => {
  const comparison = comparisonFixture();
  const { update } = renderPanel(comparison);
  expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'id' }));
  const apply = screen.getByRole('button', { name: 'Apply key' });
  apply.focus();
  update({ ...comparison, version: 2 });
  expect(document.activeElement).toBe(apply);
});

it('focuses each invalid attempt, preserves expanded evidence, and leaves unrelated renders alone', () => {
  const diagnostics = {
    key: ['id'],
    baseline: {
      blankRowCount: 1,
      duplicateGroupCount: 0,
      blankExamples: [{ rowId: '1', keyValues: [null] }],
      duplicateExamples: [],
    },
    candidate: { blankRowCount: 0, duplicateGroupCount: 0, blankExamples: [], duplicateExamples: [] },
  };
  const comparison = comparisonFixture({
    lastAttempt: { attemptId: 'attempt-1', status: 'invalid-key', diagnostics },
  });
  const { update } = renderPanel(comparison);
  const alert = screen.getByRole('alert');
  expect(document.activeElement).toBe(alert);
  const details = alert.querySelector('details');
  if (!details) throw new Error('Missing diagnostic evidence.');
  details.open = true;
  const apply = screen.getByRole('button', { name: 'Apply key' });
  apply.focus();
  update({ ...comparison, version: 2 });
  expect(document.activeElement).toBe(apply);
  update({
    ...comparison,
    version: 3,
    lastAttempt: {
      attemptId: 'attempt-1',
      status: 'invalid-key',
      diagnostics: structuredClone(diagnostics),
    },
  });
  expect(document.activeElement).toBe(apply);
  update({
    ...comparison,
    version: 4,
    lastAttempt: { attemptId: 'attempt-2', status: 'invalid-key', diagnostics },
  });
  expect(document.activeElement).toBe(alert);
  expect(details.open).toBe(true);
});
