import type {
  ComparisonColumnsMode,
  ComparisonRowsMode,
  ComparisonView,
  ComparisonWindow,
  CsvViewer,
} from '@csv-viewer/workspace/csv-viewer';
import { Cause, Effect } from 'effect';

export type ComparisonTabState = {
  comparison: ComparisonView;
  /** The Draft Comparison Key: chosen columns in key order, not yet applied. */
  draftKey: string[];
  rows: ComparisonRowsMode;
  columns: ComparisonColumnsMode;
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
 * superseded result or view mode is dropped; late requests never update state after `dispose`.
 */
export class ComparisonTab {
  private state: ComparisonTabState;
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly viewer: Pick<CsvViewer, 'call'>,
    comparison: ComparisonView,
  ) {
    this.state = {
      comparison,
      draftKey: comparison.applied?.key ?? [],
      rows: 'differences',
      columns: 'changed-first',
      actionError: null,
      acknowledgedAttemptId: null,
    };
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
    this.set({ comparison });
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
    if (rows !== this.state.rows) this.set({ rows });
  }

  setColumnsMode(columns: ComparisonColumnsMode): void {
    if (columns !== this.state.columns) this.set({ columns });
  }

  /** Hides the cancelled-attempt banner for the current attempt. */
  dismissAttempt(): void {
    const attempt = this.state.comparison.lastAttempt;
    if (attempt) this.set({ acknowledgedAttemptId: attempt.attemptId });
  }

  /** Starts validating and applying the Draft Comparison Key. Outcomes arrive through `receive`. */
  applyKey(): Promise<void> {
    const { draftKey } = this.state;
    return Effect.runPromise(draftKey.length === 0 ? Effect.void : this.begin({ kind: 'apply-key', key: draftKey }));
  }

  refresh(): Promise<void> {
    return Effect.runPromise(this.state.comparison.applied ? this.begin({ kind: 'refresh' }) : Effect.void);
  }

  swap(): Promise<void> {
    return Effect.runPromise(this.command('Unable to swap comparison sides.', Effect.gen({ self: this }, function* () {
      const outcome = yield* fromPromise(() => this.viewer.call({ operation: 'comparison.swap', comparisonId: this.comparisonId }));
      if (outcome.status === 'rejected') return outcome.fault.message;
      this.receive(outcome.comparison);
      return null;
    })));
  }

  /** Asks to cancel the operation in flight. No-op when none is. */
  cancel(): Promise<void> {
    const operation = this.state.comparison.operation;
    if (!operation) return Effect.runPromise(Effect.void);
    return Effect.runPromise(this.command('Unable to cancel comparison.', fromPromise(() => this.viewer.call({
      operation: 'comparison.cancel',
      comparisonId: this.comparisonId,
      operationId: operation.operationId,
    })).pipe(Effect.as(null))));
  }

  /**
   * One window of the applied result under the current view mode. Resolves null when there is no
   * applied result, or when the result or the view mode moved on while the request was in flight,
   * so the caller shows nothing rather than a superseded window.
   */
  rows(offset: number, limit: number): Promise<ComparisonWindow | null> {
    return Effect.runPromise(this.requestRows(offset, limit));
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private readonly requestRows = Effect.fnUntraced(function* (this: ComparisonTab, offset: number, limit: number) {
    const { comparison, rows, columns } = this.state;
    const applied = comparison.applied;
    if (this.disposed || !applied) return null;
    const outcome = yield* fromPromise(() => this.viewer.call({
      operation: 'comparison.get-window',
      comparisonId: comparison.comparisonId,
      resultToken: applied.resultToken,
      offset,
      limit,
      rows,
      columns,
    }));
    const current = this.state;
    const stale =
      this.disposed ||
      current.comparison.applied?.resultToken !== applied.resultToken ||
      current.rows !== rows ||
      current.columns !== columns;
    if (stale || outcome.status !== 'ready') return null;
    return outcome.window;
  });

  private begin(request: { kind: 'apply-key'; key: string[] } | { kind: 'refresh' }): Effect.Effect<void> {
    return this.command('Unable to start comparison.', Effect.gen({ self: this }, function* () {
      const outcome = yield* fromPromise(() => this.viewer.call({ operation: 'comparison.begin', comparisonId: this.comparisonId, ...request }));
      return outcome.status === 'rejected' ? outcome.fault.message : null;
    }));
  }

  /** Runs one command; the operation returns the rejection message, or null when accepted. */
  private readonly command = Effect.fnUntraced(function* (
    this: ComparisonTab,
    fallback: string,
    operation: Effect.Effect<string | null, unknown>,
  ) {
    if (this.disposed) return;
    this.set({ actionError: null });
    const actionError = yield* operation.pipe(Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      return Effect.succeed(error instanceof Error && error.message ? error.message : fallback);
    }));
    if (actionError !== null && !this.disposed) this.set({ actionError });
  });

  private editDraft(draftKey: string[]): void {
    const attempt = this.state.comparison.lastAttempt;
    this.set({
      draftKey,
      acknowledgedAttemptId:
        attempt?.status === 'invalid-key' ? attempt.attemptId : this.state.acknowledgedAttemptId,
    });
  }

  private set(patch: Partial<ComparisonTabState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/** Adapt the CsvViewer Promise boundary while preserving its rejection for row-window callers. */
function fromPromise<A>(operation: () => Promise<A>) {
  return Effect.tryPromise({ try: operation, catch: (error) => error });
}
