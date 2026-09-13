import { useCallback, useSyncExternalStore, type HTMLAttributes } from 'react';
import { AlertTriangle, ArrowDown, ArrowLeftRight, ArrowUp, Loader2, RefreshCw, Rows3 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type {
  ComparisonKeyDiagnostics,
  ComparisonPhase,
  ComparisonSummary,
  ComparisonView,
  SourceKeyDiagnostics,
} from '@csv-viewer/workspace/csv-viewer';
import type { ComparisonTab } from './comparison-tab';
import { ComparisonGrid } from './comparison-grid';

/**
 * The header, status banners, and result body of one Comparison Tab. Every part reads the Tab
 * through `useSyncExternalStore` and runs Tab commands directly; only DOM focus is decided here.
 */
export function ComparisonPanel({ tab, themeMode }: { tab: ComparisonTab; themeMode: 'light' | 'dark' }) {
  return (
    <section className="grid min-h-0 min-w-0 grid-rows-[auto_auto_1fr]" aria-label="CSV comparison">
      <ComparisonHeader tab={tab} />
      <ComparisonStatus tab={tab} />
      <ComparisonBody tab={tab} themeMode={themeMode} />
    </section>
  );
}

function ComparisonHeader({ tab }: { tab: ComparisonTab }) {
  const { comparison, draftKey, acknowledgedAttemptId } = useSyncExternalStore(tab.subscribe, tab.snapshot);
  const attempt = comparison.lastAttempt;
  const diagnostics =
    attempt?.status === 'invalid-key' && acknowledgedAttemptId !== attempt.attemptId ? attempt.diagnostics : null;
  const operation = comparison.operation;

  const focusDiagnostics = useCallback((node: HTMLDivElement | null) => {
    node?.focus();
  }, [attempt?.attemptId]);

  return (
    <div className="border-b bg-card px-4 py-3">
      <div className="flex flex-wrap items-stretch gap-3">
        <SourceCard
          label="Baseline"
          name={comparison.baseline.source.name}
          location={comparison.baseline.source.location}
        />
        <div className="flex items-center">
          <Button type="button" variant="outline" onClick={() => void tab.swap()} disabled={Boolean(operation)}>
            <ArrowLeftRight />
            Swap sides
          </Button>
        </div>
        <SourceCard
          label="Candidate"
          name={comparison.candidate.source.name}
          location={comparison.candidate.source.location}
        />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!comparison.applied || Boolean(operation)}
            onClick={() => void tab.refresh()}
          >
            <RefreshCw />
            Refresh comparison
          </Button>
        </div>
      </div>
      <fieldset className="mt-3 rounded-lg border bg-muted/25 p-3">
        <legend className="px-1 text-sm font-semibold">Comparison Key</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {comparison.availableKeyColumns.map((column, index) => (
            <label key={column} className="flex items-center gap-2 text-sm">
              <input
                autoFocus={index === 0 && !comparison.applied && !operation && !attempt}
                type="checkbox"
                checked={draftKey.includes(column)}
                disabled={Boolean(operation)}
                onChange={(event) => tab.toggleKeyColumn(column, event.target.checked)}
              />
              {column}
            </label>
          ))}
        </div>
        {draftKey.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="Composite key order">
            <span className="text-xs font-semibold uppercase text-muted-foreground">Key order</span>
            {draftKey.map((column, index) => (
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
                  disabled={index === 0 || Boolean(operation)}
                  onClick={() => tab.moveKeyColumn(index, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Move ${column} later`}
                  disabled={index === draftKey.length - 1 || Boolean(operation)}
                  onClick={() => tab.moveKeyColumn(index, 1)}
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
            disabled={draftKey.length === 0 || Boolean(operation)}
            onClick={() => void tab.applyKey()}
          >
            Apply key
          </Button>
          {comparison.applied ? (
            <span className="text-xs text-muted-foreground">Applied key: {comparison.applied.key.join(' + ')}</span>
          ) : null}
        </div>
        {diagnostics ? (
          <KeyDiagnostics comparison={comparison} diagnostics={diagnostics} focusRef={focusDiagnostics} />
        ) : null}
      </fieldset>
    </div>
  );
}

function ComparisonStatus({ tab }: { tab: ComparisonTab }) {
  const { comparison, actionError, acknowledgedAttemptId } = useSyncExternalStore(tab.subscribe, tab.snapshot);
  const operation = comparison.operation;
  const attempt = comparison.lastAttempt;
  return (
    <div>
      {operation ? (
        <StatusBanner tone="progress" aria-live="polite">
          <Loader2 className="size-4 animate-spin" />
          <span className="font-semibold">{formatOperationLabel(operation.phase)}</span>
          <span className="text-sm">
            {comparison.applied
              ? 'The current result remains readable until its replacement is ready.'
              : 'The result will appear only after the complete operation succeeds.'}
          </span>
          <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={() => void tab.cancel()}>
            Cancel
          </Button>
        </StatusBanner>
      ) : comparison.applied?.freshness.kind === 'outdated' ? (
        <StatusBanner tone="warning" aria-live="polite">
          <AlertTriangle className="size-4" />
          <strong>Outdated Comparison.</strong> {formatChangedSides(comparison)} changed. Refresh explicitly when you
          are ready.
        </StatusBanner>
      ) : null}
      {attempt?.status === 'cancelled' && acknowledgedAttemptId !== attempt.attemptId ? (
        <StatusBanner tone="neutral" aria-live="polite">
          {comparison.applied
            ? 'Comparison cancelled. The previous applied result was preserved.'
            : 'Comparison cancelled. No result was applied.'}
          <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => tab.dismissAttempt()}>
            Dismiss
          </Button>
        </StatusBanner>
      ) : null}
      {attempt?.status === 'sources-changed' ? (
        <StatusBanner tone="warning" aria-live="polite">
          {comparison.applied
            ? 'Sources changed while comparing. The previous result was preserved.'
            : 'Sources changed while comparing. No result was applied.'}
        </StatusBanner>
      ) : null}
      {attempt?.status === 'failed' ? (
        <StatusBanner tone="error" role="alert">
          <strong>Comparison failed.</strong> {attempt.failure.message}
        </StatusBanner>
      ) : null}
      {actionError ? (
        <StatusBanner tone="error" role="alert">
          {actionError}
        </StatusBanner>
      ) : null}
    </div>
  );
}

function ComparisonBody({ tab, themeMode }: { tab: ComparisonTab; themeMode: 'light' | 'dark' }) {
  const { comparison } = useSyncExternalStore(tab.subscribe, tab.snapshot);
  const attempt = comparison.lastAttempt;
  if (comparison.applied) {
    return (
      <div className="grid min-h-0 min-w-0 grid-rows-[auto_1fr]">
        <ComparisonSummaryBar tab={tab} summary={comparison.applied.summary} />
        <ComparisonGrid tab={tab} applied={comparison.applied} themeMode={themeMode} />
      </div>
    );
  }
  if (comparison.operation) {
    return (
      <EmptyState
        icon={<Loader2 className="mx-auto mb-3 size-9 animate-spin text-primary" />}
        title={formatOperationLabel(comparison.operation.phase)}
      >
        <p className="mt-2 text-sm text-muted-foreground">No result will publish until the complete replacement is ready.</p>
      </EmptyState>
    );
  }
  if (attempt?.status === 'failed') {
    return (
      <EmptyState icon={<AlertTriangle className="mx-auto mb-3 size-10 text-destructive" />} title="Comparison failed">
        <p className="mt-2 text-sm text-muted-foreground">{attempt.failure.message}</p>
        <p className="mt-3 text-sm font-semibold">Adjust the draft if needed, then choose Apply key to retry.</p>
      </EmptyState>
    );
  }
  if (attempt?.status === 'sources-changed') {
    return (
      <EmptyState
        icon={<RefreshCw className="mx-auto mb-3 size-10 text-amber-600" />}
        title="Sources changed during comparison"
      >
        <p className="mt-2 text-sm text-muted-foreground">Review the current Working CSVs, then choose Apply key to retry.</p>
      </EmptyState>
    );
  }
  return (
    <EmptyState icon={<Rows3 className="mx-auto mb-3 size-10 text-muted-foreground" />} title="Choose a Comparison Key">
      <p className="mt-2 text-sm text-muted-foreground">
        Select one or more shared columns above. Apply key validates presence and uniqueness in both complete Working
        CSVs before computing results.
      </p>
      <p className="mt-3 text-sm font-semibold">
        Source filters, sorts, searches, and Stats state do not limit this comparison.
      </p>
    </EmptyState>
  );
}

function EmptyState({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="grid place-items-center p-8 text-center">
      <div className="max-w-lg">
        {icon}
        <h2 className="text-xl font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function SourceCard({ label, name, location }: { label: string; name: string; location: string }) {
  return (
    <div className="min-w-48 flex-1 rounded-lg border bg-background px-3 py-2">
      <p className="text-[11px] font-bold uppercase text-muted-foreground">{label}</p>
      <p className="truncate font-semibold">{name}</p>
      <p className="truncate text-xs text-muted-foreground">{location}</p>
    </div>
  );
}

function StatusBanner({
  tone,
  children,
  ...attributes
}: {
  tone: 'progress' | 'warning' | 'error' | 'neutral';
  children: React.ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children'>) {
  const colors =
    tone === 'warning'
      ? 'border-amber-400/50 bg-amber-100/60 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100'
      : tone === 'error'
        ? 'border-destructive/40 bg-destructive/10 text-destructive'
        : tone === 'progress'
          ? 'border-blue-400/40 bg-blue-100/60 dark:bg-blue-950/40'
          : 'border-border bg-muted/40';
  return (
    <div {...attributes} className={`flex flex-wrap items-center gap-2 border-b px-4 py-2 ${colors}`}>
      {children}
    </div>
  );
}

function KeyDiagnostics({
  comparison,
  diagnostics,
  focusRef,
}: {
  comparison: ComparisonView;
  diagnostics: ComparisonKeyDiagnostics;
  focusRef: React.RefCallback<HTMLDivElement>;
}) {
  const describe = (label: string, value: SourceKeyDiagnostics) =>
    `${label}: ${value.blankRowCount} blank-key rows, ${value.duplicateGroupCount} duplicate-key groups`;
  return (
    <div
      ref={focusRef}
      tabIndex={-1}
      role="alert"
      className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
    >
      <p className="font-semibold">This draft is not a Valid Comparison Key.</p>
      <DiagnosticSide
        summary={describe(comparison.baseline.source.name, diagnostics.baseline)}
        value={diagnostics.baseline}
      />
      <DiagnosticSide
        summary={describe(comparison.candidate.source.name, diagnostics.candidate)}
        value={diagnostics.candidate}
      />
    </div>
  );
}

function DiagnosticSide({ summary, value }: { summary: string; value: SourceKeyDiagnostics }) {
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
                Key {example.keyValues.join(' + ')} appears {example.rowCount} times (rows {example.rowIds.join(', ')})
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function ComparisonSummaryBar({ tab, summary }: { tab: ComparisonTab; summary: ComparisonSummary }) {
  const state = useSyncExternalStore(tab.subscribe, tab.snapshot);
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
        value={state.rows}
        options={[
          ['differences', 'Differences'],
          ['all', 'All rows'],
        ]}
        onChange={(rows) => tab.setRowsMode(rows)}
      />
      <Toggle
        label="Columns"
        value={state.columns}
        options={[
          ['changed-first', 'Changed first'],
          ['csv-order', 'All in CSV order'],
        ]}
        onChange={(columns) => tab.setColumnsMode(columns)}
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
    <div className="inline-flex items-center rounded-md border bg-background p-0.5" aria-label={label}>
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
    .map((side) => (side === 'baseline' ? comparison.baseline.source.name : comparison.candidate.source.name))
    .join(' and ');
}
