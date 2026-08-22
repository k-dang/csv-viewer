import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopWorkspaceHost } from '../desktop-workspace-host';
import type {
  ComparisonAttemptOutcomeView,
  ComparisonOperationId,
  CsvDialectOptions,
  CsvSourceId,
  WorkingCsvView,
} from '../../shared/csv-viewer-contract';
import type { ComparisonExecutor } from '../../workspace/comparison-executor';
import { CsvWorkspace } from '../../workspace/csv-workspace';

/** Scripted answers for the desktop prompts a real user would see. */
export type ScriptedPrompts = {
  sourceChoices: Array<string | null>;
  exportChoices: Array<string | null>;
  defaultExportPaths: string[];
  sourceConflictCount: number;
  /** Runs while the export destination prompt is open, so tests can hold it there. */
  holdExportPrompt?: () => Promise<void>;
};

/**
 * A CsvWorkspace backed by a temporary directory and scripted prompts. Tests drive the workspace
 * seam only; the desktop host supplies CSV Source identity, description, and export delivery.
 */
export class CsvWorkspaceFixture {
  private readonly outcomes = new Map<ComparisonOperationId, ComparisonAttemptOutcomeView>();
  private readonly outcomeWaiters = new Map<
    ComparisonOperationId,
    Array<(outcome: ComparisonAttemptOutcomeView) => void>
  >();
  private readonly unsubscribe: () => void;

  private constructor(
    readonly directory: string,
    readonly workspace: CsvWorkspace,
    readonly host: DesktopWorkspaceHost,
    readonly prompts: ScriptedPrompts,
  ) {
    this.unsubscribe = workspace.onComparisonEvent((event) => {
      if (event.kind !== 'changed') return;
      const attempt = event.comparison.lastAttempt;
      if (!attempt) return;
      this.outcomes.set(attempt.attemptId, attempt);
      const waiters = this.outcomeWaiters.get(attempt.attemptId) ?? [];
      this.outcomeWaiters.delete(attempt.attemptId);
      waiters.forEach((resolve) => resolve(attempt));
    });
  }

  static async create(executor?: ComparisonExecutor): Promise<CsvWorkspaceFixture> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'csv-workspace-'));
    const prompts: ScriptedPrompts = {
      sourceChoices: [],
      exportChoices: [],
      defaultExportPaths: [],
      sourceConflictCount: 0,
    };
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
      },
      path.join(directory, 'recent-sources.json'),
    );
    return new CsvWorkspaceFixture(directory, new CsvWorkspace(host, executor), host, prompts);
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

  /** Opens an existing CSV Source and fails the test when the workspace rejects it. */
  async open(filePath: string, options?: CsvDialectOptions): Promise<WorkingCsvView> {
    const result = await this.workspace.openRecentCsv(await this.sourceId(filePath), options);
    if (result.status !== 'opened') {
      throw new Error(
        result.status === 'failed' ? result.message : `CSV Source was ${result.status}.`,
      );
    }
    return result.workingCsv;
  }

  /** Writes a CSV Source and opens it as a Working CSV. */
  async openSource(
    fileName: string,
    contents: string,
    options?: CsvDialectOptions,
  ): Promise<WorkingCsvView> {
    return this.open(await this.writeSource(fileName, contents), options);
  }

  /** Points the next Export CSV at `fileName` and returns the destination path. */
  queueExportTo(fileName: string): string {
    const destinationPath = this.file(fileName);
    this.prompts.exportChoices.push(destinationPath);
    return destinationPath;
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

  async dispose(): Promise<void> {
    this.unsubscribe();
    try {
      await this.workspace.dispose();
    } finally {
      await rm(this.directory, { recursive: true, force: true });
    }
  }
}
