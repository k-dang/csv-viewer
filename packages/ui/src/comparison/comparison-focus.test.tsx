// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComparisonView } from '@csv-viewer/workspace/csv-viewer';
import { comparisonFixture } from '../test-helpers/csv-views';
import { withCsvViewer } from '../test-helpers/csv-viewer';
import { ComparisonTab } from './comparison-tab';

afterEach(cleanup);

function view(comparison: ComparisonView) {
  return withCsvViewer(
    <ComparisonTab
      comparison={comparison}
      presentation={{ draftKey: ['id'], rows: 'differences', columns: 'changed-first' }}
      onPresentationChange={vi.fn()}
      themeMode="light"
    />,
  );
}

it('focuses the first key on mount without stealing focus on later renders', () => {
  const comparison = comparisonFixture();
  const rendered = render(view(comparison));
  expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'id' }));
  const apply = screen.getByRole('button', { name: 'Apply key' });
  apply.focus();
  rendered.rerender(view({ ...comparison, version: 2 }));
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
  const rendered = render(view(comparison));
  const alert = screen.getByRole('alert');
  expect(document.activeElement).toBe(alert);
  const details = alert.querySelector('details');
  if (!details) throw new Error('Missing diagnostic evidence.');
  details.open = true;
  const apply = screen.getByRole('button', { name: 'Apply key' });
  apply.focus();
  rendered.rerender(view({ ...comparison, version: 2 }));
  expect(document.activeElement).toBe(apply);
  rendered.rerender(view({
    ...comparison,
    lastAttempt: { attemptId: 'attempt-2', status: 'invalid-key', diagnostics },
  }));
  expect(document.activeElement).toBe(alert);
  expect(details.open).toBe(true);
});
