import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ComparisonView, WorkingCsvView } from '../../shared/ipc';
import { ComparisonCandidateDialog } from './comparison-candidate-dialog';
import { ComparisonTab } from './comparison-tab';

function workingCsv(workingCsvId: string): WorkingCsvView {
  return {
    workingCsvId,
    dataRevision: 0,
    file: { sourceId: workingCsvId, location: `C:/${workingCsvId}.csv`, name: `${workingCsvId}.csv`, sizeBytes: 10 },
    columns: [
      { name: 'id', type: 'VARCHAR' },
      { name: 'value', type: 'VARCHAR' },
    ],
    rowCount: 1,
    dialect: {},
    editState: { workingCsvId, hasUnexportedChanges: false, canUndo: false, canRedo: false },
  };
}

function comparison(overrides: Partial<ComparisonView> = {}): ComparisonView {
  return {
    comparisonId: 'comparison-1',
    version: 1,
    baseline: workingCsv('baseline'),
    candidate: workingCsv('candidate'),
    availableKeyColumns: ['id', 'value'],
    operation: null,
    applied: null,
    lastAttempt: null,
    ...overrides,
  };
}

const presentation = {
  draftKey: ['id'],
  rows: 'differences' as const,
  columns: 'changed-first' as const,
};

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
    const markup = renderToStaticMarkup(
      <ComparisonTab
        comparison={comparison({
          operation: {
            operationId: 'operation-1',
            intent: 'apply-key',
            phase: 'comparing',
          },
        })}
        presentation={presentation}
        onPresentationChange={vi.fn()}
        themeMode="light"
      />,
    );

    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('Comparing complete CSVs');
    expect(markup).toContain('<button');
    expect(markup).toContain('Cancel</button>');
  });

  it('marks invalid-key diagnostics as a programmatically focusable alert with bounded evidence', () => {
    const markup = renderToStaticMarkup(
      <ComparisonTab
        comparison={comparison({
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
        })}
        presentation={presentation}
        onPresentationChange={vi.fn()}
        themeMode="dark"
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('This draft is not a Valid Comparison Key.');
    expect(markup).toContain('Show bounded examples');
    expect(markup).toContain('Null');
    expect(markup).toContain('appears 2 times');
  });

});
