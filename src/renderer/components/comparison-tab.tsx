import { useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Loader2,
  RefreshCw,
  Rows3,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ComparisonPhase, ComparisonSummary, ComparisonView } from '../../shared/ipc';
import type { ComparisonTabPresentation } from '../workspace-tabs';
import { ComparisonGrid } from './comparison-grid';

export type { ComparisonTabPresentation } from '../workspace-tabs';

export function ComparisonTab({
  comparison,
  presentation,
  onPresentationChange,
  themeMode,
}: {
  comparison: ComparisonView;
  presentation: ComparisonTabPresentation;
  onPresentationChange: (next: ComparisonTabPresentation) => void;
  themeMode: 'light' | 'dark';
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [dismissedAttemptId, setDismissedAttemptId] = useState<string | null>(null);
  const [hiddenDiagnosticsAttemptId, setHiddenDiagnosticsAttemptId] = useState<string | null>(null);

  function hideCurrentDiagnostics() {
    if (comparison.lastAttempt?.status === 'invalid-key') {
      setHiddenDiagnosticsAttemptId(comparison.lastAttempt.attemptId);
    }
  }

  function updateDraft(column: string, checked: boolean) {
    hideCurrentDiagnostics();
    const draftKey = checked
      ? [...presentation.draftKey, column]
      : presentation.draftKey.filter((value) => value !== column);
    onPresentationChange({ ...presentation, draftKey });
  }

  function moveDraft(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= presentation.draftKey.length) return;
    hideCurrentDiagnostics();
    const draftKey = [...presentation.draftKey];
    [draftKey[index], draftKey[target]] = [draftKey[target], draftKey[index]];
    onPresentationChange({ ...presentation, draftKey });
  }

  async function begin(kind: 'apply-key' | 'refresh') {
    setActionError(null);
    const outcome = await window.csvViewer.beginComparison(
      kind === 'apply-key'
        ? { kind, comparisonId: comparison.comparisonId, key: presentation.draftKey }
        : { kind, comparisonId: comparison.comparisonId },
    );
    if (outcome.status === 'rejected') setActionError(outcome.fault.message);
  }

  async function swap() {
    setActionError(null);
    const outcome = await window.csvViewer.swapComparison(comparison.comparisonId);
    if (outcome.status === 'rejected') setActionError(outcome.fault.message);
  }

  const attempt = comparison.lastAttempt;
  const diagnostics =
    attempt?.status === 'invalid-key' && hiddenDiagnosticsAttemptId !== attempt.attemptId
      ? attempt.diagnostics
      : null;
  const operation = comparison.operation;
  const operationLabel = operation ? formatOperationLabel(operation.phase) : null;

  return (
    <section className="grid min-h-0 min-w-0 grid-rows-[auto_auto_1fr]" aria-label="CSV comparison">
      <div className="border-b bg-card px-4 py-3">
        <div className="flex flex-wrap items-stretch gap-3">
          <SourceCard
            label="Baseline"
            name={comparison.baseline.file.name}
            path={comparison.baseline.file.path}
          />
          <div className="flex items-center">
            <Button
              type="button"
              variant="outline"
              onClick={swap}
              disabled={Boolean(comparison.operation)}
            >
              <ArrowLeftRight />
              Swap sides
            </Button>
          </div>
          <SourceCard
            label="Candidate"
            name={comparison.candidate.file.name}
            path={comparison.candidate.file.path}
          />
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={!comparison.applied || Boolean(comparison.operation)}
              onClick={() => void begin('refresh')}
            >
              <RefreshCw />
              Refresh comparison
            </Button>
          </div>
        </div>
        <fieldset className="mt-3 rounded-lg border bg-muted/25 p-3">
          <legend className="px-1 text-sm font-semibold">Comparison Key</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {comparison.availableKeyColumns.map((column) => (
              <label key={column} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={presentation.draftKey.includes(column)}
                  disabled={Boolean(comparison.operation)}
                  onChange={(event) => updateDraft(column, event.target.checked)}
                />
                {column}
              </label>
            ))}
          </div>
          {presentation.draftKey.length > 0 ? (
            <div
              className="mt-3 flex flex-wrap items-center gap-2"
              aria-label="Composite key order"
            >
              <span className="text-xs font-semibold uppercase text-muted-foreground">
                Key order
              </span>
              {presentation.draftKey.map((column, index) => (
                <span
                  key={column}
                  className="inline-flex items-center rounded-md border bg-background pl-2 text-sm font-medium"
                >
                  {index + 1}. {column}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move ${column} earlier`}
                    disabled={index === 0 || Boolean(comparison.operation)}
                    onClick={() => moveDraft(index, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move ${column} later`}
                    disabled={
                      index === presentation.draftKey.length - 1 || Boolean(comparison.operation)
                    }
                    onClick={() => moveDraft(index, 1)}
                  >
                    <ArrowDown />
                  </Button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="mt-3 flex items-center gap-3">
            <Button
              type="button"
              disabled={presentation.draftKey.length === 0 || Boolean(comparison.operation)}
              onClick={() => void begin('apply-key')}
            >
              Apply key
            </Button>
            {comparison.applied ? (
              <span className="text-xs text-muted-foreground">
                Applied key: {comparison.applied.key.join(' + ')}
              </span>
            ) : null}
          </div>
          {diagnostics ? (
            <KeyDiagnostics comparison={comparison} diagnostics={diagnostics} />
          ) : null}
        </fieldset>
      </div>

      <div aria-live="polite" aria-atomic="true">
        {operation ? (
          <StatusBanner tone="progress">
            <Loader2 className="size-4 animate-spin" />
            <span className="font-semibold">{operationLabel}</span>
            <span className="text-sm">
              {comparison.applied
                ? 'The current result remains readable until its replacement is ready.'
                : 'The result will appear only after the complete operation succeeds.'}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() =>
                void window.csvViewer.cancelComparison(
                  comparison.comparisonId,
                  operation.operationId,
                )
              }
            >
              Cancel
            </Button>
          </StatusBanner>
        ) : comparison.applied?.freshness.kind === 'outdated' ? (
          <StatusBanner tone="warning">
            <AlertTriangle className="size-4" />
            <strong>Outdated Comparison.</strong> {formatChangedSides(comparison)} changed. Refresh
            explicitly when you are ready.
          </StatusBanner>
        ) : null}
        {attempt?.status === 'cancelled' &&
        comparison.applied &&
        dismissedAttemptId !== attempt.attemptId ? (
          <StatusBanner tone="neutral">
            Comparison cancelled. The previous applied result was preserved.
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => setDismissedAttemptId(attempt.attemptId)}
            >
              Dismiss
            </Button>
          </StatusBanner>
        ) : null}
        {attempt?.status === 'sources-changed' ? (
          <StatusBanner tone="warning">
            {comparison.applied
              ? 'Sources changed while comparing. The previous result was preserved.'
              : 'Sources changed while comparing. No result was applied.'}
          </StatusBanner>
        ) : null}
        {attempt?.status === 'failed' ? (
          <div role="alert">
            <StatusBanner tone="error">
              <strong>Comparison failed.</strong> {attempt.failure.message}
            </StatusBanner>
          </div>
        ) : null}
        {actionError ? (
          <div role="alert">
            <StatusBanner tone="error">{actionError}</StatusBanner>
          </div>
        ) : null}
      </div>

      {comparison.applied ? (
        <div className="grid min-h-0 min-w-0 grid-rows-[auto_1fr]">
          <ComparisonSummaryBar
            summary={comparison.applied.summary}
            presentation={presentation}
            onChange={onPresentationChange}
          />
          <ComparisonGrid
            comparison={comparison}
            applied={comparison.applied}
            rowsMode={presentation.rows}
            columnsMode={presentation.columns}
            themeMode={themeMode}
          />
        </div>
      ) : operation ? (
        <div className="grid place-items-center p-8 text-center">
          <div>
            <Loader2 className="mx-auto mb-3 size-9 animate-spin text-primary" />
            <h2 className="text-lg font-semibold">{operationLabel}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              No result will publish until the complete replacement is ready.
            </p>
          </div>
        </div>
      ) : attempt?.status === 'failed' ? (
        <div className="grid place-items-center p-8 text-center">
          <div className="max-w-lg">
            <AlertTriangle className="mx-auto mb-3 size-10 text-destructive" />
            <h2 className="text-xl font-semibold">Comparison failed</h2>
            <p className="mt-2 text-sm text-muted-foreground">{attempt.failure.message}</p>
            <p className="mt-3 text-sm font-semibold">
              Adjust the draft if needed, then choose Apply key to retry.
            </p>
          </div>
        </div>
      ) : attempt?.status === 'sources-changed' ? (
        <div className="grid place-items-center p-8 text-center">
          <div className="max-w-lg">
            <RefreshCw className="mx-auto mb-3 size-10 text-amber-600" />
            <h2 className="text-xl font-semibold">Sources changed during comparison</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Review the current Working CSVs, then choose Apply key to retry.
            </p>
          </div>
        </div>
      ) : (
        <div className="grid place-items-center p-8 text-center">
          <div className="max-w-lg">
            <Rows3 className="mx-auto mb-3 size-10 text-muted-foreground" />
            <h2 className="text-xl font-semibold">Choose a Comparison Key</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Select one or more shared columns above. Apply key validates presence and uniqueness
              in both complete Working CSVs before computing results.
            </p>
            <p className="mt-3 text-sm font-semibold">
              Source filters, sorts, searches, and Stats state do not limit this comparison.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function SourceCard({ label, name, path }: { label: string; name: string; path: string }) {
  return (
    <div className="min-w-48 flex-1 rounded-lg border bg-background px-3 py-2">
      <p className="text-[11px] font-bold uppercase text-muted-foreground">{label}</p>
      <p className="truncate font-semibold">{name}</p>
      <p className="truncate text-xs text-muted-foreground">{path}</p>
    </div>
  );
}

function StatusBanner({
  tone,
  children,
}: {
  tone: 'progress' | 'warning' | 'error' | 'neutral';
  children: React.ReactNode;
}) {
  const colors =
    tone === 'warning'
      ? 'border-amber-400/50 bg-amber-100/60 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100'
      : tone === 'error'
        ? 'border-destructive/40 bg-destructive/10 text-destructive'
        : tone === 'progress'
          ? 'border-blue-400/40 bg-blue-100/60 dark:bg-blue-950/40'
          : 'border-border bg-muted/40';
  return (
    <div className={`flex flex-wrap items-center gap-2 border-b px-4 py-2 ${colors}`}>
      {children}
    </div>
  );
}

function KeyDiagnostics({
  comparison,
  diagnostics,
}: {
  comparison: ComparisonView;
  diagnostics: NonNullable<
    Extract<ComparisonView['lastAttempt'], { status: 'invalid-key' }>
  >['diagnostics'];
}) {
  const describe = (label: string, value: typeof diagnostics.baseline) =>
    `${label}: ${value.blankRowCount} blank-key rows, ${value.duplicateGroupCount} duplicate-key groups`;
  return (
    <div
      role="alert"
      className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
    >
      <p className="font-semibold">This draft is not a Valid Comparison Key.</p>
      <DiagnosticSide
        summary={describe(comparison.baseline.file.name, diagnostics.baseline)}
        value={diagnostics.baseline}
      />
      <DiagnosticSide
        summary={describe(comparison.candidate.file.name, diagnostics.candidate)}
        value={diagnostics.candidate}
      />
    </div>
  );
}

function DiagnosticSide({
  summary,
  value,
}: {
  summary: string;
  value: NonNullable<
    Extract<ComparisonView['lastAttempt'], { status: 'invalid-key' }>
  >['diagnostics']['baseline'];
}) {
  return (
    <div className="mt-1">
      <p>{summary}</p>
      {value.blankExamples.length > 0 || value.duplicateExamples.length > 0 ? (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer font-semibold">Show bounded examples</summary>
          <ul className="mt-1 list-disc pl-5">
            {value.blankExamples.map((example) => (
              <li key={`blank-${example.rowId}`}>
                Row {example.rowId}:{' '}
                {example.keyValues
                  .map((part) => (part === null ? 'Null' : part === '' ? 'Empty string' : part))
                  .join(' + ')}
              </li>
            ))}
            {value.duplicateExamples.map((example) => (
              <li key={`duplicate-${JSON.stringify(example.keyValues)}`}>
                Key {example.keyValues.join(' + ')} appears {example.rowCount} times (rows{' '}
                {example.rowIds.join(', ')})
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function ComparisonSummaryBar({
  summary,
  presentation,
  onChange,
}: {
  summary: ComparisonSummary;
  presentation: ComparisonTabPresentation;
  onChange: (next: ComparisonTabPresentation) => void;
}) {
  const rows = summary.rows;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-4 py-2">
      <Badge variant="secondary">Changed {rows.changed}</Badge>
      <Badge variant="outline">Baseline-only {rows.baselineOnly}</Badge>
      <Badge variant="outline">Candidate-only {rows.candidateOnly}</Badge>
      <Badge variant="outline">Unchanged {rows.unchanged}</Badge>
      <span className="mr-auto text-xs text-muted-foreground">{rows.total} total rows</span>
      <Toggle
        label="Rows"
        value={presentation.rows}
        options={[
          ['differences', 'Differences'],
          ['all', 'All rows'],
        ]}
        onChange={(rows) => onChange({ ...presentation, rows })}
      />
      <Toggle
        label="Columns"
        value={presentation.columns}
        options={[
          ['changed-first', 'Changed first'],
          ['csv-order', 'All in CSV order'],
        ]}
        onChange={(columns) => onChange({ ...presentation, columns })}
      />
    </div>
  );
}

function Toggle<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: Array<[Value, string]>;
  onChange: (value: Value) => void;
}) {
  return (
    <div
      className="inline-flex items-center rounded-md border bg-background p-0.5"
      aria-label={label}
    >
      {options.map(([option, text]) => (
        <Button
          key={option}
          type="button"
          size="sm"
          variant={value === option ? 'secondary' : 'ghost'}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {text}
        </Button>
      ))}
    </div>
  );
}

function formatOperationLabel(phase: ComparisonPhase): string {
  switch (phase) {
    case 'validating':
      return 'Validating key…';
    case 'comparing':
      return 'Comparing complete CSVs…';
    case 'summarizing':
      return 'Publishing result…';
  }
}

function formatChangedSides(comparison: ComparisonView) {
  const freshness = comparison.applied?.freshness;
  if (!freshness || freshness.kind !== 'outdated') return 'A source';
  return freshness.changedSides
    .map((side) =>
      side === 'baseline' ? comparison.baseline.file.name : comparison.candidate.file.name,
    )
    .join(' and ');
}
