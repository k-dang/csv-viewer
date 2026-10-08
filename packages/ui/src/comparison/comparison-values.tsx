import type { ComparisonRow, ComparisonSide, ComparisonSummary } from '@csv-viewer/workspace/csv-viewer';

/** Display changed fields first without changing their snapshot value indexes. */
export function comparisonFields(summary: ComparisonSummary) {
  return summary.changedColumns.map((column, index) => ({ ...column, index }))
    .sort((left, right) => right.changedRowCount - left.changedRowCount);
}

const classifications = {
  changed: 'Changed',
  'baseline-only': 'Baseline-only',
  'candidate-only': 'Candidate-only',
  unchanged: 'Unchanged',
} satisfies Record<ComparisonRow['classification'], string>;

export function comparisonKeyLabel(columns: string[], values: string[]): string {
  return columns.map((column, index) => `${column} ${values[index]}`).join(' · ');
}

export function ComparisonClassification({ classification }: { classification: ComparisonRow['classification'] }) {
  return <span className={`comparison-classification comparison-classification--${classification}`}>{classifications[classification]}</span>;
}

export function ComparisonValue({ value, side, changed, compact = false }: {
  value: string | null | undefined;
  side: ComparisonSide;
  changed: boolean;
  compact?: boolean;
}) {
  const text = value === null ? 'Null' : value === '' ? 'Empty string' : value ?? '';
  return (
    <span title={text} className={`comparison-value ${compact ? 'comparison-value--compact' : ''} ${changed ? `comparison-value--${side}` : ''}`}>
      <span className="sr-only">{changed ? `${side} changed value: ` : ''}</span>
      {changed ? <span aria-hidden="true" className="comparison-value-sign">{side === 'baseline' ? '−' : '+'}</span> : null}
      <span className={value === null || value === '' ? 'italic text-muted-foreground' : ''}>{text}</span>
    </span>
  );
}
