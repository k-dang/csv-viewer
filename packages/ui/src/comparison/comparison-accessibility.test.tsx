// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
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
function panelMarkup(view: ComparisonView, themeMode: 'light' | 'dark' = 'light'): string {
  const tab = new ComparisonTab(createTestCsvViewer(), view);
  return render(<ComparisonPanel tab={tab} themeMode={themeMode} />).container.innerHTML;
}

describe('Comparison accessibility semantics', () => {
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

  it('announces progress politely and exposes a keyboard-operable Cancel action', () => {
    const markup = panelMarkup(
      comparison({ operation: { operationId: 'operation-1', intent: 'apply-key', phase: 'comparing' } }),
    );

    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('Comparing complete CSVs');
    expect(markup).toContain('<button');
    expect(markup).toContain('Cancel</button>');
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
      'dark',
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('This draft is not a Valid Comparison Key.');
    expect(markup).toContain('Show bounded examples');
    expect(markup).toContain('Null');
    expect(markup).toContain('appears 2 times');
  });
});
