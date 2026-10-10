import type {
  ComparisonRow,
  ComparisonRowOrder,
  ComparisonRowsMode,
  ComparisonView,
  ComparisonWindow,
  CsvViewer,
} from '@csv-viewer/workspace/csv-viewer';

export const comparisonPageSize = 100;
const rowReadFailure = 'Unable to load comparison rows. Try again.';

export type ComparisonTabState = {
  comparison: ComparisonView;
  /** The projection shown to the user; replacements wait for their first row window. */
  presentedComparison: ComparisonView;
  preparingResult: boolean;
  /** Progress becomes visible only after computation or first-row preparation lasts 250 ms. */
  progressVisible: boolean;
  /** The Draft Comparison Key: chosen columns in key order, not yet applied. */
  draftKey: string[];
  rows: ComparisonRowsMode;
  view: 'grid' | 'inspector';
  order: ComparisonRowOrder;
  search: string;
  /** Grid hides globally unchanged columns; Inspector hides unchanged fields of its selected row. */
  changedOnly: boolean;
  queryVersion: number;
  /** The settled row count stays visible while the next query loads. */
  totalRows: number | null;
  rowsLoading: boolean;
  selection: { row: ComparisonRow; index: number } | null;
  selectionLoading: boolean;
  rowsError: string | null;
  /** The failure of the last command, cleared by the next command. */
  actionError: string | null;
  /** The attempt whose feedback the user already acted on: a dismissed banner or an edited draft. */
  acknowledgedAttemptId: string | null;
};

/**
 * One Comparison Tab: the Aligned Comparison it presents, its Draft Comparison Key, its result-view
 * state, and every command the views run against the Comparison.
 *
 * Rules kept here so they cannot drift: commands read their inputs from this state and are no-ops
 * without them; a rejected outcome or a failed call becomes `actionError`; editing the draft hides
 * the current invalid-key diagnostics; `receive` ignores older projections; a row window from a
 * superseded result or query is dropped; late requests never update state after `dispose`.
 * A replacement projection is presented together with its first page and selected row.
 */
export class ComparisonTab {
  private state: ComparisonTabState;
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  private selectionRequest = 0;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private progressTimer: ReturnType<typeof setTimeout> | undefined;
  private committedSearch = '';
  private preparationRequest = 0;
  private firstWindow: { window: ComparisonWindow; queryVersion: number } | null = null;

  constructor(
    private readonly viewer: Pick<CsvViewer, 'call'>,
    comparison: ComparisonView,
  ) {
    this.state = {
      comparison,
      presentedComparison: comparison,
      preparingResult: false,
      progressVisible: false,
      draftKey: comparison.applied?.key ?? [],
      rows: 'differences',
      view: 'inspector',
      order: 'changed-first',
      search: '',
      changedOnly: true,
      queryVersion: 0,
      totalRows: null,
      rowsLoading: true,
      selection: null,
      selectionLoading: false,
      rowsError: null,
      actionError: null,
      acknowledgedAttemptId: null,
    };
    if (comparison.operation) this.delayProgress();
  }

  get comparisonId(): string {
    return this.state.comparison.comparisonId;
  }

  readonly snapshot = (): ComparisonTabState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** A newer projection of this Comparison. Older or equal versions are ignored. */
  receive(comparison: ComparisonView): void {
    if (this.disposed || comparison.version <= this.state.comparison.version) return;
    const token = comparison.applied?.resultToken;
    const changed = token !== this.state.comparison.applied?.resultToken;
    if (changed && !token) {
      this.preparationRequest += 1;
      this.resetQuery({ comparison, presentedComparison: comparison });
      return;
    }
    if (token === this.state.presentedComparison.applied?.resultToken) {
      this.set({ comparison, presentedComparison: comparison });
    } else this.set({ comparison });
    if (changed) void this.prepareResult();
  }

  toggleKeyColumn(column: string, included: boolean): void {
    const { draftKey } = this.state;
    if (included === draftKey.includes(column)) return;
    this.editDraft(included ? [...draftKey, column] : draftKey.filter((value) => value !== column));
  }

  moveKeyColumn(index: number, direction: -1 | 1): void {
    const target = index + direction;
    const draftKey = [...this.state.draftKey];
    if (target < 0 || target >= draftKey.length) return;
    [draftKey[index], draftKey[target]] = [draftKey[target], draftKey[index]];
    this.editDraft(draftKey);
  }

  setRowsMode(rows: ComparisonRowsMode): void {
    if (rows !== this.state.rows) this.resetQuery({ rows });
  }

  setOrder(order: ComparisonRowOrder): void {
    if (order !== this.state.order) this.resetQuery({ order });
  }

  setSearch(search: string): void {
    if (this.disposed || search === this.state.search) return;
    this.set({ search });
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = undefined;
      if (this.committedSearch === this.state.search) return;
      this.committedSearch = this.state.search;
      this.resetQuery({});
    }, 150);
  }

  setView(view: ComparisonTabState['view']): void {
    if (view !== this.state.view) this.set({ view });
  }

  setChangedOnly(changedOnly: boolean): void {
    if (changedOnly !== this.state.changedOnly) this.set({ changedOnly });
  }

  retryRows(): void {
    if (this.state.preparingResult) void this.prepareResult();
    else this.resetQuery({});
  }

  selectRow(row: ComparisonRow, index: number): void {
    this.selectionRequest += 1;
    this.set({ selection: { row, index }, selectionLoading: false });
  }

  inspectRow(row: ComparisonRow, index: number): void {
    this.selectRow(row, index);
    this.setView('inspector');
  }

  /** Previous/next reads the containing page, preserving a newer row choice while it loads. */
  async selectIndex(index: number): Promise<void> {
    if (index < 0 || this.state.rowsLoading || this.state.totalRows === null || index >= this.state.totalRows) return;
    const request = ++this.selectionRequest;
    const version = this.state.queryVersion;
    this.set({ selectionLoading: true });
    try {
      const offset = Math.floor(index / comparisonPageSize) * comparisonPageSize;
      const window = await this.rows(offset, comparisonPageSize);
      if (this.disposed || request !== this.selectionRequest) return;
      const row = window?.rows[index - offset];
      if (window && row) this.set({ selection: { row, index }, rowsError: null });
    } catch {
      this.rowsFailed(version);
    } finally {
      if (!this.disposed && request === this.selectionRequest) this.set({ selectionLoading: false });
    }
  }

  /** Hides the cancelled-attempt banner for the current attempt. */
  dismissAttempt(): void {
    const attempt = this.state.comparison.lastAttempt;
    if (attempt) this.set({ acknowledgedAttemptId: attempt.attemptId });
  }

  /** Starts validating and applying the Draft Comparison Key. Outcomes arrive through `receive`. */
  applyKey(): Promise<void> {
    const { draftKey } = this.state;
    return draftKey.length === 0 ? Promise.resolve() : this.begin({ kind: 'apply-key', key: draftKey });
  }

  refresh(): Promise<void> {
    return this.state.comparison.applied ? this.begin({ kind: 'refresh' }) : Promise.resolve();
  }

  swap(): Promise<void> {
    return this.command('Unable to swap comparison sides.', async () => {
      const outcome = await this.viewer.call({ operation: 'comparison.swap', comparisonId: this.comparisonId });
      if (outcome.status === 'rejected') return outcome.fault.message;
      this.receive(outcome.comparison);
      return null;
    });
  }

  /** Asks to cancel the operation in flight. No-op when none is. */
  cancel(): Promise<void> {
    const operation = this.state.comparison.operation;
    if (!operation) return Promise.resolve();
    return this.command('Unable to cancel comparison.', async () => {
      await this.viewer.call({
        operation: 'comparison.cancel',
        comparisonId: this.comparisonId,
        operationId: operation.operationId,
      });
      return null;
    });
  }

  /**
   * One window of the applied result under the current row query. Resolves null when there is no
   * applied result, or when the result or query moved on while the request was in flight,
   * so the caller shows nothing rather than a superseded window.
   */
  async rows(offset: number, limit: number): Promise<ComparisonWindow | null> {
    const { presentedComparison: comparison, preparingResult, rows, order, queryVersion } = this.state;
    const applied = comparison.applied;
    if (this.disposed || !applied || preparingResult) return null;
    const cached = this.firstWindow;
    if (offset === 0 && limit <= comparisonPageSize && cached?.queryVersion === queryVersion) {
      // A superseding query can invalidate cached reads as well as database reads.
      await Promise.resolve();
      if (this.disposed || this.state.queryVersion !== queryVersion || this.state.preparingResult) return null;
      return { ...cached.window, rows: cached.window.rows.slice(0, limit) };
    }
    const outcome = await this.viewer.call({
      operation: 'comparison.get-window',
      comparisonId: comparison.comparisonId,
      resultToken: applied.resultToken,
      offset,
      limit,
      rows,
      search: this.committedSearch,
      order,
    });
    if (this.disposed || this.state.queryVersion !== queryVersion || this.state.preparingResult) return null;
    if (outcome.status === 'rejected') throw new Error(outcome.fault.message);
    return outcome.status === 'ready' ? outcome.window : null;
  }

  /** Replaces the previous query's selection with its first row, then preserves later choices. */
  receiveRows(window: ComparisonWindow, version: number): void {
    if (this.disposed || this.state.preparingResult || version !== this.state.queryVersion) return;
    // A refreshed grid may finish a later cached page before the new query's first page.
    if (this.state.rowsLoading && window.offset !== 0) return;
    const first = window.rows[0];
    const previousSelection = this.state.rowsLoading ? null : this.state.selection;
    const selection = previousSelection ?? (window.offset === 0 && first && !this.state.selectionLoading
      ? { row: first, index: 0 }
      : null);
    this.set({ totalRows: window.totalRowCount, rowsLoading: false, selection, rowsError: null });
  }

  rowsFailed(version: number): void {
    if (!this.disposed && !this.state.preparingResult && version === this.state.queryVersion) {
      this.set({ rowsError: rowReadFailure });
    }
  }

  private resetQuery(patch: Partial<ComparisonTabState>): void {
    this.selectionRequest += 1;
    this.firstWindow = null;
    if (this.state.preparingResult && !patch.comparison) {
      this.set(patch);
      void this.prepareResult();
      return;
    }
    this.set({
      ...patch,
      queryVersion: this.state.queryVersion + 1,
      // Keep the settled result readable while a filter loads, including its empty state.
      totalRows: patch.comparison ? null : this.state.totalRows,
      rowsLoading: true,
      // Removing the result also discards its selection.
      selection: patch.comparison ? null : this.state.selection,
      selectionLoading: false,
      rowsError: null,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    clearTimeout(this.searchTimer);
    clearTimeout(this.progressTimer);
  }

  /** Warms the first page, then reveals its projection, count, and selected row together. */
  private async prepareResult(): Promise<void> {
    const { comparison, rows, order, queryVersion } = this.state;
    const applied = comparison.applied;
    if (this.disposed || !applied) return;
    const request = ++this.preparationRequest;
    this.selectionRequest += 1;
    this.set({ rowsLoading: true, rowsError: null, selectionLoading: false });
    try {
      const outcome = await this.viewer.call({
        operation: 'comparison.get-window', comparisonId: comparison.comparisonId,
        resultToken: applied.resultToken, offset: 0, limit: comparisonPageSize,
        rows, search: this.committedSearch, order,
      });
      if (this.disposed || request !== this.preparationRequest || queryVersion !== this.state.queryVersion) return;
      if (outcome.status === 'rejected') throw new Error(outcome.fault.message);
      if (outcome.status !== 'ready') return;
      const { window } = outcome;
      const version = queryVersion + 1;
      this.firstWindow = { window, queryVersion: version };
      this.set({
        presentedComparison: this.state.comparison,
        queryVersion: version,
        totalRows: window.totalRowCount,
        selection: window.rows[0] ? { row: window.rows[0], index: 0 } : null,
        rowsLoading: false,
        rowsError: null,
      });
    } catch {
      if (!this.disposed && request === this.preparationRequest) this.set({ rowsError: rowReadFailure });
    }
  }

  private begin(request: { kind: 'apply-key'; key: string[] } | { kind: 'refresh' }): Promise<void> {
    return this.command('Unable to start comparison.', async () => {
      const outcome = await this.viewer.call({ operation: 'comparison.begin', comparisonId: this.comparisonId, ...request });
      return outcome.status === 'rejected' ? outcome.fault.message : null;
    });
  }

  /** Runs one command; the operation returns the rejection message, or null when accepted. */
  private async command(fallback: string, operation: () => Promise<string | null>): Promise<void> {
    if (this.disposed) return;
    this.set({ actionError: null });
    let actionError: string | null;
    try {
      actionError = await operation();
    } catch (error) {
      actionError = error instanceof Error && error.message ? error.message : fallback;
    }
    if (actionError !== null && !this.disposed) this.set({ actionError });
  }

  private editDraft(draftKey: string[]): void {
    const attempt = this.state.comparison.lastAttempt;
    this.set({
      draftKey,
      acknowledgedAttemptId:
        attempt?.status === 'invalid-key' ? attempt.attemptId : this.state.acknowledgedAttemptId,
    });
  }

  private set(patch: Partial<ComparisonTabState>): void {
    const wasComparing = this.isComparing();
    this.state = { ...this.state, ...patch };
    this.state.preparingResult = this.state.comparison.applied?.resultToken !== this.state.presentedComparison.applied?.resultToken;
    if (!this.isComparing()) {
      clearTimeout(this.progressTimer);
      this.progressTimer = undefined;
      this.state.progressVisible = false;
    } else if (!wasComparing) this.delayProgress();
    for (const listener of this.listeners) listener();
  }

  private isComparing(): boolean {
    return Boolean(this.state.comparison.operation) || (this.state.preparingResult && !this.state.rowsError);
  }

  /** The tab owns one timer across operation phases and the first-row read. */
  private delayProgress(): void {
    this.progressTimer = setTimeout(() => {
      this.progressTimer = undefined;
      if (!this.disposed && this.isComparing()) this.set({ progressVisible: true });
    }, 250);
  }
}
