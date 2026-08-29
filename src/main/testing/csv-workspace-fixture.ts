import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopWorkspaceHost } from '../desktop-workspace-host';
import type {
  ComparisonAttemptOutcomeView,
  ComparisonId,
  ComparisonOperationId,
  ComparisonView,
  ConfirmWorkspaceCloseOutcome,
  CsvDialectOptions,
  CsvEditState,
  CsvSourceId,
  CsvViewer,
  WorkingCsvId,
  WorkingCsvView,
  WorkspaceCloseImpact,
} from '../../shared/csv-viewer-contract';
import type { ComparisonExecutor } from '../../workspace/comparison-executor';
import type { CsvWorkspaceImplementation } from '../../workspace/csv-workspace-implementation';
import { createTestCsvWorkspace } from '../../workspace/testing/create-test-csv-workspace';
import type { WorkspaceContractFixture } from './workspace-contract-fixture';

/** Scripted answers for the desktop prompts a real user would see. */
export type ScriptedPrompts = {
  sourceChoices: Array<string | null>;
  exportChoices: Array<string | null>;
  discardChoices: boolean[];
  defaultExportPaths: string[];
  sourceConflictCount: number;
  /** Runs while the export destination prompt is open, so tests can hold it there. */
  holdExportPrompt?: () => Promise<void>;
};

/**
 * A CsvViewer backed by a temporary directory and scripted prompts. Tests drive the public seam;
 * the desktop host supplies CSV Source identity, description, and export delivery.
 */
export class CsvWorkspaceFixture implements WorkspaceContractFixture {
  private readonly outcomes = new Map<ComparisonOperationId, ComparisonAttemptOutcomeView>();
  private readonly comparisons = new Map<ComparisonId, ComparisonView>();
  private readonly outcomeWaiters = new Map<
    ComparisonOperationId,
    Array<(outcome: ComparisonAttemptOutcomeView) => void>
  >();
  private readonly unsubscribe: () => void;

  private constructor(
    readonly directory: string,
    private readonly workspace: CsvWorkspaceImplementation,
    readonly host: DesktopWorkspaceHost,
    readonly prompts: ScriptedPrompts,
  ) {
    this.unsubscribe = workspace.onEvent((viewerEvent) => {
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

  get viewer(): CsvViewer {
    return this.workspace;
  }

  static async create(executor?: ComparisonExecutor): Promise<CsvWorkspaceFixture> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'csv-workspace-'));
    const prompts: ScriptedPrompts = {
      sourceChoices: [],
      exportChoices: [],
      discardChoices: [],
      defaultExportPaths: [],
      sourceConflictCount: 0,
    };
    let workspace: CsvWorkspaceImplementation | undefined;
    try {
      const host = new DesktopWorkspaceHost(
        {
          chooseSource: async () => prompts.sourceChoices.shift() ?? null,
          chooseExportDestination: async (defaultPath) => {
            prompts.defaultExportPaths.push(defaultPath);
            await prompts.holdExportPrompt?.();
            return prompts.exportChoices.shift() ?? null;
          },
          showSourceConflict: async () => {
            prompts.sourceConflictCount += 1;
          },
          confirmDiscardChanges: async () => prompts.discardChoices.shift() ?? true,
        },
        path.join(directory, 'recent-sources.json'),
      );
      workspace = createTestCsvWorkspace(host, executor);
      return new CsvWorkspaceFixture(directory, workspace, host, prompts);
    } catch (error) {
      await workspace?.dispose().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  file(fileName: string): string {
    return path.join(this.directory, fileName);
  }

  async writeSource(fileName: string, contents: string): Promise<string> {
    const filePath = this.file(fileName);
    await writeFile(filePath, contents);
    return filePath;
  }

  sourceId(filePath: string): Promise<CsvSourceId> {
    return this.host.registerSource(filePath);
  }

  async registerSource(fileName: string, contents: string): Promise<CsvSourceId> {
    return this.sourceId(await this.writeSource(fileName, contents));
  }

  async removeSource(fileName: string): Promise<void> {
    await unlink(this.file(fileName));
  }

  /** Opens an existing CSV Source and fails the test when the workspace rejects it. */
  async open(filePath: string, options?: CsvDialectOptions): Promise<WorkingCsvView> {
    const result = await this.viewer.call({
      operation: 'csv.open-recent',
      sourceId: await this.sourceId(filePath),
      options,
    });
    if (result.status !== 'opened') {
      throw new Error(result.status === 'failed' ? result.message : `CSV Source was ${result.status}.`);
    }
    return result.workingCsv;
  }

  /** Writes a CSV Source and opens it as a Working CSV. */
  async openSource(fileName: string, contents: string, options?: CsvDialectOptions): Promise<WorkingCsvView> {
    return this.open(await this.writeSource(fileName, contents), options);
  }

  captureNextExport(fileName: string): () => Promise<string> {
    const destinationPath = this.file(fileName);
    this.prompts.exportChoices.push(destinationPath);
    return () => readFile(destinationPath, 'utf8');
  }

  editState(workingCsvId: WorkingCsvId): Promise<CsvEditState> {
    return this.viewer.call({ operation: 'csv.get-edit-state', workingCsvId });
  }

  latestComparison(comparisonId: ComparisonId): ComparisonView | null {
    return this.comparisons.get(comparisonId) ?? null;
  }

  confirmClose(confirmedImpact?: WorkspaceCloseImpact): Promise<ConfirmWorkspaceCloseOutcome> {
    return this.workspace.confirmClose(confirmedImpact);
  }

  disposeWorkspace(): Promise<void> {
    return this.workspace.dispose();
  }

  awaitComparisonOutcome(operationId: ComparisonOperationId): Promise<ComparisonAttemptOutcomeView> {
    const settled = this.outcomes.get(operationId);
    if (settled) return Promise.resolve(settled);
    return new Promise((resolve) => {
      const waiters = this.outcomeWaiters.get(operationId) ?? [];
      waiters.push(resolve);
      this.outcomeWaiters.set(operationId, waiters);
    });
  }

  async dispose(): Promise<void> {
    this.unsubscribe();
    try {
      await this.workspace.dispose();
    } finally {
      await rm(this.directory, { recursive: true, force: true });
    }
  }
}
