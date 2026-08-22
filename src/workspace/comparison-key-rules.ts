import type {
  ComparisonCandidate,
  ComparisonFault,
  ComparisonKeyDiagnostics,
  ComparisonSide,
  WorkingCsvView,
} from '../shared/csv-viewer-contract';

/**
 * The rules that decide whether two Working CSVs can be compared and whether a draft Comparison
 * Key is usable. They are pure: same inputs, same verdict, no workspace state involved.
 */
export function compareColumns(
  baseline: WorkingCsvView,
  candidate: WorkingCsvView,
): ComparisonCandidate['compatibility'] {
  const baselineNames = baseline.columns.map((column) => column.name);
  const candidateNames = candidate.columns.map((column) => column.name);
  const baselineSet = new Set(baselineNames);
  const candidateSet = new Set(candidateNames);
  const missingFromBaseline = candidateNames.filter((name) => !baselineSet.has(name));
  const missingFromCandidate = baselineNames.filter((name) => !candidateSet.has(name));
  return missingFromBaseline.length === 0 && missingFromCandidate.length === 0
    ? { kind: 'compatible' }
    : { kind: 'incompatible', missingFromBaseline, missingFromCandidate };
}

/** Column names present in both Working CSVs, in baseline order. */
export function sharedColumnNames(baseline: WorkingCsvView, candidate: WorkingCsvView): string[] {
  const candidateColumns = new Set(candidate.columns.map((column) => column.name));
  return baseline.columns
    .map((column) => column.name)
    .filter((column) => candidateColumns.has(column));
}

export function validateKeyShape(key: string[], available: string[]): ComparisonFault | null {
  if (key.length === 0 || new Set(key).size !== key.length) {
    return fault('invalid-key-shape', 'Choose one or more distinct Comparison Key columns.');
  }
  const known = new Set(available);
  if (key.some((column) => !known.has(column))) {
    return fault(
      'unknown-key-column',
      'The Comparison Key contains a column that is not shared by both Working CSVs.',
    );
  }
  return null;
}

export function hasInvalidKeys(diagnostics: ComparisonKeyDiagnostics): boolean {
  return (
    diagnostics.baseline.blankRowCount > 0 ||
    diagnostics.baseline.duplicateGroupCount > 0 ||
    diagnostics.candidate.blankRowCount > 0 ||
    diagnostics.candidate.duplicateGroupCount > 0
  );
}

export function fault(code: ComparisonFault['code'], message: string): ComparisonFault {
  return { code, message };
}

export function rejected(
  code: ComparisonFault['code'],
  message: string,
): { status: 'rejected'; fault: ComparisonFault } {
  return { status: 'rejected', fault: fault(code, message) };
}

export function sideOrder(left: ComparisonSide, right: ComparisonSide): number {
  return left === right ? 0 : left === 'baseline' ? -1 : 1;
}
