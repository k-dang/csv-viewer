import type {
  ComparisonAttemptOutcomeView,
  ComparisonId,
  ComparisonOperationId,
  ComparisonView,
  CsvViewer,
} from '../../src/contracts/csv-viewer';

/** Shared event-side observations used by every engine's workspace contract fixture. */
export class WorkspaceContractObserver {
  private readonly outcomes = new Map<
    ComparisonOperationId,
    ComparisonAttemptOutcomeView
  >();
  private readonly comparisons = new Map<ComparisonId, ComparisonView>();
  private readonly outcomeWaiters = new Map<
    ComparisonOperationId,
    Array<(outcome: ComparisonAttemptOutcomeView) => void>
  >();
  private readonly unsubscribe: () => void;

  constructor(viewer: CsvViewer) {
    this.unsubscribe = viewer.onEvent((viewerEvent) => {
      if (viewerEvent.type !== 'comparison') return;
      const event = viewerEvent.event;
      if (event.kind === 'closed') {
        this.comparisons.delete(event.comparisonId);
        return;
      }
      this.comparisons.set(event.comparison.comparisonId, event.comparison);
      const attempt = event.comparison.lastAttempt;
      if (!attempt) return;
      this.outcomes.set(attempt.attemptId, attempt);
      const waiters = this.outcomeWaiters.get(attempt.attemptId) ?? [];
      this.outcomeWaiters.delete(attempt.attemptId);
      waiters.forEach((resolve) => resolve(attempt));
    });
  }

  latestComparison(comparisonId: ComparisonId): ComparisonView | null {
    return this.comparisons.get(comparisonId) ?? null;
  }

  awaitComparisonOutcome(
    operationId: ComparisonOperationId,
  ): Promise<ComparisonAttemptOutcomeView> {
    const settled = this.outcomes.get(operationId);
    if (settled) return Promise.resolve(settled);
    return new Promise((resolve) => {
      const waiters = this.outcomeWaiters.get(operationId) ?? [];
      waiters.push(resolve);
      this.outcomeWaiters.set(operationId, waiters);
    });
  }

  dispose(): void {
    this.unsubscribe();
  }
}
