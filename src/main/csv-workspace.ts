import type { ComparisonExecutor } from './comparison-executor';
import { CsvComparisonService } from './csv-comparison-service';
import { CsvDataService } from './csv-data-service';

export type CloseImpact = {
  sessionId: string;
  fileName: string;
  dirty: boolean;
  dependentComparisons: Array<{
    comparisonId: string;
    baselineName: string;
    candidateName: string;
  }>;
};

export type CloseCsvOutcome =
  | { status: 'closed' }
  | { status: 'confirmation-required'; impact: CloseImpact }
  | { status: 'failed'; message: string };

export class CsvWorkspace {
  readonly csvs: CsvDataService;
  readonly comparisons: CsvComparisonService;
  private disposal: Promise<void> | null = null;

  constructor(csvs = new CsvDataService(), executor?: ComparisonExecutor) {
    this.csvs = csvs;
    this.comparisons = new CsvComparisonService(csvs, executor ?? csvs.createComparisonExecutor());
  }

  async closeCsv(sessionId: string, confirmedImpact?: CloseImpact): Promise<CloseCsvOutcome> {
    const session = this.csvs.getSession(sessionId);
    if (!session) return { status: 'closed' };

    const impact = this.closeImpact(sessionId);
    if (requiresConfirmation(impact) && !sameImpact(impact, confirmedImpact)) {
      return { status: 'confirmation-required', impact };
    }
    if (!this.csvs.beginClose(sessionId)) {
      return { status: 'failed', message: 'The Working CSV is already closing.' };
    }

    try {
      await this.comparisons.closeDependents(sessionId);
      await this.csvs.closeSession(sessionId);
      return { status: 'closed' };
    } catch (error) {
      console.error(`Failed to close CSV session ${sessionId}.`, error);
      return {
        status: 'failed',
        message: 'Unable to close the Working CSV and all dependent Comparisons.',
      };
    } finally {
      if (this.csvs.getSession(sessionId)) this.csvs.endClose(sessionId);
    }
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposal = this.disposeWorkspace().catch((error) => {
        this.disposal = null;
        throw error;
      });
    }
    return this.disposal;
  }

  private closeImpact(sessionId: string): CloseImpact {
    const session = this.csvs.getSession(sessionId);
    if (!session) throw new Error('CSV session is no longer active.');
    return {
      sessionId,
      fileName: session.file.name,
      dirty: this.csvs.isDirty(sessionId),
      dependentComparisons: this.comparisons
        .dependentComparisonIds(sessionId)
        .map((comparisonId) => {
          const comparison = this.comparisons.getState(comparisonId);
          if (!comparison) {
            throw new Error(
              `Comparison ${comparisonId} disappeared while calculating close impact.`,
            );
          }
          return {
            comparisonId,
            baselineName: comparison.baseline.file.name,
            candidateName: comparison.candidate.file.name,
          };
        })
        .sort((left, right) => left.comparisonId.localeCompare(right.comparisonId)),
    };
  }

  private async disposeWorkspace(): Promise<void> {
    await this.comparisons.dispose();
    await this.csvs.closeAllSessions();
  }
}

function requiresConfirmation(impact: CloseImpact): boolean {
  return impact.dirty || impact.dependentComparisons.length > 0;
}

function sameImpact(current: CloseImpact, confirmed: CloseImpact | undefined): boolean {
  if (!confirmed) return false;
  return (
    current.sessionId === confirmed.sessionId &&
    current.dirty === confirmed.dirty &&
    current.dependentComparisons.length === confirmed.dependentComparisons.length &&
    current.dependentComparisons.every((dependent, index) => {
      const other = confirmed.dependentComparisons[index];
      return (
        dependent.comparisonId === other.comparisonId &&
        dependent.baselineName === other.baselineName &&
        dependent.candidateName === other.candidateName
      );
    })
  );
}
