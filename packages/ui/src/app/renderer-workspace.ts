import type {
  CloseImpact,
  ComparisonCandidate,
  ComparisonEvent,
  CsvDialectOptions,
  CsvSourceId,
  CsvViewer,
  CsvViewerEvent,
  CsvViewerIntent,
  CsvViewerRequest,
  OpenCsvResult,
  WorkingCsvView,
} from '@csv-viewer/workspace/csv-viewer';
import { CsvTab } from '../csv/csv-tab';
import { ComparisonTab } from '../comparison/comparison-tab';

export type RendererTab =
  | { kind: 'csv'; id: string; tab: CsvTab }
  | { kind: 'comparison'; id: string; tab: ComparisonTab };

export type RendererWorkspaceState = {
  tabs: RendererTab[];
  activeTabId: string | null;
  isOpening: boolean;
  error: string | null;
  fatalError: string | null;
};

/** The view supplies form validation and confirmation display; lifecycle stays in the workspace. */
export type RendererWorkspaceHost = {
  openOptions(): CsvDialectOptions | null;
  confirmClose(sourceName: string, impact: CloseImpact): boolean | Promise<boolean>;
};

type OpenRequest = Extract<CsvViewerRequest, { operation: 'csv.open' | 'csv.open-recent' | 'csv.reopen' }>;

/**
 * Owns the renderer's Tabs and their lifetime, independently of React commits. Commands and
 * CsvViewer events use the same current state. Runtime data ownership remains behind CsvViewer.
 * Create once on mounting the renderer, and dispose on unmount to invalidate outstanding work.
 */
export class RendererWorkspace {
  private state: RendererWorkspaceState = {
    tabs: [],
    activeTabId: null,
    isOpening: false,
    error: null,
    fatalError: null,
  };
  private readonly listeners = new Set<() => void>();
  private stopped = false;
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
  }

  readonly snapshot = (): RendererWorkspaceState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  open(): Promise<void> {
    return this.runOpen((options) => ({ operation: 'csv.open', options }), 'Unable to open CSV.');
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

  cycle(direction: 1 | -1): void {
    if (this.stopped || this.state.tabs.length < 2) return;
    const index = this.state.tabs.findIndex((tab) => tab.id === this.state.activeTabId);
    if (index < 0) return;
    this.select(this.state.tabs[(index + direction + this.state.tabs.length) % this.state.tabs.length].id);
  }

  /** Read CSV Tabs at unload time; their Unexported Changes are never mirrored here. */
  hasUnexportedChanges(): boolean {
    return this.state.tabs.some((tab) => tab.kind === 'csv' && tab.tab.snapshot().editState.hasUnexportedChanges);
  }

  async candidates(): Promise<{ baseline: WorkingCsvView; candidates: ComparisonCandidate[] } | null> {
    const tab = this.activeTab();
    if (tab?.kind !== 'csv' || !this.current(tab)) return null;
    try {
      const candidates = await this.viewer.call({
        operation: 'comparison.get-candidates', baselineId: tab.tab.workingCsvId,
      });
      return this.current(tab) ? { baseline: tab.tab.snapshot().workingCsv, candidates } : null;
    } catch (error) {
      if (this.current(tab)) this.set({ error: error instanceof Error ? error.message : 'Unable to list comparison candidates.' });
      return null;
    }
  }

  async openComparison(baselineId: string, candidateId: string): Promise<boolean> {
    const baseline = this.csvEntry(baselineId);
    const candidate = this.csvEntry(candidateId);
    if (!baseline || !candidate || !this.current(baseline) || !this.current(candidate)) return false;
    const closedComparisons = new Set<string>();
    this.comparisonOpens.add(closedComparisons);
    try {
      const result = await this.viewer.call({ operation: 'comparison.open', baselineId, candidateId });
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
    } catch (error) {
      if (this.current(baseline) && this.current(candidate)) this.set({ error: error instanceof Error ? error.message : 'Unable to open Comparison.' });
      return false;
    } finally {
      this.comparisonOpens.delete(closedComparisons);
    }
  }

  async close(tabId: string = this.state.activeTabId ?? ''): Promise<void> {
    const tab = this.state.tabs.find((entry) => entry.id === tabId);
    if (!tab || !this.current(tab) || this.closingTabs.has(tab.id)) return;
    this.closingTabs.add(tab.id);
    try {
      if (tab.kind === 'comparison') {
        const result = await this.viewer.call({ operation: 'comparison.close', comparisonId: tab.tab.comparisonId });
        if (this.stopped) return;
        if (result.status === 'failed') this.set({ error: result.failure.message });
        else this.comparisonEvent({ kind: 'closed', comparisonId: result.comparisonId });
        return;
      }
      const workingCsvId = tab.tab.workingCsvId;
      let result = await this.viewer.call({ operation: 'csv.close', workingCsvId });
      while (this.current(tab) && result.status === 'confirmation-required') {
        const confirmed = await this.host.confirmClose(tab.tab.snapshot().workingCsv.source.name, result.impact);
        if (!confirmed || !this.current(tab)) return;
        result = await this.viewer.call({ operation: 'csv.close', workingCsvId, confirmedImpact: result.impact });
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
    } catch (error) {
      if (this.current(tab)) this.set({ error: error instanceof Error ? error.message : 'Unable to close the Tab.' });
    } finally {
      this.closingTabs.delete(tab.id);
    }
  }

  /** Retires renderer objects only. The application runtime owns disposal of the data workspace. */
  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  private async runOpen(
    request: (options: CsvDialectOptions) => OpenRequest,
    fallback: string,
    reopening?: Extract<RendererTab, { kind: 'csv' }>,
  ): Promise<void> {
    if (this.stopped || this.state.isOpening) return;
    const options = this.host.openOptions();
    if (!options) return;
    const closedCsvs = new Set<string>();
    this.openingClosedCsvs = closedCsvs;
    this.set({ isOpening: true });
    try {
      const result = await this.viewer.call(request(options));
      if (this.stopped || (reopening && !this.current(reopening))) return;
      if ((result.status === 'opened' || result.status === 'already-open') && closedCsvs.has(result.workingCsv.workingCsvId)) return;
      this.applyOpen(result);
    } catch (error) {
      if (!this.stopped && (!reopening || this.current(reopening))) this.set({ error: error instanceof Error ? error.message : fallback });
    } finally {
      this.openingClosedCsvs = null;
      if (!this.stopped) this.set({ isOpening: false });
    }
  }

  private applyOpen(result: OpenCsvResult): void {
    if (result.status === 'cancelled') return;
    if (result.status === 'failed' || result.status === 'capacity-exceeded') {
      this.set({ error: result.message });
      return;
    }
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
  }

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
