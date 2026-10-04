import { Effect } from 'effect';
import type {
  CloseImpact,
  ComparisonCandidate,
  ComparisonEvent,
  CsvDialectOptions,
  CsvCapacityExceeded,
  CsvSourceId,
  CsvViewer,
  CsvViewerEvent,
  CsvViewerIntent,
  CsvViewerRequest,
  OpenCsvResult,
  RecentCsvSource,
  WorkingCsvView,
} from '@csv-viewer/workspace/csv-viewer';
import { buildDialectOptions, isDialectError, type CsvHeaderMode } from '../csv/csv-dialect';
import { CsvTab } from '../csv/csv-tab';
import { ComparisonTab } from '../comparison/comparison-tab';

export type RendererTab =
  | { kind: 'csv'; id: string; tab: CsvTab }
  | { kind: 'comparison'; id: string; tab: ComparisonTab };

export type RendererWorkspaceState = {
  delimiter: string;
  headerMode: CsvHeaderMode;
  dialectError: string | null;
  recentSources: RecentCsvSource[];
  tabs: RendererTab[];
  activeTabId: string | null;
  isOpening: boolean;
  error: string | null;
  fatalError: string | null;
};

/** The runtime supplies confirmation display and acquisition of dropped files. */
export type RendererWorkspaceHost = {
  confirmClose(sourceName: string, impact: CloseImpact): boolean | Promise<boolean>;
  acquireDroppedSource(file: File): Promise<CsvSourceId | CsvCapacityExceeded>;
};

type OpenRequest = Extract<CsvViewerRequest, { operation: 'csv.open' | 'csv.open-recent' | 'csv.reopen' }>;
export type DroppedCsvItem = { name: string; file: File | null };
type CsvOpenOperation = { name: string | null; open: (options: CsvDialectOptions) => Effect.Effect<OpenCsvResult, string> };

/**
 * Owns the renderer's Tabs and their lifetime, independently of React commits. Commands and
 * CsvViewer events use the same current state. Runtime data ownership remains behind CsvViewer.
 * Create at application startup and dispose when the session ends to invalidate outstanding work.
 */
export class RendererWorkspace {
  private state: RendererWorkspaceState = {
    delimiter: '',
    headerMode: 'auto',
    dialectError: null,
    recentSources: [],
    tabs: [],
    activeTabId: null,
    isOpening: false,
    error: null,
    fatalError: null,
  };
  private readonly listeners = new Set<() => void>();
  private stopped = false;
  private recentSourcesRequest = 0;
  private stopEvents: () => void = () => {};
  /** Closed IDs matter only to the single Open/Reopen response currently in flight. */
  private openingClosedCsvs: Set<string> | null = null;
  private readonly closingTabs = new Set<string>();
  /** Remember close events until the affected Comparison open responses have arrived. */
  private readonly comparisonOpens = new Set<Set<string>>();

  constructor(private readonly viewer: CsvViewer, private readonly host: RendererWorkspaceHost) {
    this.stopEvents = viewer.onEvent((event) => this.receive(event));
    // A runtime can replay a fatal event synchronously while subscribing.
    if (this.stopped) this.stopEvents();
    void this.refreshRecentSources();
  }

  readonly snapshot = (): RendererWorkspaceState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  updateDialect(delimiter: string, headerMode: CsvHeaderMode): void {
    if (!this.stopped) this.set({ delimiter, headerMode });
  }

  open(): Promise<void> {
    return this.runOpen((options) => ({ operation: 'csv.open', options }), 'Unable to open CSV.');
  }

  /** Opens one drop as a batch, retaining successes and reporting all rejected items together. */
  openDroppedFiles(items: DroppedCsvItem[]): Promise<void> {
    const failures: string[] = [];
    const operations: CsvOpenOperation[] = [];
    for (const item of items) {
      const file = item.file;
      if (!file || !/\.(csv|tsv|txt)$/i.test(item.name)) {
        failures.push(`${item.name}: Only CSV, TSV, and TXT files are supported. Folders cannot be opened.`);
        continue;
      }
      operations.push({
        name: item.name,
        open: (options) => Effect.gen({ self: this }, function* () {
          const sourceId = yield* requestEffect(() => this.host.acquireDroppedSource(file), 'Unable to open CSV.');
          if (sourceId instanceof Object) return sourceId;
          // The host retains acquired sources until CsvViewer receives them. Complete that
          // handoff even after stopping, then discard the response at the renderer boundary.
          return yield* requestEffect(() => this.viewer.call({ operation: 'csv.open', sourceId, options }), 'Unable to open CSV.');
        }),
      });
    }
    return Effect.runPromise(this.runOpens(operations, failures));
  }

  openRecent(sourceId: CsvSourceId): Promise<void> {
    return this.runOpen((options) => ({ operation: 'csv.open-recent', sourceId, options }), 'Unable to open recent CSV.');
  }

  reopen(): Promise<void> {
    const tab = this.activeTab();
    if (tab?.kind !== 'csv') return Promise.resolve();
    return this.runOpen(
      (options) => ({ operation: 'csv.reopen', workingCsvId: tab.tab.workingCsvId, options }),
      'Unable to reopen CSV.',
      tab,
    );
  }

  select(tabId: string): void {
    if (!this.stopped && this.state.tabs.some((tab) => tab.id === tabId)) this.set({ activeTabId: tabId });
  }

  /** Read CSV Tabs at unload time; their Unexported Changes are never mirrored here. */
  hasUnexportedChanges(): boolean {
    return this.state.tabs.some((tab) => tab.kind === 'csv' && tab.tab.snapshot().editState.hasUnexportedChanges);
  }

  candidates(): Promise<{ baseline: WorkingCsvView; candidates: ComparisonCandidate[] } | null> {
    return Effect.runPromise(this.listCandidates());
  }

  private readonly listCandidates = Effect.fnUntraced(function* (
    this: RendererWorkspace,
  ) {
    const tab = this.activeTab();
    if (tab?.kind !== 'csv' || !this.current(tab)) return null;
    return yield* requestEffect(
      () => this.viewer.call({ operation: 'comparison.get-candidates', baselineId: tab.tab.workingCsvId }),
      'Unable to list comparison candidates.',
    ).pipe(
      Effect.map((candidates) => this.current(tab) ? { baseline: tab.tab.snapshot().workingCsv, candidates } : null),
      Effect.catch((message) => Effect.sync(() => {
        if (this.current(tab)) this.set({ error: message });
        return null;
      })),
    );
  });

  openComparison(baselineId: string, candidateId: string): Promise<boolean> {
    return Effect.runPromise(this.createComparison(baselineId, candidateId));
  }

  private readonly createComparison = Effect.fnUntraced(function* (
    this: RendererWorkspace,
    baselineId: string,
    candidateId: string,
  ) {
    const baseline = this.csvEntry(baselineId);
    const candidate = this.csvEntry(candidateId);
    if (!baseline || !candidate || !this.current(baseline) || !this.current(candidate)) return false;
    const closedComparisons = new Set<string>();
    this.comparisonOpens.add(closedComparisons);
    return yield* Effect.gen({ self: this }, function* () {
      const result = yield* requestEffect(
        () => this.viewer.call({ operation: 'comparison.open', baselineId, candidateId }), 'Unable to open Comparison.',
      );
      if (!this.current(baseline) || !this.current(candidate)) return false;
      if (result.status === 'rejected') {
        this.set({ error: result.fault.message });
        return false;
      }
      const comparison = result.comparison;
      if (closedComparisons.has(comparison.comparisonId)) return false;
      const id = `comparison:${comparison.comparisonId}`;
      const existing = this.state.tabs.find((tab) => tab.id === id);
      if (existing) {
        this.comparisonEvent({ kind: 'changed', comparison });
        this.select(id);
      } else {
        this.set({
          tabs: [...this.state.tabs, { kind: 'comparison', id, tab: new ComparisonTab(this.viewer, comparison) }],
          activeTabId: id,
        });
      }
      return true;
    }).pipe(
      Effect.catch((message) => Effect.sync(() => {
        if (this.current(baseline) && this.current(candidate)) this.set({ error: message });
        return false;
      })),
      Effect.ensuring(Effect.sync(() => { this.comparisonOpens.delete(closedComparisons); })),
    );
  });

  close(tabId: string = this.state.activeTabId ?? ''): Promise<void> {
    return Effect.runPromise(this.closeTab(tabId));
  }

  private readonly closeTab = Effect.fnUntraced(function* (
    this: RendererWorkspace,
    tabId: string,
  ) {
    const tab = this.state.tabs.find((entry) => entry.id === tabId);
    if (!tab || !this.current(tab) || this.closingTabs.has(tab.id)) return;
    this.closingTabs.add(tab.id);
    return yield* Effect.gen({ self: this }, function* () {
      if (tab.kind === 'comparison') {
        const result = yield* requestEffect(
          () => this.viewer.call({ operation: 'comparison.close', comparisonId: tab.tab.comparisonId }), 'Unable to close the Tab.',
        );
        if (this.stopped) return;
        if (result.status === 'failed') this.set({ error: result.failure.message });
        else this.comparisonEvent({ kind: 'closed', comparisonId: result.comparisonId });
        return;
      }
      const workingCsvId = tab.tab.workingCsvId;
      let result = yield* requestEffect(() => this.viewer.call({ operation: 'csv.close', workingCsvId }), 'Unable to close the Tab.');
      while (this.current(tab) && result.status === 'confirmation-required') {
        const impact = result.impact;
        const confirmed = yield* requestEffect(
          () => Promise.resolve(this.host.confirmClose(tab.tab.snapshot().workingCsv.source.name, impact)), 'Unable to close the Tab.',
        );
        if (!confirmed || !this.current(tab)) return;
        result = yield* requestEffect(
          () => this.viewer.call({ operation: 'csv.close', workingCsvId, confirmedImpact: impact }), 'Unable to close the Tab.',
        );
      }
      if (!this.current(tab)) return;
      if (result.status === 'failed') {
        this.set({ error: result.failure.message });
        return;
      }
      if (result.status !== 'closed') return;
      this.openingClosedCsvs?.add(workingCsvId);
      const ids = new Set(result.closedComparisonIds.map((id) => `comparison:${id}`));
      ids.add(tab.id);
      this.removeTabs(ids);
    }).pipe(
      Effect.catch((message) => Effect.sync(() => {
        if (this.current(tab)) this.set({ error: message });
      })),
      Effect.ensuring(Effect.sync(() => { this.closingTabs.delete(tab.id); })),
    );
  });

  /** Retires renderer objects only. The application runtime owns disposal of the data workspace. */
  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  private runOpen(
    request: (options: CsvDialectOptions) => OpenRequest,
    fallback: string,
    reopening?: Extract<RendererTab, { kind: 'csv' }>,
  ): Promise<void> {
    return Effect.runPromise(this.runOpens([{
      name: null,
      open: (options) => requestEffect(() => this.viewer.call(request(options)), fallback),
    }], [], reopening));
  }

  private readonly runOpens = Effect.fnUntraced(function* (
    this: RendererWorkspace,
    operations: CsvOpenOperation[],
    failures: string[],
    reopening?: Extract<RendererTab, { kind: 'csv' }>,
  ) {
    if (this.stopped || this.state.isOpening) return;
    const options = buildDialectOptions(this.state.delimiter, this.state.headerMode);
    if (isDialectError(options)) {
      this.set({ dialectError: options });
      return;
    }
    this.set({ dialectError: null });
    const closedCsvs = new Set<string>();
    this.openingClosedCsvs = closedCsvs;
    this.recentSourcesRequest += 1;
    this.set({ isOpening: true });
    return yield* Effect.gen({ self: this }, function* () {
      for (const operation of operations) {
        if (this.stopped) return;
        const result = yield* operation.open(options).pipe(Effect.catch((message) => Effect.succeed({ status: 'failed' as const, message })));
        if (this.stopped || (reopening && !this.current(reopening))) return;
        if (result.status === 'failed' || result.status === 'capacity-exceeded') {
          failures.push(operation.name ? `${operation.name}: ${result.message}` : result.message);
        } else if (result.status !== 'cancelled' && !closedCsvs.has(result.workingCsv.workingCsvId)) {
          this.applyOpen(result);
        }
      }
      if (!this.stopped && (!reopening || this.current(reopening)) && failures.length > 0) {
        this.set({ error: failures.join('\n') });
      }
    }).pipe(Effect.ensuring(Effect.gen({ self: this }, function* () {
      this.openingClosedCsvs = null;
      if (!this.stopped) {
        this.set({ isOpening: false });
        yield* this.loadRecentSources();
      }
    })));
  });

  private applyOpen(result: Extract<OpenCsvResult, { status: 'opened' | 'already-open' }>): void {
    const workingCsv = result.workingCsv;
    const existing = this.csvEntry(workingCsv.workingCsvId);
    if (existing) {
      if (result.status === 'opened') existing.tab.replaceWorkingCsv(workingCsv);
      this.set({ activeTabId: existing.id, error: null });
    } else {
      const id = `csv:${workingCsv.workingCsvId}`;
      this.set({ tabs: [...this.state.tabs, { kind: 'csv', id, tab: new CsvTab(this.viewer, workingCsv) }], activeTabId: id, error: null });
    }
  }

  private receive(event: CsvViewerEvent): void {
    if (this.stopped) return;
    if (event.type === 'comparison') this.comparisonEvent(event.event);
    else if (event.type === 'view-export') this.csvEntry(event.event.workingCsvId)?.tab.receiveExport(event.event);
    else if (event.type === 'intent') this.intent(event.intent);
    else {
      this.stop();
      this.set({ fatalError: event.message, isOpening: false });
    }
  }

  private intent(intent: CsvViewerIntent): void {
    const handlers = {
      'open-csv': () => void this.open(),
      'reopen-csv': () => void this.reopen(),
      'close-tab': () => void this.close(),
      'export-csv': () => {
        const tab = this.activeTab();
        if (tab?.kind === 'csv') void tab.tab.export();
      },
    } satisfies Record<CsvViewerIntent, () => void>;
    handlers[intent]();
  }

  private comparisonEvent(event: ComparisonEvent): void {
    if (event.kind === 'closed') {
      for (const pending of this.comparisonOpens) pending.add(event.comparisonId);
      this.removeTabs(new Set([`comparison:${event.comparisonId}`]));
      return;
    }
    const id = `comparison:${event.comparison.comparisonId}`;
    const tab = this.state.tabs.find((entry) => entry.id === id);
    if (tab?.kind === 'comparison') tab.tab.receive(event.comparison);
  }

  private activeTab(): RendererTab | undefined {
    return this.state.tabs.find((tab) => tab.id === this.state.activeTabId);
  }

  private csvEntry(workingCsvId: string): Extract<RendererTab, { kind: 'csv' }> | undefined {
    return this.state.tabs.find((tab): tab is Extract<RendererTab, { kind: 'csv' }> =>
      tab.kind === 'csv' && tab.tab.workingCsvId === workingCsvId,
    );
  }

  private current(tab: RendererTab): boolean {
    return !this.stopped && this.state.tabs.some((entry) => entry.id === tab.id && entry.tab === tab.tab);
  }

  private removeTabs(ids: Set<string>): void {
    // Closing the Active Tab selects its next neighbor, then its previous neighbor.
    let { tabs, activeTabId } = this.state;
    for (const id of ids) {
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index < 0) continue;
      tabs[index].tab.dispose();
      tabs = tabs.filter((tab) => tab.id !== id);
      if (activeTabId === id) activeTabId = tabs[index]?.id ?? tabs[index - 1]?.id ?? null;
    }
    this.set({ tabs, activeTabId });
    if (this.state.tabs.length === 0) void this.refreshRecentSources();
  }

  /** Refresh history when the empty workspace appears or an open attempt finishes there. */
  private refreshRecentSources(): Promise<void> {
    return Effect.runPromise(this.loadRecentSources());
  }

  private readonly loadRecentSources = Effect.fnUntraced(function* (
    this: RendererWorkspace,
  ) {
    if (this.stopped || !this.viewer.capabilities.recentCsvSources || this.state.isOpening || this.state.tabs.length > 0) return;
    const request = ++this.recentSourcesRequest;
    const recentSources = yield* requestEffect(
      () => this.viewer.call({ operation: 'csv.get-recent-sources' }), 'Unable to list recent CSV sources.',
    ).pipe(Effect.catch(() => Effect.succeed([])));
    if (!this.stopped && request === this.recentSourcesRequest) this.set({ recentSources });
  });

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopEvents();
    for (const tab of this.state.tabs) tab.tab.dispose();
  }
  private set(patch: Partial<RendererWorkspaceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/** Adapts runtime Promises at their boundary while retaining the user's original error message. */
function requestEffect<A>(operation: () => Promise<A>, fallback: string): Effect.Effect<A, string> {
  return Effect.tryPromise({ try: operation, catch: (error) => error instanceof Error ? error.message : fallback });
}
