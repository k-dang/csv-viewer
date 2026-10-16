import { Effect, Result } from 'effect';
import type {
  ComparisonRow,
  ComparisonRowOrder,
  ComparisonRowsMode,
  ComparisonView,
  ComparisonWindow,
  CsvViewer,
} from '@csv-viewer/workspace/csv-viewer';
import { openQueryDebounce, ViewRuntime, type QueryDebounce } from '../csv/csv-tab';

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
  /** Advances when the displayed row query changes, so grids refresh their pages. */
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
 * superseded result or query is interrupted; late requests never update state after `dispose`.
 * A replacement projection is presented together with its first page and selected row.
 * Search commits through the shared query debounce.
 */
export class ComparisonTab {
  private readonly runtime: ViewRuntime<ComparisonTabState>;
  private readonly searchDebounce: QueryDebounce;
  private disposed = false;
  private progressTimer: ReturnType<typeof setTimeout> | undefined;
  private committedSearch = '';
  private firstWindow: ComparisonWindow | null = null;

  constructor(
    private readonly viewer: Pick<CsvViewer, 'call'>,
    comparison: ComparisonView,
  ) {
    const initial: ComparisonTabState = {
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
    this.runtime = ViewRuntime.open(initial);
    this.searchDebounce = openQueryDebounce('', (search) => this.commitSearch(search));
    if (comparison.operation) this.delayProgress();
  }

  private get state(): ComparisonTabState {
    return this.runtime.snapshot();
  }

  get comparisonId(): string {
    return this.state.comparison.comparisonId;
  }

  readonly snapshot = (): ComparisonTabState => this.runtime.snapshot();

  readonly subscribe = (listener: () => void): (() => void) => this.runtime.subscribe(listener);

  /** A newer projection of this Comparison. Older or equal versions are ignored. */
  receive(comparison: ComparisonView): void {
    if (this.disposed || comparison.version <= this.state.comparison.version) return;
    const token = comparison.applied?.resultToken;
    const changed = token !== this.state.comparison.applied?.resultToken;
    if (changed && !token) {
      this.resetQuery({ comparison, presentedComparison: comparison });
      return;
    }
    if (token === this.state.presentedComparison.applied?.resultToken) {
      this.set({ comparison, presentedComparison: comparison });
    } else this.set({ comparison });
    if (changed) this.prepareResult();
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
    this.searchDebounce.push(search);
  }

  setView(view: ComparisonTabState['view']): void {
    if (view !== this.state.view) this.set({ view });
  }

  setChangedOnly(changedOnly: boolean): void {
    if (changedOnly !== this.state.changedOnly) this.set({ changedOnly });
  }

  retryRows(): void {
    if (this.state.preparingResult) this.prepareResult();
    else this.resetQuery({});
  }

  selectRow(row: ComparisonRow, index: number): void {
    this.runtime.interrupt('selection');
    this.set({ selection: { row, index }, selectionLoading: false });
  }

  inspectRow(row: ComparisonRow, index: number): void {
    this.selectRow(row, index);
    this.setView('inspector');
  }

  /**
   * Previous/next reads the containing page on the selection fiber. `rows()` would fork a second
   * read that can still call `receiveRows` after a newer choice interrupts `selection`.
   */
  async selectIndex(index: number): Promise<void> {
    if (index < 0 || this.state.rowsLoading || this.state.totalRows === null || index >= this.state.totalRows) return;
    this.set({ selectionLoading: true });
    const offset = Math.floor(index / comparisonPageSize) * comparisonPageSize;
    const fiber = this.runtime.fork('selection', this.loadRowsEffect(offset, comparisonPageSize).pipe(
      Effect.tap((window) => Effect.sync(() => {
        const row = window?.rows[index - offset];
        this.set({ selection: row ? { row, index } : this.state.selection, selectionLoading: false });
      })),
    ));
    await this.runtime.join(fiber);
  }

  /** Hides feedback for the current attempt. */
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
   * Loads a page and settles its count, selection, and error here. Resolves null when unavailable,
   * failed, or superseded; views only deliver the returned page to their grid.
   */
  rows(offset: number, limit: number): Promise<ComparisonWindow | null> {
    if (this.disposed || this.state.preparingResult) return Promise.resolve(null);
    return this.loadRows(offset, limit);
  }

  /** Every page, including replacement preparation and Inspector navigation, settles here. */
  private loadRows(offset: number, limit: number): Promise<ComparisonWindow | null> {
    const fiber = this.runtime.fork(this.runtime.nextKey('rows'), this.loadRowsEffect(offset, limit));
    return this.runtime.join(fiber);
  }

  private loadRowsEffect(offset: number, limit: number): Effect.Effect<ComparisonWindow | null> {
    const { comparison, rows, order } = this.state;
    const applied = comparison.applied;
    if (this.disposed || !applied) return Effect.succeed(null);
    const cached = this.firstWindow;
    // Cached reads yield too, so a query change can interrupt them before delivery.
    const loader = offset === 0 && limit <= comparisonPageSize && cached
      ? Effect.promise(() => Promise.resolve({ ...cached, rows: cached.rows.slice(0, limit) }))
      : this.fetchWindow(comparison.comparisonId, applied.resultToken, offset, limit, rows, order);
    return Effect.result(loader).pipe(Effect.map((fetched) => {
      if (Result.isFailure(fetched)) {
        if (!this.disposed) this.set({ rowsError: rowReadFailure });
        return null;
      }
      const window = fetched.success;
      if (window === null || this.disposed) return null;
      this.publishWindow(window, applied);
      return window;
    }));
  }

  private fetchWindow(
    comparisonId: string,
    resultToken: string,
    offset: number,
    limit: number,
    rows: ComparisonRowsMode,
    order: ComparisonTabState['order'],
  ): Effect.Effect<ComparisonWindow | null, string> {
    return Effect.tryPromise({
      try: () => this.viewer.call({
        operation: 'comparison.get-window',
        comparisonId,
        resultToken,
        offset,
        limit,
        rows,
        search: this.committedSearch,
        order,
      }),
      catch: () => 'failed',
    }).pipe(Effect.flatMap((outcome) => {
      switch (outcome.status) {
        case 'ready':
          return Effect.succeed(outcome.window);
        case 'rejected':
          return Effect.fail('rejected');
        case 'result-replaced':
        case 'comparison-not-found':
          return Effect.succeed(null);
        default: {
          const exhaustive: never = outcome;
          return Effect.die(exhaustive);
        }
      }
    }));
  }

  private publishWindow(window: ComparisonWindow, applied: NonNullable<ComparisonView['applied']>): void {
    if (this.state.preparingResult) {
      const previous = this.state.selection;
      const selectedIndex = previous && JSON.stringify(applied.key) === JSON.stringify(this.state.presentedComparison.applied?.key)
        ? window.rows.findIndex((row) => JSON.stringify(row.keyValues) === JSON.stringify(previous.row.keyValues)) : -1;
      this.firstWindow = window;
      this.set({
        presentedComparison: this.state.comparison,
        queryVersion: this.state.queryVersion + 1,
        totalRows: window.totalRowCount,
        selection: selectedIndex >= 0 ? { row: window.rows[selectedIndex], index: window.offset + selectedIndex }
          : window.rows[0] ? { row: window.rows[0], index: window.offset } : null,
        rowsLoading: false,
        rowsError: null,
      });
      return;
    }
    this.receiveRows(window);
  }

  /** Replaces the previous query's selection with its first row, then preserves later choices. */
  private receiveRows(window: ComparisonWindow): void {
    // A refreshed grid may finish a later cached page before the new query's first page.
    if (this.state.rowsLoading && window.offset !== 0) return;
    const first = window.rows[0];
    const previousSelection = this.state.rowsLoading ? null : this.state.selection;
    const selection = previousSelection ?? (window.offset === 0 && first && !this.state.selectionLoading
      ? { row: first, index: 0 }
      : null);
    this.set({ totalRows: window.totalRowCount, rowsLoading: false, selection, rowsError: null });
  }

  private commitSearch(search: string): void {
    if (this.disposed || this.committedSearch === search) return;
    this.committedSearch = search;
    this.resetQuery({});
  }

  private resetQuery(patch: Partial<ComparisonTabState>): void {
    this.runtime.interrupt('selection');
    this.firstWindow = null;
    if (this.state.preparingResult && !patch.comparison) {
      this.set(patch);
      this.prepareResult();
      return;
    }
    this.runtime.interruptPrefixed('rows:');
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
    this.searchDebounce.dispose();
    clearTimeout(this.progressTimer);
    this.runtime.dispose();
  }

  /** Keeps the displayed result intact until loadRows can publish its replacement's first page. */
  private prepareResult(): void {
    this.runtime.interruptPrefixed('rows:');
    this.runtime.interrupt('selection');
    this.firstWindow = null;
    this.set({ rowsLoading: true, rowsError: null, selectionLoading: false });
    void this.loadRows(0, comparisonPageSize);
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
    const next: ComparisonTabState = { ...this.state, ...patch };
    next.preparingResult = next.comparison.applied?.resultToken !== next.presentedComparison.applied?.resultToken;
    if (!this.comparing(next)) {
      clearTimeout(this.progressTimer);
      this.progressTimer = undefined;
      next.progressVisible = false;
    } else if (!wasComparing) this.delayProgress();
    this.runtime.update(next);
  }

  private isComparing(): boolean {
    return this.comparing(this.state);
  }

  private comparing(state: ComparisonTabState): boolean {
    return Boolean(state.comparison.operation) || (state.preparingResult && !state.rowsError);
  }

  /** The tab owns one timer across operation phases and the first-row read. */
  private delayProgress(): void {
    this.progressTimer = setTimeout(() => {
      this.progressTimer = undefined;
      if (!this.disposed && this.isComparing()) this.set({ progressVisible: true });
    }, 250);
  }
}
