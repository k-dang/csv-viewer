import type { CloseImpact } from '@csv-viewer/workspace/csv-viewer';

export function confirmTabClose(sourceName: string, impact: CloseImpact): boolean {
  const dependentNames = impact.dependentComparisons.map(
    (comparison) => `${comparison.baselineName} ⇄ ${comparison.candidateName}`,
  );
  const description = [
    impact.hasUnexportedChanges ? 'Unexported Changes will be lost.' : null,
    dependentNames.length > 0
      ? `These dependent Comparison Tabs will also close:\n${dependentNames.join('\n')}`
      : null,
  ].filter(Boolean).join('\n\n');
  return window.confirm(`Close ${sourceName}?\n\n${description}`);
}

