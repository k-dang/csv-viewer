import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopWorkspaceHost } from '../../src/main/desktop-workspace-host';
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
} from '../../../../packages/workspace/src/contracts/csv-viewer';
import type { ComparisonExecutor } from '../../../../packages/workspace/src/comparison-executor';
import { CsvWorkspaceImplementation } from '../../../../packages/workspace/src/csv-workspace-implementation';
import { DuckDbWorkspaceDatabase } from '../../src/main/duckdb-database';
import type { WorkspaceContractFixture } from '../../../../packages/workspace/test/contract/workspace-contract';
import { WorkspaceContractObserver } from '../../../../packages/workspace/test/contract/workspace-contract-observer';

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
  private readonly observer: WorkspaceContractObserver;

  private constructor(
    readonly directory: string,
    private readonly workspace: CsvWorkspaceImplementation,
    readonly host: DesktopWorkspaceHost,
    readonly prompts: ScriptedPrompts,
  ) {
    this.observer = new WorkspaceContractObserver(workspace);
  }

  get viewer(): CsvViewer {
    return this.workspace;
  }

  static async create(
    executor?: ComparisonExecutor,
  ): Promise<CsvWorkspaceFixture> {
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
          confirmDiscardChanges: async () =>
            prompts.discardChoices.shift() ?? true,
        },
        path.join(directory, 'recent-sources.json'),
      );
      workspace = new CsvWorkspaceImplementation(
        host,
        new DuckDbWorkspaceDatabase(),
        executor,
      );
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

  async registerSource(
    fileName: string,
    contents: string,
  ): Promise<CsvSourceId> {
    return this.sourceId(await this.writeSource(fileName, contents));
  }

  async removeSource(fileName: string): Promise<void> {
    await unlink(this.file(fileName));
  }

  /** Opens an existing CSV Source and fails the test when the workspace rejects it. */
  async open(
    filePath: string,
    options?: CsvDialectOptions,
  ): Promise<WorkingCsvView> {
    const result = await this.viewer.call({
      operation: 'csv.open-recent',
      sourceId: await this.sourceId(filePath),
      options,
    });
    if (result.status !== 'opened') {
      throw new Error(
        result.status === 'failed'
          ? result.message
          : `CSV Source was ${result.status}.`,
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

  captureNextExport(fileName: string): () => Promise<string> {
    const destinationPath = this.file(fileName);
    this.prompts.exportChoices.push(destinationPath);
    return () => readFile(destinationPath, 'utf8');
  }

  editState(workingCsvId: WorkingCsvId): Promise<CsvEditState> {
    return this.viewer.call({ operation: 'csv.get-edit-state', workingCsvId });
  }

  latestComparison(comparisonId: ComparisonId): ComparisonView | null {
    return this.observer.latestComparison(comparisonId);
  }

  confirmClose(
    confirmedImpact?: WorkspaceCloseImpact,
  ): Promise<ConfirmWorkspaceCloseOutcome> {
    return this.workspace.confirmClose(confirmedImpact);
  }

  disposeWorkspace(): Promise<void> {
    return this.workspace.dispose();
  }

  awaitComparisonOutcome(
    operationId: ComparisonOperationId,
  ): Promise<ComparisonAttemptOutcomeView> {
    return this.observer.awaitComparisonOutcome(operationId);
  }

  async dispose(): Promise<void> {
    this.observer.dispose();
    try {
      await this.workspace.dispose();
    } finally {
      await rm(this.directory, { recursive: true, force: true });
    }
  }
}
