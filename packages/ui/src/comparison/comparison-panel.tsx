import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type HTMLAttributes } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { AlertTriangle, ArrowDown, ArrowLeftRight, ArrowUp, Loader2, RefreshCw, Rows3, Grid2X2, PanelLeft, KeyRound, Search, FileSpreadsheet, ArrowRight } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import type {
  ComparisonKeyDiagnostics,
  ComparisonSummary,
  ComparisonRowsMode,
  ComparisonView,
  SourceKeyDiagnostics,
} from '@csv-viewer/workspace/csv-viewer';
import type { ComparisonTab } from './comparison-tab';
import { ComparisonGrid } from './comparison-grid';
import { ComparisonInspector } from './comparison-inspector';
import type { ComparisonRowsViewState } from './comparison-rows';

/**
 * The header, status banners, and result body of one Comparison Tab. Every part reads the Tab
 * through `useSyncExternalStore` and runs Tab commands directly; only DOM focus is decided here.
 */
export function ComparisonPanel({ tab }: { tab: ComparisonTab }) {
  return (
    <section className="grid min-h-0 min-w-0 grid-rows-[auto_auto_1fr]" aria-label="CSV comparison">
      <ComparisonHeader tab={tab} />
      <ComparisonStatus tab={tab} />
      <ComparisonBody tab={tab} />
    </section>
  );
}

function ComparisonHeader({ tab }: { tab: ComparisonTab }) {
  const { comparison: current, presentedComparison: comparison, preparingResult } = useSyncExternalStore(tab.subscribe, tab.snapshot);
  const busy = Boolean(current.operation) || preparingResult;
  const [editingKey, setEditingKey] = useState(false);
  const token = comparison.applied?.resultToken;
  useEffect(() => {
    setEditingKey(false);
  }, [token]);
  return (
    <div className="border-b bg-card px-4 py-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-base font-semibold">Compare CSVs</h2>
        <ComparisonProgress tab={tab} hidden={!comparison.applied || editingKey} />
        <Button type="button" size="sm" variant="outline" onClick={() => void tab.swap()} disabled={busy}>
          <ArrowLeftRight />
          Swap sides
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!comparison.applied || busy}
          onClick={() => void tab.refresh()}
        >
          <RefreshCw />
          Refresh comparison
        </Button>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <SourceCard label="Baseline" name={comparison.baseline.source.name} location={comparison.baseline.source.location} />
        <ArrowRight className="size-4 text-muted-foreground" />
        <SourceCard label="Candidate" name={comparison.candidate.source.name} location={comparison.candidate.source.location} />
      </div>
      {comparison.applied ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <KeyRound className="size-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">Match rows by</span>
          <code className="rounded border bg-muted px-2 py-1" aria-label={`Applied key: ${comparison.applied.key.join(' + ')}`}>
            {comparison.applied.key.join(' + ')}
          </code>
          <Dialog.Root open={editingKey} onOpenChange={setEditingKey}>
            <Dialog.Trigger disabled={busy} render={<Button variant="ghost" size="sm" className="text-primary" />}>
              Edit key
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/50" />
              <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 max-h-[85vh] w-[calc(100%_-_2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border bg-background p-5 shadow-xl">
                <Dialog.Title className="text-lg font-semibold">Edit Comparison Key</Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-muted-foreground">Choose shared columns whose combined values identify each row in both complete Working CSVs.</Dialog.Description>
                <ComparisonKeyEditor tab={tab} inDialog />
                <div className="mt-3 text-right">
                  <Dialog.Close render={<Button variant="outline" size="sm" />}>{busy ? 'Close' : 'Cancel'}</Dialog.Close>
                </div>
              </Dialog.Popup>
            </Dialog.Portal>
          </Dialog.Root>
          <span className="ml-auto text-muted-foreground">✓ Unique in both files</span>
        </div>
      ) : <ComparisonKeyEditor tab={tab} />}
    </div>
  );
}

function ComparisonKeyEditor({ tab, inDialog = false }: { tab: ComparisonTab; inDialog?: boolean }) {
  const { comparison, presentedComparison, preparingResult, draftKey, acknowledgedAttemptId } = useSyncExternalStore(tab.subscribe, tab.snapshot);
  const attempt = comparison.lastAttempt;
  const diagnostics = attempt?.status === 'invalid-key' && acknowledgedAttemptId !== attempt.attemptId ? attempt.diagnostics : null;
  const operation = comparison.operation;
  const busy = Boolean(operation) || preparingResult;
  const focusDiagnostics = useCallback((node: HTMLDivElement | null) => {
    node?.focus();
  }, [attempt?.attemptId]);
  return (
    <fieldset className="mt-3 rounded-lg border bg-muted/25 p-3">
      <legend className="px-1 text-sm font-semibold">Comparison Key</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {comparison.availableKeyColumns.map((column, index) => (
          <label key={column} className="flex items-center gap-2 text-sm">
            <input
              autoFocus={index === 0 && !presentedComparison.applied && !busy && !attempt}
              type="checkbox"
              checked={draftKey.includes(column)}
              disabled={busy}
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
                disabled={index === 0 || busy}
                onClick={() => tab.moveKeyColumn(index, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Move ${column} later`}
                disabled={index === draftKey.length - 1 || busy}
                onClick={() => tab.moveKeyColumn(index, 1)}
              >
                <ArrowDown />
              </Button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          disabled={draftKey.length === 0 || busy}
          onClick={() => void tab.applyKey()}
        >
          Apply key
        </Button>
        <ComparisonProgress tab={tab} />
        {presentedComparison.applied ? (
          <span className="text-xs text-muted-foreground">Applied key: {presentedComparison.applied.key.join(' + ')}</span>
        ) : null}
      </div>
      {diagnostics ? (
        <KeyDiagnostics comparison={comparison} diagnostics={diagnostics} focusRef={focusDiagnostics} />
      ) : null}
      {inDialog ? <ComparisonRowsError tab={tab} /> : null}
    </fieldset>
  );
}

/** Feedback is delayed, never the result. One indicator covers computation and the first row read. */
function ComparisonProgress({ tab, hidden = false }: { tab: ComparisonTab; hidden?: boolean }) {
  const { comparison, preparingResult, rowsError } = useSyncExternalStore(tab.subscribe, tab.snapshot);
  const busy = Boolean(comparison.operation) || (preparingResult && !rowsError);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!busy) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), 250);
    return () => clearTimeout(timer);
  }, [busy]);
  if (!busy || !visible || hidden) return null;
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
      <span>Comparing CSVs…</span>
      {comparison.operation ? (
        <Button type="button" size="sm" variant="ghost" onClick={() => void tab.cancel()}>
          Cancel
        </Button>
      ) : null}
    </div>
  );
}

function ComparisonRowsError({ tab }: { tab: ComparisonTab }) {
  const { rowsError } = useSyncExternalStore(tab.subscribe, tab.snapshot);
  return rowsError ? (
    <StatusBanner tone="error" role="alert">
      {rowsError}
      <Button size="sm" variant="outline" onClick={() => tab.retryRows()}>Retry rows</Button>
    </StatusBanner>
  ) : null;
}

function ComparisonStatus({ tab }: { tab: ComparisonTab }) {
  const { comparison, presentedComparison, actionError, acknowledgedAttemptId } = useSyncExternalStore(tab.subscribe, tab.snapshot);
  const attempt = comparison.lastAttempt;
  return (
    <div>
      <ComparisonRowsError tab={tab} />
      {presentedComparison.applied?.freshness.kind === 'outdated' ? (
        <StatusBanner tone="warning" aria-live="polite">
          <AlertTriangle className="size-4" />
          <strong>Outdated Comparison.</strong> {formatChangedSides(presentedComparison)} changed. Refresh explicitly when you
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

function ComparisonResults({ tab, applied }: { tab: ComparisonTab; applied: NonNullable<ComparisonView['applied']> }) {
  const { view, rows, search, totalRows, rowsLoading } = useSyncExternalStore(tab.subscribe, tab.snapshot);
  const gridState = useRef<ComparisonRowsViewState>({});
  const inspectorState = useRef<ComparisonRowsViewState>({});
  const previousView = useRef(view);
  const previousToken = useRef<string | null>(null);
  const focusDetail = previousView.current === 'grid' || previousToken.current !== applied.resultToken;
  useEffect(() => { previousView.current = view; previousToken.current = applied.resultToken; }, [view, applied.resultToken]);
  const empty = totalRows === 0;
  const unchanged = applied.summary.rows.unchanged;
  return (
    <div className="comparison-result-body">
      <ComparisonSummaryBar tab={tab} summary={applied.summary} />
      <div className="relative min-h-0 min-w-0" aria-busy={rowsLoading}>
        <div className={`h-full min-h-0${empty ? ' invisible' : ''}`} aria-hidden={empty}>
          {view === 'grid'
            ? <ComparisonGrid tab={tab} applied={applied} viewState={gridState.current} />
            : <ComparisonInspector tab={tab} applied={applied} viewState={inspectorState.current} focusDetail={focusDetail && !empty} />}
        </div>
        {empty ? (
          <div className="absolute inset-0 overflow-auto bg-background">
            <EmptyState
              icon={<Rows3 className="mx-auto mb-3 size-8 text-muted-foreground" />}
              title={rows === 'differences' && !search ? 'No differences' : 'No matching rows'}
              focus={focusDetail}
            >
              <p className="mt-2 text-sm text-muted-foreground">
                {search ? 'Try another search or show all rows.' : 'Choose another result filter to see more rows.'}
              </p>
              <Button className="mt-3" size="sm" variant="outline" onClick={() => {
                tab.setSearch('');
                tab.setRowsMode('all');
              }}>
                Show all rows
              </Button>
            </EmptyState>
          </div>
        ) : null}
      </div>
      <footer className="flex flex-wrap items-center gap-3 border-t px-4 py-2 text-xs text-muted-foreground" aria-live="polite">
        <span>{totalRows === null ? 'Loading rows…' : `${totalRows.toLocaleString()} of ${applied.summary.rows.total.toLocaleString()} rows`}</span>
        {rows === 'differences' && unchanged > 0 && !search ? (
          <>
            <span className="ml-auto">{unchanged.toLocaleString()} unchanged rows hidden</span>
            <Button size="xs" variant="ghost" onClick={() => tab.setRowsMode('all')}>Show all rows</Button>
          </>
        ) : <span className="ml-auto">Read-only comparison</span>}
      </footer>
    </div>
  );
}

function ComparisonBody({ tab }: { tab: ComparisonTab }) {
  const { presentedComparison: comparison } = useSyncExternalStore(tab.subscribe, tab.snapshot);
  if (comparison.applied) return <ComparisonResults tab={tab} applied={comparison.applied} />;
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

function EmptyState({ icon, title, children, focus = false }: { icon: React.ReactNode; title: string; children: React.ReactNode; focus?: boolean }) {
  return (
    <div className="grid place-items-center p-8 text-center">
      <div className="max-w-lg">
        {icon}
        <h2 tabIndex={focus ? -1 : undefined} ref={element => { if (focus) element?.focus(); }} className="text-xl font-semibold outline-none">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function SourceCard({ label, name, location }: { label: string; name: string; location: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2" title={location}>
      <FileSpreadsheet className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className={`text-xs ${label === 'Baseline' ? 'comparison-baseline-label' : 'comparison-candidate-label'}`}>{label}</p>
      </div>
    </div>
  );
}

function StatusBanner({
  tone,
  children,
  ...attributes
}: {
  tone: 'warning' | 'error' | 'neutral';
  children: React.ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children'>) {
  const colors =
    tone === 'warning'
      ? 'border-amber-400/50 bg-amber-100/60 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100'
      : tone === 'error'
        ? 'border-destructive/40 bg-destructive/10 text-destructive'
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
  const filters: Array<[ComparisonRowsMode, string, number]> = [
    ['differences', 'Differences', summary.rows.total - summary.rows.unchanged],
    ['all', 'All rows', summary.rows.total],
    ['changed', 'Changed', summary.rows.changed],
    ['baseline-only', 'Baseline-only', summary.rows.baselineOnly],
    ['candidate-only', 'Candidate-only', summary.rows.candidateOnly],
    ['unchanged', 'Unchanged', summary.rows.unchanged],
  ];
  return (
    <div className="comparison-controls">
      <div role="group" aria-label="Filter results" className="flex flex-wrap items-center gap-1 border-b pb-2">
        {filters.map(([value, label, count]) => (
          <Button
            key={value}
            size="sm"
            variant={state.rows === value ? 'secondary' : 'ghost'}
            aria-pressed={state.rows === value}
            disabled={state.preparingResult}
            onClick={() => tab.setRowsMode(value)}
          >
            {label} <span className="tabular-nums">{count.toLocaleString()}</span>
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 pt-3">
        <div role="group" aria-label="Comparison view" className="inline-flex rounded-md border bg-background p-0.5">
          <Button size="sm" disabled={state.preparingResult} aria-pressed={state.view === 'grid'} variant={state.view === 'grid' ? 'secondary' : 'ghost'} onClick={() => tab.setView('grid')}>
            <Grid2X2 />
            Grid
          </Button>
          <Button size="sm" disabled={state.preparingResult} aria-pressed={state.view === 'inspector'} variant={state.view === 'inspector' ? 'secondary' : 'ghost'} onClick={() => tab.setView('inspector')}>
            <PanelLeft />
            Inspector
          </Button>
        </div>
        <span className="ml-auto text-xs text-muted-foreground">{state.view === 'grid' ? 'Select a row to inspect' : state.totalRows === null ? 'Loading rows…' : state.selection ? `Row ${state.selection.index + 1} of ${state.totalRows.toLocaleString()}` : 'Review one row at a time'}</span>
      </div>
      <div className="flex flex-wrap items-center gap-3 py-3">
        <label className="relative min-w-40 flex-1 sm:max-w-64">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <span className="sr-only">Find a comparison row or value</span>
          <Input
            className="h-9 pl-8 text-sm"
            type="search"
            value={state.search}
            disabled={state.preparingResult}
            placeholder="Find a row or value…"
            onChange={event => tab.setSearch(event.target.value)}
          />
        </label>
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" disabled={state.preparingResult} checked={state.changedOnly} onChange={event => tab.setChangedOnly(event.target.checked)} />
          Changed fields only
        </label>
        <label>
          <span className="sr-only">Row order</span>
          <select
            className="rounded-md border bg-background px-2 py-2 text-xs"
            value={state.order}
            disabled={state.preparingResult}
            onChange={event => tab.setOrder(event.target.value === 'csv-order' ? 'csv-order' : 'changed-first')}
          >
            <option value="changed-first">Changed first</option>
            <option value="csv-order">CSV order</option>
          </select>
        </label>
      </div>
      <div className="flex gap-4 pb-2 text-[11px] text-muted-foreground">
        <span className="comparison-baseline-label">− Baseline value</span>
        <span className="comparison-candidate-label">+ Candidate value</span>
      </div>
    </div>
  );
}

function formatChangedSides(comparison: ComparisonView) {
  const freshness = comparison.applied?.freshness;
  if (!freshness || freshness.kind !== 'outdated') return 'A source';
  return freshness.changedSides
    .map((side) => (side === 'baseline' ? comparison.baseline.source.name : comparison.candidate.source.name))
    .join(' and ');
}
